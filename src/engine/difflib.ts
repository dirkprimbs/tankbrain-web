// A faithful port of the parts of Python's difflib.SequenceMatcher the brain
// uses (ratio, quick_ratio, real_quick_ratio, get_opcodes), including its
// "autojunk" heuristic, so echo detection and fuzzy edit matching behave
// exactly like the original Python version.

export type Opcode = ["equal" | "replace" | "delete" | "insert", number, number, number, number];

export class SequenceMatcher<T extends string | string[]> {
  private a: ArrayLike<string>;
  private b: ArrayLike<string>;
  private b2j = new Map<string, number[]>();
  private bpopular = new Set<string>();
  private fullbcount: Map<string, number> | null = null;
  private matchingBlocks: [number, number, number][] | null = null;
  private opcodes: Opcode[] | null = null;

  constructor(a: T, b: T, private autojunk = true) {
    this.a = a;
    this.b = b;
    this.chainB();
  }

  private chainB() {
    const b = this.b;
    const b2j = this.b2j;
    for (let i = 0; i < b.length; i++) {
      const elt = b[i];
      let idx = b2j.get(elt);
      if (!idx) b2j.set(elt, (idx = []));
      idx.push(i);
    }
    const n = b.length;
    if (this.autojunk && n >= 200) {
      const ntest = Math.floor(n / 100) + 1;
      for (const [elt, idxs] of b2j) {
        if (idxs.length > ntest) this.bpopular.add(elt);
      }
      for (const elt of this.bpopular) b2j.delete(elt);
    }
  }

  findLongestMatch(alo: number, ahi: number, blo: number, bhi: number): [number, number, number] {
    const { a, b, b2j } = this;
    let besti = alo, bestj = blo, bestsize = 0;
    let j2len = new Map<number, number>();
    for (let i = alo; i < ahi; i++) {
      const newj2len = new Map<number, number>();
      const idxs = b2j.get(a[i]);
      if (idxs) {
        for (const j of idxs) {
          if (j < blo) continue;
          if (j >= bhi) break;
          const k = (j2len.get(j - 1) ?? 0) + 1;
          newj2len.set(j, k);
          if (k > bestsize) {
            besti = i - k + 1;
            bestj = j - k + 1;
            bestsize = k;
          }
        }
      }
      j2len = newj2len;
    }
    // Python (no isjunk function): extend the match with any equal neighbours,
    // popular elements included; its "junk" loops never fire.
    while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) {
      besti--; bestj--; bestsize++;
    }
    while (besti + bestsize < ahi && bestj + bestsize < bhi && a[besti + bestsize] === b[bestj + bestsize]) bestsize++;
    return [besti, bestj, bestsize];
  }

  getMatchingBlocks(): [number, number, number][] {
    if (this.matchingBlocks) return this.matchingBlocks;
    const la = this.a.length, lb = this.b.length;
    const queue: [number, number, number, number][] = [[0, la, 0, lb]];
    const blocks: [number, number, number][] = [];
    while (queue.length) {
      const [alo, ahi, blo, bhi] = queue.pop()!;
      const x = this.findLongestMatch(alo, ahi, blo, bhi);
      const [i, j, k] = x;
      if (k) {
        blocks.push(x);
        if (alo < i && blo < j) queue.push([alo, i, blo, j]);
        if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
      }
    }
    blocks.sort((p, q) => p[0] - q[0] || p[1] - q[1] || p[2] - q[2]);
    // collapse adjacent blocks
    let i1 = 0, j1 = 0, k1 = 0;
    const out: [number, number, number][] = [];
    for (const [i2, j2, k2] of blocks) {
      if (i1 + k1 === i2 && j1 + k1 === j2) k1 += k2;
      else {
        if (k1) out.push([i1, j1, k1]);
        i1 = i2; j1 = j2; k1 = k2;
      }
    }
    if (k1) out.push([i1, j1, k1]);
    out.push([la, lb, 0]);
    return (this.matchingBlocks = out);
  }

  getOpcodes(): Opcode[] {
    if (this.opcodes) return this.opcodes;
    let i = 0, j = 0;
    const ops: Opcode[] = [];
    for (const [ai, bj, size] of this.getMatchingBlocks()) {
      let tag: Opcode[0] | "" = "";
      if (i < ai && j < bj) tag = "replace";
      else if (i < ai) tag = "delete";
      else if (j < bj) tag = "insert";
      if (tag) ops.push([tag, i, ai, j, bj]);
      i = ai + size;
      j = bj + size;
      if (size) ops.push(["equal", ai, i, bj, j]);
    }
    return (this.opcodes = ops);
  }

  ratio(): number {
    const matches = this.getMatchingBlocks().reduce((s, m) => s + m[2], 0);
    return calc(matches, this.a.length + this.b.length);
  }

  quickRatio(): number {
    if (!this.fullbcount) {
      this.fullbcount = new Map();
      for (let i = 0; i < this.b.length; i++) {
        const e = this.b[i];
        this.fullbcount.set(e, (this.fullbcount.get(e) ?? 0) + 1);
      }
    }
    const avail = new Map<string, number>();
    let matches = 0;
    for (let i = 0; i < this.a.length; i++) {
      const e = this.a[i];
      const n = avail.has(e) ? avail.get(e)! : (this.fullbcount.get(e) ?? 0);
      avail.set(e, n - 1);
      if (n > 0) matches++;
    }
    return calc(matches, this.a.length + this.b.length);
  }

  realQuickRatio(): number {
    const la = this.a.length, lb = this.b.length;
    return calc(Math.min(la, lb), la + lb);
  }
}

function calc(matches: number, length: number): number {
  return length ? (2 * matches) / length : 1;
}
