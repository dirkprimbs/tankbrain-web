// The long-term memory, to look at: who Norbert is (core beliefs), what it
// believes and finds interesting, and the conversations it remembers. For
// looking only: nothing here changes what the brain remembers.

import * as api from "./api";
import { CAPACITY, type Memory } from "./engine/memory/longterm";

type Row = Omit<Memory, "embedding">;

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const day = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);

interface Section {
  title: string;
  note: string;
  rows: Row[];
  detail: (m: Row) => string;
  empty: string;
}

export class MemoryWindow {
  private root = h("div", "editor-backdrop");
  private body = h("div", "settings-body memory-body");
  private count = h("span", "memory-count");

  constructor() {
    const panel = h("div", "editor settings memory-win");
    const head = h("div", "editor-head");
    const close = h("button", "ghost", "×");
    close.addEventListener("click", () => this.close());
    head.append(h("h2", "", "LONG-TERM MEMORY"), this.count, close);
    panel.append(head, this.body);
    this.root.append(panel);
    this.root.addEventListener("mousedown", (e) => { if (e.target === this.root) this.close(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") this.close(); });
    document.body.append(this.root);
  }

  async open() {
    this.root.classList.add("show");
    await this.refresh();
  }

  close() {
    this.root.classList.remove("show");
  }

  get isOpen(): boolean {
    return this.root.classList.contains("show");
  }

  async refresh() {
    const all: Row[] = await api.memoryList();
    this.count.textContent = `${all.length} of at most ${CAPACITY}`;
    const of = (pred: (m: Row) => boolean) => all.filter(pred).sort((a, b) => b.weight - a.weight);
    const sections: Section[] = [
      { title: "WHO I AM", rows: all.filter((m) => m.pinned).sort((a, b) => a.id - b.id), empty: "",
        note: "Core beliefs: they never fade. One changes only after careful reconsidering, and only once it has " +
          "been questioned in more than one conversation.",
        detail: (m) => [
          m.seeded && m.seeded !== m.text ? `changed from "${m.seeded}"` : "",
          m.doubts.length ? `questioned ${m.doubts.length}× (latest: "${m.doubts.at(-1)!.text}")` : "",
        ].filter(Boolean).join(" · ") },
      { title: "WHAT I BELIEVE", rows: of((m) => m.kind === "believe" && !m.pinned), empty: "nothing yet",
        note: "", detail: (m) => (m.context ? `from when asked "${m.context}"` : "") },
      { title: "WHAT I FIND INTERESTING", rows: of((m) => m.kind === "interesting"), empty: "nothing yet",
        note: "", detail: (m) => (m.context ? `from when asked "${m.context}"` : "") },
      { title: "CONVERSATIONS", rows: all.filter((m) => m.kind === "said").sort((a, b) => b.created - a.created),
        empty: "nothing yet",
        note: "What was asked and replied. The latest reply is kept word for word; older ones fade to a gist. A follow-up continues its thread.",
        detail: (m) => [m.verbatim ? "latest, word for word" : "", m.follows !== null ? "↳ continues an earlier exchange" : "", day(m.created)]
          .filter(Boolean).join(" · ") },
    ];
    this.body.replaceChildren(h("p", "settings-note",
      "What Norbert remembers across questions. Bars show strength: a memory grows stronger when it proves useful or turns up " +
      "again, weaker when it comes to mind for nothing, and fades a little every session. The weakest are forgotten."));
    for (const s of sections) {
      const det = h("details", "mem-section");
      det.open = s.title !== "CONVERSATIONS" || s.rows.length <= 6;
      det.append(h("summary", "editor-group", `${s.title} · ${s.rows.length}`));
      if (s.note) det.append(h("p", "settings-note", s.note));
      const list = h("div", "mem-list");
      if (!s.rows.length && s.empty) list.append(h("div", "small", s.empty));
      for (const m of s.rows) list.append(this.row(m, s.detail(m)));
      det.append(list);
      this.body.append(det);
    }
  }

  private row(m: Row, detail: string): HTMLElement {
    const row = h("div", "mem-row");
    const bar = h("span", "mem-weight");
    bar.style.setProperty("--w", String(m.pinned ? 1 : m.weight));
    bar.title = m.pinned ? "core belief: never fades" : `strength ${m.weight.toFixed(2)} · used ${m.uses}× · ${m.age} sessions old`;
    const reply = m.verbatim ? `${m.text.slice(0, 400)}${m.text.length > 400 ? "…" : ""}` : m.text;
    const text = h("span", "mem-text", m.kind === "said" && m.question ? `asked "${m.question}" → ${reply}` : reply);
    if (detail) text.append(h("span", "mem-link", detail));
    row.append(bar, text);
    return row;
  }
}
