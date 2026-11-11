// Long-term memory across sessions: IndexedDB + embeddings (lexical fallback).

import type { Store } from "../store";

export type Embedder = (text: string) => Promise<number[] | null>;

function cos(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) dot += a[i] * b[i];
  for (const x of a) na += x * x;
  for (const y of b) nb += y * y;
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

function words(t: string): Set<string> {
  return new Set((t.toLowerCase().match(/[a-zA-ZäöüÄÖÜß0-9]+/g) ?? []).filter((w) => w.length > 3));
}

export class LongTermMemory {
  constructor(private db: Store, public embed: Embedder | null = null, public owner = "Recall") {}

  async store(who: string, text: string, session: string | null = null): Promise<void> {
    if (who !== this.owner) throw new Error(`${who} may not write long-term memory (owner: ${this.owner})`);
    text = text.trim();
    if (!text) return;
    const vec = this.embed ? await this.embed(text) : null;
    await this.db.add("memories", { session, created: Date.now() / 1000, text, embedding: vec });
  }

  async search(query: string, k = 5, minScore = 0.55): Promise<[number, string][]> {
    const rows = await this.db.getAll("memories");
    if (!rows.length) return [];
    const qvec = this.embed ? await this.embed(query) : null;
    const qwords = words(query);
    const scored: [number, string][] = [];
    for (const r of rows) {
      let s: number;
      // vectors from a different embedding model can't be compared
      if (qvec && r.embedding && r.embedding.length === qvec.length) s = cos(qvec, r.embedding);
      else {
        const w = words(r.text);
        const inter = [...w].filter((x) => qwords.has(x)).length;
        const union = new Set([...w, ...qwords]).size;
        s = (inter / Math.max(1, union)) * 2.5;
      }
      if (s >= minScore) scored.push([s, r.text]);
    }
    scored.sort((a, b) => b[0] - a[0] || (a[1] < b[1] ? 1 : -1));
    return scored.slice(0, k);
  }

  count(): Promise<number> {
    return this.db.count("memories");
  }
}
