// The whole state of this brain as one file: sessions (with their events and
// spoken audio), long-term memories, saved voice profiles and the settings.
// Importing a state file replaces everything here with it. The OpenRouter key
// is never part of it.

import { fromBase64, toBase64 } from "./sessionfile";
import type { EventRow, MemoryRow, ProfileRow, SessionRow, Store } from "./store";

export const STATE_FORMAT = "tankbrain-state";
const STORES = ["sessions", "events", "memories", "profiles", "audio"] as const;

export interface StateFile {
  format: typeof STATE_FORMAT;
  version: 1;
  exported: number;
  sessions: SessionRow[];
  events: EventRow[];
  audio: { key: string; session: string; type: string; data: string }[]; // base64
  memories: MemoryRow[];
  profiles: ProfileRow[];
  settings: Record<string, string>;
}

export async function exportState(db: Store, settings: Record<string, string>): Promise<StateFile> {
  const audio = await Promise.all((await db.getAll("audio"))
    .map(async (a) => ({ key: a.key, session: a.session, type: a.wav.type || "audio/wav", data: await toBase64(a.wav) })));
  return {
    format: STATE_FORMAT, version: 1, exported: Date.now() / 1000,
    sessions: await db.getAll("sessions"), events: await db.getAll("events"), audio,
    memories: await db.getAll("memories"), profiles: await db.getAll("profiles"), settings,
  };
}

export function isStateFile(x: any): x is StateFile {
  return x?.format === STATE_FORMAT && Array.isArray(x.sessions) && Array.isArray(x.events) && Array.isArray(x.memories);
}

/** Replace everything in this browser with the file's state (in one transaction:
 * a broken file leaves the current state as it was). Returns what came in. */
export async function importState(db: Store, file: StateFile) {
  if (!isStateFile(file)) throw new Error("not a state file of Norbert, the brain");
  const tx = db.transaction([...STORES], "readwrite");
  await Promise.all(STORES.map((s) => tx.objectStore(s).clear()));
  for (const s of file.sessions) await tx.objectStore("sessions").put(s.status === "running" ? { ...s, status: "interrupted" } : s);
  for (const e of file.events) await tx.objectStore("events").put(e);
  for (const a of file.audio ?? []) await tx.objectStore("audio").put({ key: a.key, session: a.session, wav: fromBase64(a.data, a.type) });
  for (const m of file.memories) await tx.objectStore("memories").put(m);
  for (const p of file.profiles ?? []) await tx.objectStore("profiles").put(p);
  await tx.done;
  return { sessions: file.sessions.length, memories: file.memories.length, profiles: (file.profiles ?? []).length };
}
