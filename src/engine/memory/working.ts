// Working memory: tasks, decisions and open questions. One writer only.

export const KINDS = ["task", "decision", "question"] as const;

export class MemoryPermissionError extends Error {}

export interface Item {
  id: number;
  kind: string;
  text: string;
  status: "open" | "done";
}

export class WorkingMemory {
  items: Item[] = [];
  constructor(public owner: string) {}

  private check(who: string) {
    if (who !== this.owner) throw new MemoryPermissionError(`${who} may not write working memory (owner: ${this.owner})`);
  }

  /** ops: add_task, add_decision, add_question, close (ref = item id). */
  apply(who: string, op: string, text = "", ref: number | null = null): Item | null {
    this.check(who);
    if (op.startsWith("add_")) {
      const kind = op.slice(4);
      if (!(KINDS as readonly string[]).includes(kind) || !text.trim()) return null;
      if (this.items.some((i) => i.text.trim().toLowerCase() === text.trim().toLowerCase())) return null;
      const item: Item = { id: this.items.length + 1, kind, text: text.trim(), status: "open" };
      this.items.push(item);
      return item;
    }
    if (op === "close" && ref !== null) {
      const i = this.items.find((x) => x.id === ref);
      if (i) {
        i.status = "done";
        return i;
      }
    }
    return null;
  }

  render(): string {
    if (!this.items.length) return "(empty)";
    return this.items.map((i) => `[${i.status === "done" ? "x" : " "}] #${i.id} ${i.kind}: ${i.text}`).join("\n");
  }

  snapshot(): Item[] {
    return this.items.map((i) => ({ ...i }));
  }
}
