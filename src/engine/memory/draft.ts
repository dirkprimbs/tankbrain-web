// Short-term memory: the versioned draft. One writer only.
//
// After the first version the draft is changed by *edits* (find a passage,
// replace it), so every change is small and traceable. A full rewrite is still
// possible but is recorded as such.

import { SequenceMatcher } from "../difflib";
import { MemoryPermissionError } from "./working";

export const MAX_EDITS = 8;

/** A bracketed stand-in such as "[empty]", "<answer here>" or "[...]": small
 * models sometimes write one instead of an answer. */
const PLACEHOLDER = /[\[<{]\s*(empty|blank|placeholder|todo|tbd|insert\b[^\]>}]*|(your |the )?answer( here)?|\.{3}|…)\s*[\]>}]/i;

/** True if the text is no answer at all: no words, or a placeholder in it. */
export function isPlaceholder(text: string): boolean {
  return !/[\p{L}\p{N}]/u.test(text) || PLACEHOLDER.test(text);
}

export interface Edit { find: string; replace: string; why?: string }

export interface Version {
  text: string;
  mode: "initial" | "edit" | "rewrite";
  applied: Edit[];
  failed: Edit[];
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isSpace = (c: string) => /\s/.test(c);

/** Find `find` in `text`: exact, then whitespace/case-insensitive, then fuzzy
 * (best window of similar length with similarity >= 0.8). */
export function locate(text: string, find: string): [number, number] | null {
  if (!find.trim()) return null;
  const i = text.indexOf(find);
  if (i >= 0) return [i, i + find.length];
  const words = find.split(/\s+/).filter(Boolean);
  const m = new RegExp(words.map(escape).join("\\s+"), "i").exec(text);
  if (m) return [m.index, m.index + m[0].length];
  // fuzzy: compare against windows that start/end on word boundaries
  const target = norm(find);
  const starts = [0];
  for (const w of text.matchAll(/\s+/g)) starts.push(w.index! + w[0].length);
  let best = 0;
  let bestSpan: [number, number] | null = null;
  const n = find.length;
  for (const s of starts) {
    for (let e of [s + Math.floor(n * 0.8), s + n, s + Math.floor(n * 1.2)]) {
      e = Math.min(text.length, e);
      while (e < text.length && !isSpace(text[e])) e++; // extend to the end of a word
      const cand = text.slice(s, e);
      if (!cand.trim()) continue;
      const sm = new SequenceMatcher(target, norm(cand));
      if (sm.realQuickRatio() < 0.8 || sm.quickRatio() < 0.8) continue;
      const r = sm.ratio();
      if (r > best) {
        best = r;
        bestSpan = [s, e];
      }
    }
  }
  return best >= 0.8 ? bestSpan : null;
}

export function applyEdits(text: string, edits: Edit[]): [string, Edit[], Edit[]] {
  const applied: Edit[] = [];
  const failed: Edit[] = [];
  for (const e of edits.slice(0, MAX_EDITS)) {
    const find = String(e.find ?? "");
    const repl = String(e.replace ?? "");
    // "Sunlight travels..." as a replacement would silently cut the text
    if (["...", "…"].some((mark) => repl.includes(mark) && !find.includes(mark))) {
      failed.push({ find, replace: repl, why: "replacement abbreviated with '...'" });
      continue;
    }
    const span = locate(text, find);
    if (!span) {
      failed.push({ find, replace: repl, why: "passage not found" });
      continue;
    }
    const [s, t] = span;
    const old = text.slice(s, t);
    text = text.slice(0, s) + repl + text.slice(t);
    applied.push({ find: old, replace: repl });
  }
  return [text.replace(/[ \t]+\n/g, "\n").trim(), applied, failed];
}

/** [[op, text], ...] with op in '=', '+', '-' (word-level, keeps whitespace). */
export function wordDiff(a: string, b: string): [string, string][] {
  const ta = a.match(/\s+|\S+/g) ?? [];
  const tb = b.match(/\s+|\S+/g) ?? [];
  const out: [string, string][] = [];
  for (const [tag, i1, i2, j1, j2] of new SequenceMatcher(ta, tb, false).getOpcodes()) {
    if (tag === "equal") out.push(["=", ta.slice(i1, i2).join("")]);
    else {
      if (i2 > i1) out.push(["-", ta.slice(i1, i2).join("")]);
      if (j2 > j1) out.push(["+", tb.slice(j1, j2).join("")]);
    }
  }
  return out;
}

export class Draft {
  history: Version[] = [];
  constructor(public owner: string) {}

  private check(who: string) {
    if (who !== this.owner) throw new MemoryPermissionError(`${who} may not write the draft (owner: ${this.owner})`);
  }

  /** Write a complete version (the first one, or a full rewrite). */
  write(who: string, text: string): number | null {
    this.check(who);
    text = text.trim();
    // a "draft" with no words in it ("...", "[]") or a stand-in ("[empty]") is a placeholder, not a version
    if (isPlaceholder(text) || text === this.current) return null;
    this.history.push({ text, mode: this.history.length ? "rewrite" : "initial", applied: [], failed: [] });
    return this.version;
  }

  /** Apply edits to the current version. Returns [new version or null, failed edits]. */
  edit(who: string, edits: Edit[]): [number | null, Edit[]] {
    this.check(who);
    if (!this.history.length) return [null, [...edits]];
    const [text, applied, failed] = applyEdits(this.current, edits);
    if (!applied.length || text === this.current) return [null, failed];
    this.history.push({ text, mode: "edit", applied, failed });
    return [this.version, failed];
  }

  get versions(): string[] {
    return this.history.map((v) => v.text);
  }

  get current(): string {
    return this.history.length ? this.history[this.history.length - 1].text : "";
  }

  get version(): number {
    return this.history.length;
  }

  last() {
    const v = this.history[this.history.length - 1];
    const prev = this.history.length > 1 ? this.history[this.history.length - 2].text : "";
    return { version: this.version, text: v.text, mode: v.mode, applied: v.applied, failed: v.failed,
             diff: wordDiff(prev, v.text) };
  }

  render(): string {
    return this.history.length ? `(version ${this.version})\n${this.current}` : "(no draft yet)";
  }
}
