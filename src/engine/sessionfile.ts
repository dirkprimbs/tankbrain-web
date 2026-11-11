// Sessions as portable files: export one from this browser, import it into
// another, and ship a few with the page as demos (public/demos/), so the app
// can be shown without any key.
//
// A session file is a recording, for replaying: it carries no memories, and
// importing one (older files did carry memories) never changes what the brain
// remembers. To move the brain itself, use the state file (statefile.ts).

import type { EventRow, MemoryRow, SessionRow, Store } from "./store";

export const FORMAT = "tankbrain-session";

export interface SessionFile {
  format: typeof FORMAT;
  version: 1;
  session: SessionRow;
  events: EventRow[];
  audio: { key: string; type: string; data: string }[]; // base64
  memories?: Omit<MemoryRow, "id">[]; // older files only; ignored on import
}

export async function toBase64(b: Blob): Promise<string> {
  const bytes = new Uint8Array(await b.arrayBuffer());
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(data: string, type: string): Blob {
  return new Blob([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], { type });
}

export async function exportSession(db: Store, id: string): Promise<SessionFile> {
  const session = await db.get("sessions", id);
  if (!session) throw new Error("unknown session");
  const events = (await db.getAllFromIndex("events", "session", id)).sort((a, b) => a.seq - b.seq);
  const audio = await Promise.all((await db.getAllFromIndex("audio", "session", id))
    .map(async (a) => ({ key: a.key, type: a.wav.type || "audio/wav", data: await toBase64(a.wav) })));
  return { format: FORMAT, version: 1, session, events, audio };
}

/** Add a session file to this browser. Returns false if that session is already here. */
export async function importSession(db: Store, file: SessionFile, label?: string): Promise<boolean> {
  if (file?.format !== FORMAT || !file.session?.id || !Array.isArray(file.events)) throw new Error("not a Tankbrain session file");
  const id = file.session.id;
  if (!/^[a-zA-Z0-9_-]{1,40}$/.test(id)) throw new Error("bad session id in file");
  if (await db.get("sessions", id)) return false;
  const tx = db.transaction(["sessions", "events", "audio"], "readwrite");
  // a running session in a file is a finished recording here
  const status = file.session.status === "running" ? "interrupted" : file.session.status;
  await tx.objectStore("sessions").put({ ...file.session, status, profile: label ?? file.session.profile });
  for (const e of file.events) await tx.objectStore("events").put({ ...e, session: id });
  for (const a of file.audio ?? []) {
    if (!a.key.startsWith(`${id}/`)) continue; // a file only brings its own audio
    await tx.objectStore("audio").put({ key: a.key, session: id, wav: fromBase64(a.data, a.type) });
  }
  await tx.done;
  return true;
}

/** Older versions imported a demo's memories along with it; a recording isn't
 * something this brain experienced, so those memories go. */
export async function forgetDemoMemories(db: Store): Promise<number> {
  const demos = new Set((await db.getAll("sessions")).filter((s) => s.profile.startsWith("demo")).map((s) => s.id));
  let n = 0;
  for (const m of await db.getAll("memories")) {
    if (m.session && demos.has(m.session)) {
      await db.delete("memories", m.id!);
      n++;
    }
  }
  return n;
}

/** The demo sessions listed in public/demos/index.json, imported once (and again after "forget everything"). */
export async function importDemos(db: Store, base = "demos/"): Promise<number> {
  let list: { files: string[] };
  try {
    const r = await fetch(`${base}index.json`, { cache: "no-cache" });
    if (!r.ok) return 0;
    list = await r.json();
  } catch {
    return 0; // no demos shipped
  }
  let added = 0;
  for (const name of list.files ?? []) {
    if (!/^[\w.-]+\.json$/.test(name)) continue;
    try {
      const file = await (await fetch(base + name)).json();
      if (await importSession(db, file, `demo · ${file.session?.profile ?? ""}`.trim())) added++;
    } catch (e) {
      console.warn(`demo ${name} not loaded`, e);
    }
  }
  return added;
}
