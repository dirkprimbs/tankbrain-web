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

import type { MemoryRow, Store } from "../store";

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
  question: string;     // for "said": what it was the reply to
  gist: string;         // for the verbatim reply: what it fades to
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
    gist: r.gist ?? "", embedding: r.embedding ?? null,
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
      await tx.store.put({ ...m, weight: m.weight * DECAY, age: m.age + 1 } as MemoryRow);
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
    const scored = all.filter((m) => !m.verbatim)
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
    m.weight = clamp(m.weight + JUDGE_DELTA[j]);
    if (j !== "unrelated") {
      m.uses++;
      m.used = now();
    }
    await this.put(m);
    return m;
  }

  /** An existing memory this text repeats, if any. */
  async findSame(text: string, embedding: number[] | null): Promise<Memory | null> {
    let best: [number, Memory] | null = null;
    for (const m of await this.all()) {
      if (m.verbatim) continue;
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
    return m;
  }

  /** Lay down a memory. Only the owner (Recall) writes long-term memory. */
  async store(who: string, kind: MemoryKind, text: string,
              opts: { weight?: number; session?: string | null; from?: string[]; embedding?: number[] | null } = {}): Promise<Memory | null> {
    if (who !== this.owner) throw new Error(`${who} may not write long-term memory (owner: ${this.owner})`);
    text = text.trim().slice(0, MAX_TEXT);
    if (!text) return null;
    const row = {
      kind, text, weight: clamp(opts.weight ?? 0.5), age: 0, uses: 0, created: now(), used: null,
      session: opts.session ?? null, from: opts.from ?? [], verbatim: false, question: "", gist: "",
      embedding: opts.embedding !== undefined ? opts.embedding : await this.vector(text),
    };
    const id = (await this.db.add("memories", row as MemoryRow)) as number;
    return { ...row, id };
  }

  /** The reply just given becomes the verbatim "said" memory; the previous one fades to its gist. */
  async said(who: string, reply: string, question: string, gist: string, session: string | null): Promise<Memory> {
    if (who !== this.owner) throw new Error(`${who} may not write long-term memory (owner: ${this.owner})`);
    for (const m of (await this.all()).filter((x) => x.verbatim)) {
      const text = (m.gist || m.text).slice(0, MAX_TEXT);
      await this.put({ ...m, verbatim: false, text, gist: "", embedding: await this.vector(text) });
    }
    const g = (gist.trim() || reply.trim()).slice(0, MAX_TEXT);
    const row = {
      kind: "said" as const, text: reply.trim().slice(0, MAX_VERBATIM), weight: 0.6, age: 0, uses: 0, created: now(),
      used: null, session, from: [], verbatim: true, question: question.slice(0, 300), gist: g,
      embedding: await this.vector(`${question}\n${g}`),
    };
    const id = (await this.db.add("memories", row as MemoryRow)) as number;
    return { ...row, id };
  }

  /** Replace a memory (e.g. a belief that turned out wrong). */
  async remove(id: number): Promise<void> {
    await this.db.delete("memories", id);
  }

  /** Forget what has faded, then the weakest until capacity is kept. Memories
   * younger than PROTECT_SESSIONS and the verbatim reply are safe. */
  async forget(capacity = CAPACITY): Promise<Memory[]> {
    const all = await this.all();
    const safe = (m: Memory) => m.verbatim || m.age < PROTECT_SESSIONS;
    const gone = all.filter((m) => !safe(m) && m.weight < FADED);
    const evictable = all.filter((m) => !safe(m) && !gone.includes(m))
      .sort((a, b) => a.weight - b.weight || a.created - b.created);
    while (all.length - gone.length > capacity && evictable.length) gone.push(evictable.shift()!);
    for (const m of gone) await this.db.delete("memories", m.id);
    return gone;
  }
}
