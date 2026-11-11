// Long-term memory across sessions (IndexedDB + embeddings, lexical fallback).
//
// Draft and notebook are short-term memory: they live only while a reply is
// being made. What lasts is kept here, as short memories of three kinds:
//   said         something the brain said. The latest reply is kept word for
//                word (so a follow-up can refer to it); when the next reply
//                replaces it, it fades to its gist.
//   believe      something the brain now holds true
//   interesting  something it found interesting, and why
// Every memory has a weight (0..1): it rises when the memory proves useful,
// falls when it comes to mind for nothing, and fades a little every session.
// Capacity is limited: the weakest are forgotten first.
//
// Memories are linked on purpose, not by time alone (when they happened is
// stored anyway): an exchange that followed up on an earlier one "follows" it,
// so a conversation forms a thread; a belief or interest points to the exchange
// it "came from". Using a memory strengthens its neighbours a little, and
// forgetting keeps a thread in order.
//
// Core beliefs (who the brain is: its name, its character) are pinned: they
// never fade and are never forgotten. They can change, but only after the
// brain has reconsidered (see Brain.reconsider): each challenge is recorded
// as a doubt, and a change needs both a convinced deliberation and doubts
// raised in more than one session.

import type { Doubt, MemoryRow, Store } from "../store";

export type Embedder = (text: string) => Promise<number[] | null>;
export type MemoryKind = "said" | "believe" | "interesting";
export const KINDS: MemoryKind[] = ["said", "believe", "interesting"];

export const CAPACITY = 60;        // memories kept at most
export const DECAY = 0.97;         // every session, every weight fades a little
export const PROTECT_SESSIONS = 3; // a new memory can't be forgotten for this many sessions
export const FADED = 0.05;         // below this weight a memory is gone
export const MAX_TEXT = 300;       // a memory is short (the verbatim last reply excepted)
export const MAX_VERBATIM = 2000;
export const JUDGE_DELTA = { unrelated: -0.05, reminds: 0.1, related: 0.25 } as const;
export const REINFORCE = 0.15;     // a new suggestion that repeats a memory strengthens it
export const SAME = 0.9;           // similarity at which two texts count as the same memory
export const NEIGHBOUR = 0.05;     // what using a memory gives the memories linked to it
export const THREAD_DEPTH = 2;     // earlier exchanges a follow-up pulls in
export const DOUBT_SESSIONS = 2;   // sessions a core belief must have been questioned in before it can change

export type Judgement = keyof typeof JUDGE_DELTA;

export interface Memory {
  id: number;
  kind: MemoryKind;
  text: string;
  weight: number;
  age: number;          // sessions since it was laid down
  uses: number;         // times it proved useful
  created: number;
  used: number | null;
  session: string | null;
  from: string[];       // who suggested it
  verbatim: boolean;    // the latest reply, word for word
  question: string;     // for "said": what was asked
  gist: string;         // for the verbatim reply: what it fades to
  follows: number | null;
  origin: number | null;
  context: string;      // for beliefs and interests: what was asked when it came up
  pinned: boolean;
  seeded: string;       // for a core belief: the starting text it was given (stays when it changes)
  doubts: Doubt[];
  embedding: number[] | null;
}

export function cos(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) dot += a[i] * b[i];
  for (const x of a) na += x * x;
  for (const y of b) nb += y * y;
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

function words(t: string): Set<string> {
  return new Set((t.toLowerCase().match(/[a-zA-ZäöüÄÖÜß0-9]+/g) ?? []).filter((w) => w.length > 3));
}

/** 0..1, by embeddings when both have comparable vectors, else by shared words. */
export function similarity(a: { text: string; embedding: number[] | null }, b: { text: string; embedding: number[] | null }): number {
  if (a.embedding && b.embedding && a.embedding.length === b.embedding.length) return cos(a.embedding, b.embedding);
  const wa = words(a.text), wb = words(b.text);
  const inter = [...wa].filter((x) => wb.has(x)).length;
  const union = new Set([...wa, ...wb]).size;
  return Math.min(1, (inter / Math.max(1, union)) * 2.5);
}

const clamp = (w: number) => Math.max(0, Math.min(1, w));
const now = () => Date.now() / 1000;

/** Rows from before weights and kinds existed become weak beliefs. */
export function normalise(r: MemoryRow): Memory {
  const kind = KINDS.includes(r.kind as MemoryKind) ? (r.kind as MemoryKind) : "believe";
  return {
    id: r.id!, kind, text: String(r.text ?? ""), weight: typeof r.weight === "number" ? clamp(r.weight) : 0.3,
    age: r.age ?? PROTECT_SESSIONS, uses: r.uses ?? 0, created: r.created ?? now(), used: r.used ?? null,
    session: r.session ?? null, from: r.from ?? [], verbatim: !!r.verbatim, question: r.question ?? "",
    gist: r.gist ?? "", follows: r.follows ?? null, origin: r.origin ?? null, context: r.context ?? "",
    pinned: !!r.pinned, seeded: r.seeded ?? (r.pinned ? String(r.text ?? "") : ""),
    doubts: r.doubts ?? [], embedding: r.embedding ?? null,
  };
}

export class LongTermMemory {
  constructor(private db: Store, public embed: Embedder | null = null, public owner = "Recall") {}

  async all(): Promise<Memory[]> {
    return (await this.db.getAll("memories")).map(normalise);
  }

  count(): Promise<number> {
    return this.db.count("memories");
  }

  async vector(text: string): Promise<number[] | null> {
    try {
      return this.embed ? await this.embed(text) : null;
    } catch {
      return null; // no embedding: the lexical fallback still works
    }
  }

  private async put(m: Memory): Promise<void> {
    await this.db.put("memories", m as MemoryRow);
  }

  /** A new session begins: every memory fades a little and grows a session older. */
  async age(): Promise<void> {
    const tx = this.db.transaction("memories", "readwrite");
    for (const r of await tx.store.getAll()) {
      const m = normalise(r);
      await tx.store.put({ ...m, weight: m.pinned ? m.weight : m.weight * DECAY, age: m.age + 1 } as MemoryRow);
    }
    await tx.done;
  }

  /** What may come to mind: the latest reply (follow-ups rarely sound like what
   * they follow up) plus the k memories that best fit the matter, by similarity
   * and weight. */
  async candidates(question: string, k = 5, floor = 0.3): Promise<Memory[]> {
    const all = await this.all();
    const last = all.find((m) => m.verbatim) ?? null;
    const q = { text: question, embedding: await this.vector(question) };
    // core beliefs aren't recalled: the voices that speak for the brain always have them
    const scored = all.filter((m) => !m.verbatim && !m.pinned)
      .map((m) => [similarity(q, m), m] as const)
      .filter(([s]) => s >= floor)
      .sort((a, b) => b[0] * 0.7 + b[1].weight * 0.3 - (a[0] * 0.7 + a[1].weight * 0.3))
      .slice(0, k)
      .map(([, m]) => m);
    return last ? [last, ...scored] : scored;
  }

  /** The Listener's verdict on what came to mind. */
  async judge(id: number, j: Judgement): Promise<Memory | null> {
    const r = await this.db.get("memories", id);
    if (!r) return null;
    const m = normalise(r);
    if (!m.pinned) m.weight = clamp(m.weight + JUDGE_DELTA[j]);
    if (j !== "unrelated") {
      m.uses++;
      m.used = now();
    }
    await this.put(m);
    if (j === "related") await this.nudgeNeighbours(m);
    return m;
  }

  /** The memories linked to m, either way. */
  async neighbours(m: Memory): Promise<Memory[]> {
    return (await this.all()).filter((x) => x.id !== m.id &&
      (x.id === m.follows || x.id === m.origin || x.follows === m.id || x.origin === m.id));
  }

  private async nudgeNeighbours(m: Memory, by = NEIGHBOUR): Promise<void> {
    for (const n of await this.neighbours(m)) await this.put({ ...n, weight: clamp(n.weight + by) });
  }

  /** The exchanges m followed up on, oldest first (at most depth of them). */
  async thread(m: Memory, depth = THREAD_DEPTH): Promise<Memory[]> {
    const all = new Map((await this.all()).map((x) => [x.id, x]));
    const out: Memory[] = [];
    let at = m.follows !== null ? all.get(m.follows) : undefined;
    while (at && out.length < depth && !out.includes(at)) {
      out.unshift(at);
      at = at.follows !== null ? all.get(at.follows) : undefined;
    }
    return out;
  }

  /** An existing memory this text repeats, if any. */
  async findSame(text: string, embedding: number[] | null): Promise<Memory | null> {
    let best: [number, Memory] | null = null;
    for (const m of await this.all()) {
      if (m.verbatim || m.pinned) continue;
      const s = similarity({ text, embedding }, m);
      if (s >= SAME && (!best || s > best[0])) best = [s, m];
    }
    return best ? best[1] : null;
  }

  async reinforce(id: number, by = REINFORCE): Promise<Memory | null> {
    const r = await this.db.get("memories", id);
    if (!r) return null;
    const m = normalise(r);
    m.weight = clamp(m.weight + by);
    m.uses++;
    m.used = now();
    await this.put(m);
    await this.nudgeNeighbours(m);
    return m;
  }

  /** Lay down a memory. Only the owner (Recall) writes long-term memory. */
  async store(who: string, kind: MemoryKind, text: string,
              opts: { weight?: number; session?: string | null; from?: string[]; embedding?: number[] | null;
                      origin?: number | null; context?: string; pinned?: boolean; seeded?: string } = {}): Promise<Memory | null> {
    if (who !== this.owner) throw new Error(`${who} may not write long-term memory (owner: ${this.owner})`);
    text = text.trim().slice(0, MAX_TEXT);
    if (!text) return null;
    const row = {
      kind, text, weight: clamp(opts.weight ?? 0.5), age: 0, uses: 0, created: now(), used: null,
      session: opts.session ?? null, from: opts.from ?? [], verbatim: false, question: "", gist: "",
      follows: null, origin: opts.origin ?? null, context: (opts.context ?? "").slice(0, 300),
      pinned: !!opts.pinned, seeded: opts.seeded ?? "", doubts: [] as Doubt[],
      embedding: opts.embedding !== undefined ? opts.embedding : await this.vector(text),
    };
    const id = (await this.db.add("memories", row as MemoryRow)) as number;
    return { ...row, id };
  }

  /** The exchange just completed becomes the verbatim "said" memory (what was
   * asked and the reply, word for word); the previous one fades to the question
   * and the gist of its reply. follows: the exchange this one followed up on. */
  async said(who: string, reply: string, question: string, gist: string, session: string | null,
             follows: number | null = null): Promise<Memory> {
    if (who !== this.owner) throw new Error(`${who} may not write long-term memory (owner: ${this.owner})`);
    for (const m of (await this.all()).filter((x) => x.verbatim)) {
      const text = (m.gist || m.text).slice(0, MAX_TEXT);
      await this.put({ ...m, verbatim: false, text, gist: "", embedding: await this.vector(`${m.question}\n${text}`) });
    }
    const g = (gist.trim() || reply.trim()).slice(0, MAX_TEXT);
    const row = {
      kind: "said" as const, text: reply.trim().slice(0, MAX_VERBATIM), weight: 0.6, age: 0, uses: 0, created: now(),
      used: null, session, from: [], verbatim: true, question: question.slice(0, 300), gist: g,
      follows, origin: null, context: "", pinned: false, seeded: "", doubts: [] as Doubt[],
      embedding: await this.vector(`${question}\n${g}`),
    };
    const id = (await this.db.add("memories", row as MemoryRow)) as number;
    return { ...row, id };
  }

  /** The core beliefs: who the brain is. */
  async core(): Promise<Memory[]> {
    return (await this.all()).filter((m) => m.pinned).sort((a, b) => a.id - b.id);
  }

  /** A fresh brain is given its starting core beliefs; a brain from before a
   * belief was added to the starting set gets that one too. A belief the brain
   * has since changed counts as given (it isn't handed back in its old form). */
  async seed(beliefs: string[]): Promise<number> {
    const given = new Set((await this.core()).map((m) => m.seeded || m.text));
    let added = 0;
    for (const b of beliefs) {
      if (given.has(b)) continue;
      await this.store(this.owner, "believe", b, { weight: 1, pinned: true, seeded: b });
      given.add(b);
      added++;
    }
    return added;
  }

  /** Record that a core belief was questioned. Returns the belief with all its doubts. */
  async doubt(id: number, d: Doubt): Promise<Memory | null> {
    const r = await this.db.get("memories", id);
    if (!r) return null;
    const m = normalise(r);
    m.doubts = [...m.doubts, { ...d, text: d.text.slice(0, 300), question: d.question.slice(0, 300) }].slice(-10);
    await this.put(m);
    return m;
  }

  /** Sessions a core belief has been questioned in. */
  static doubtSessions(m: Memory): number {
    return new Set(m.doubts.map((d) => d.session ?? String(d.ts))).size;
  }

  /** After reconsidering: a core belief is changed (it stays pinned; its doubts are settled). */
  async changeCore(who: string, id: number, text: string): Promise<Memory | null> {
    if (who !== this.owner) throw new Error(`${who} may not write long-term memory (owner: ${this.owner})`);
    const r = await this.db.get("memories", id);
    if (!r) return null;
    const m = normalise(r);
    const changed = { ...m, text: text.trim().slice(0, MAX_TEXT), doubts: [], used: now(), embedding: await this.vector(text) };
    await this.put(changed);
    return changed;
  }

  /** Replace a memory (e.g. a belief that turned out wrong). */
  async remove(id: number): Promise<void> {
    await this.db.delete("memories", id);
  }

  /** Forget what has faded, then the weakest until capacity is kept. Memories
   * younger than PROTECT_SESSIONS and the verbatim reply are safe. */
  async forget(capacity = CAPACITY): Promise<Memory[]> {
    const all = await this.all();
    const safe = (m: Memory) => m.pinned || m.verbatim || m.age < PROTECT_SESSIONS;
    const gone = all.filter((m) => !safe(m) && m.weight < FADED);
    const evictable = all.filter((m) => !safe(m) && !gone.includes(m))
      .sort((a, b) => a.weight - b.weight || a.created - b.created);
    while (all.length - gone.length > capacity && evictable.length) gone.push(evictable.shift()!);
    const goneIds = new Map(gone.map((m) => [m.id, m]));
    // a thread closes over a forgotten exchange: A → B → C without B becomes A → C
    const skip = (id: number | null): number | null => {
      while (id !== null && goneIds.has(id)) id = goneIds.get(id)!.follows;
      return id;
    };
    for (const m of all) {
      if (goneIds.has(m.id)) continue;
      const follows = skip(m.follows);
      const lost = m.origin !== null && goneIds.has(m.origin) ? goneIds.get(m.origin)! : null;
      if (follows !== m.follows || lost) {
        await this.put({ ...m, follows, origin: lost ? null : m.origin, context: lost ? m.context || lost.question : m.context });
      }
    }
    for (const m of gone) await this.db.delete("memories", m.id);
    return gone;
  }
}
