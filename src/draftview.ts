// Draft dock: each version shown as changes against the previous one,
// with what the Drafter had just read when it made them.
import type { AgentInfo, DraftVersion } from "./types";

const MODE_LABEL: Record<string, string> = { initial: "first draft", edit: "edited", rewrite: "rewritten" };

export class DraftView {
  versions: DraftVersion[] = [];
  showChanges = true;
  agents = new Map<string, AgentInfo>();

  constructor(
    private body: HTMLElement,
    private meta: HTMLElement,
    private slider: HTMLInputElement,
    private ver: HTMLElement,
    changesToggle: HTMLInputElement,
  ) {
    slider.addEventListener("input", () => this.show(Number(slider.value)));
    changesToggle.addEventListener("change", () => {
      this.showChanges = changesToggle.checked;
      this.show(Number(slider.value));
    });
  }

  reset() {
    this.versions = [];
    this.slider.max = "1";
    this.slider.value = "1";
    this.show(0);
  }

  add(d: any) {
    // older sessions (before edit-based drafting) only stored the text
    const v: DraftVersion = {
      version: d.version, text: d.text, mode: d.mode ?? (d.version === 1 ? "initial" : "rewrite"),
      diff: d.diff ?? [["=", d.text]], applied: d.applied ?? [], failed: d.failed ?? [], sources: d.sources ?? [], note: d.note ?? "",
    };
    this.versions.push(v);
    this.slider.max = String(this.versions.length);
    this.slider.value = String(this.versions.length);
    this.show(this.versions.length);
  }

  private show(n: number) {
    this.body.innerHTML = "";
    this.meta.innerHTML = "";
    if (!this.versions.length || n < 1) {
      this.body.textContent = "— no draft yet —";
      this.ver.textContent = "v0";
      return;
    }
    const v = this.versions[n - 1];
    this.ver.textContent = `v${n}/${this.versions.length}`;

    // header: mode, number of changes, what it responded to
    const badge = document.createElement("span");
    badge.className = `mode-badge ${v.mode}`;
    badge.textContent = MODE_LABEL[v.mode] ?? v.mode;
    this.meta.append(badge);
    if (v.mode === "edit") {
      const c = document.createElement("span");
      c.className = "count";
      c.textContent = `${v.applied.length} change${v.applied.length === 1 ? "" : "s"}` + (v.failed.length ? ` · ${v.failed.length} not found` : "");
      this.meta.append(c);
    }
    if (v.note) {
      const n = document.createElement("span");
      n.className = "note";
      n.textContent = `“${v.note}”`;
      this.meta.append(n);
    }
    const heard = v.sources.filter((s) => s.from !== "time");
    if (v.sources.length) {
      const det = document.createElement("details");
      det.className = "sources";
      const sum = document.createElement("summary");
      const who = [...new Set(heard.map((s) => s.from + (s.kind === "dm" ? " (private)" : s.topic ? ` #${s.topic}` : "")))];
      sum.textContent = `in response to: ${who.join(", ") || "the wrap-up signal"}`;
      det.append(sum);
      for (const s of v.sources) {
        const row = document.createElement("div");
        row.className = "src";
        row.style.setProperty("--c", this.agents.get(s.from)?.color ?? "#9fb3c8");
        const w = document.createElement("b");
        w.textContent = s.from === "time" ? "instruction" : s.from;
        const t = document.createElement("span");
        t.textContent = s.text;
        row.append(w, t);
        det.append(row);
      }
      this.meta.append(det);
    }

    if (!this.showChanges || v.mode === "initial") {
      this.body.textContent = v.text;
      return;
    }
    for (const [op, text] of v.diff) {
      const node = op === "=" ? document.createTextNode(text) : document.createElement(op === "+" ? "ins" : "del");
      if (op !== "=") node.textContent = text;
      this.body.append(node);
    }
  }
}
