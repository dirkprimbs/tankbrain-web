// The inner-speech stream with per-agent / per-group filters.
import type { AgentInfo, TankEvent } from "./types";
import { GROUP_LABELS } from "./types";

export interface FilterState {
  hidden: Set<string>;
  thoughts: boolean;
  dms: boolean;
  system: boolean;
}

const el = (tag: string, cls = "", text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

export class Stream {
  agents = new Map<string, AgentInfo>();
  filter: FilterState = { hidden: new Set(), thoughts: true, dms: true, system: true };
  t0 = 0;
  onFilterChange: (f: FilterState) => void = () => {};
  onConfigure: (agent: string) => void = () => {};
  private follow = true;

  constructor(private list: HTMLElement, private chips: HTMLElement, private toggles: HTMLElement) {
    list.addEventListener("scroll", () => {
      this.follow = list.scrollTop + list.clientHeight >= list.scrollHeight - 40;
    });
    for (const key of ["thoughts", "dms", "system"] as const) {
      const b = el("button", "toggle on", { thoughts: "THOUGHTS", dms: "PRIVATE", system: "SYSTEM" }[key]);
      b.addEventListener("click", () => {
        this.filter[key] = !this.filter[key];
        b.classList.toggle("on", this.filter[key]);
        this.apply();
      });
      toggles.appendChild(b);
    }
  }

  setAgents(agents: AgentInfo[]) {
    this.agents = new Map(agents.map((a) => [a.name, a]));
    this.chips.innerHTML = "";
    const groups = [...new Set(agents.map((a) => a.group))];
    const all = el("button", "chip all", "ALL");
    all.addEventListener("click", () => this.setHidden(new Set()));
    this.chips.appendChild(all);
    for (const g of groups) {
      const members = agents.filter((a) => a.group === g);
      const row = el("div", "group-row");
      const gb = el("button", "chip group", GROUP_LABELS[g] ?? g.toUpperCase());
      gb.style.setProperty("--c", members[0].color);
      gb.dataset.group = g;
      gb.title = "click: show/hide group · shift-click: solo group";
      gb.addEventListener("click", (ev) => {
        const names = members.map((m) => m.name);
        if ((ev as MouseEvent).shiftKey) {
          this.setHidden(new Set(agents.map((a) => a.name).filter((n) => !names.includes(n))));
        } else {
          const allHidden = names.every((n) => this.filter.hidden.has(n));
          const h = new Set(this.filter.hidden);
          names.forEach((n) => (allHidden ? h.delete(n) : h.add(n)));
          this.setHidden(h);
        }
      });
      row.appendChild(gb);
      for (const a of members) {
        const b = el("button", "chip agent", a.name);
        b.style.setProperty("--c", a.color);
        b.dataset.agent = a.name;
        b.title = `${a.public}\n${a.region} · ${a.model}\nshift-click: solo`;
        b.title += "\nalt-click: configure";
        b.addEventListener("click", (ev) => {
          const me = ev as MouseEvent;
          me.altKey ? this.onConfigure(a.name) : this.toggleAgent(a.name, me.shiftKey);
        });
        row.appendChild(b);
      }
      this.chips.appendChild(row);
    }
    this.apply();
  }

  toggleAgent(name: string, solo = false) {
    if (solo) {
      const others = [...this.agents.keys()].filter((n) => n !== name);
      const alreadySolo = others.every((n) => this.filter.hidden.has(n)) && !this.filter.hidden.has(name);
      this.setHidden(alreadySolo ? new Set() : new Set(others));
      return;
    }
    const h = new Set(this.filter.hidden);
    h.has(name) ? h.delete(name) : h.add(name);
    this.setHidden(h);
  }

  setHidden(h: Set<string>) {
    this.filter.hidden = h;
    this.apply();
  }

  private apply() {
    for (const b of this.chips.querySelectorAll<HTMLElement>(".chip.agent")) {
      b.classList.toggle("off", this.filter.hidden.has(b.dataset.agent!));
    }
    for (const b of this.chips.querySelectorAll<HTMLElement>(".chip.group")) {
      const names = [...this.agents.values()].filter((a) => a.group === b.dataset.group).map((a) => a.name);
      b.classList.toggle("off", names.every((n) => this.filter.hidden.has(n)));
    }
    for (const m of this.list.children as HTMLCollectionOf<HTMLElement>) this.applyOne(m);
    this.onFilterChange(this.filter);
    this.scroll();
  }

  private applyOne(m: HTMLElement) {
    const agent = m.dataset.agent;
    const cat = m.dataset.cat;
    let show = true;
    if (agent && this.filter.hidden.has(agent)) show = false;
    if (cat === "thought" && !this.filter.thoughts) show = false;
    if (cat === "dm" && !this.filter.dms) show = false;
    if (cat === "system" && !this.filter.system) show = false;
    m.style.display = show ? "" : "none";
  }

  clear() {
    this.list.innerHTML = "";
    this.follow = true;
  }

  private scroll() {
    if (this.follow) this.list.scrollTop = this.list.scrollHeight;
  }

  private item(e: TankEvent, cat: string, tag: string, text: string, extraCls = ""): HTMLElement {
    const a = e.agent ? this.agents.get(e.agent) : undefined;
    const m = el("div", `msg cat-${cat} ${extraCls}`);
    if (e.agent) m.dataset.agent = e.agent;
    m.dataset.cat = cat;
    m.style.setProperty("--c", a?.color ?? "#9fb3c8");
    const meta = el("div", "meta");
    meta.append(el("span", "who", e.agent ?? "TANK"), el("span", "tag", tag), el("span", "time", `+${(e.ts - this.t0).toFixed(1)}s`));
    m.append(meta);
    if (text) m.append(el("div", "text", text));
    return m;
  }

  private sys(e: TankEvent, text: string) {
    const m = el("div", "sysline", text);
    m.dataset.cat = "system";
    return m;
  }

  add(e: TankEvent) {
    const d = e.data;
    let node: HTMLElement | null = null;
    switch (e.kind) {
      case "session_start":
        this.t0 = e.ts;
        node = this.sys(e, `▶ SESSION ${e.session} · profile ${d.profile}`);
        break;
      case "input":
        node = this.item(e, "input", "✦ INSPIRATION", d.text, "input");
        break;
      case "post":
        node = this.item(e, d.system ? "system" : "post", `#${d.topic}`, d.text, d.system ? "minor" : "");
        break;
      case "dm":
        node = this.item(e, "dm", `→ ${d.to} · private`, d.text, "dm");
        break;
      case "signal":
        node = this.sys(e, e.agent ? `⏱ ${e.agent} receives: ${d.text}` : `⏱ everyone thinking hears: ${d.text}`);
        break;
      case "thought": {
        node = this.item(e, "thought", "THINKS", d.text || "(wordless)", "thought");
        if (d.reasoning) {
          const det = el("details", "reasoning");
          det.append(el("summary", "", "reasoning trace"), el("pre", "", d.reasoning));
          node.append(det);
        }
        break;
      }
      case "audio_end":
        node = this.sys(e, `🔊 spoken · ${d.chunks} part${d.chunks === 1 ? "" : "s"} · ${d.seconds} s · voice ${d.voice}`);
        break;
      case "audio_error":
        node = this.item(e, "system", "SPEECH FAILED", d.error, "error");
        break;
      case "ready":
        node = this.item(e, "post", `READY · v${d.version}`, "considers the draft finished", "minor");
        break;
      case "edit_failed":
        node = this.item(e, "system", "EDIT NOT APPLIED", (d.failed as any[]).map((f) => `${f.why ?? "passage not found"}: "${f.find}"`).join("\n"), "minor");
        break;
      case "suppressed":
        node = this.item(e, "system", "ECHO SUPPRESSED", d.text, "minor");
        break;
      case "memory": {
        const open = (d.items as any[]).map((i) => `${i.status === "done" ? "✓" : "○"} ${i.kind}: ${i.text}`).join("\n");
        node = this.item(e, "post", "NOTEBOOK", open, "memory");
        break;
      }
      case "draft": {
        const how = d.mode === "edit" ? ` · ${d.applied.length} edit${d.applied.length === 1 ? "" : "s"}` : d.mode === "rewrite" ? " · rewritten" : "";
        node = this.item(e, "post", `DRAFT v${d.version}${how}`, "", "draft");
        if (d.mode === "edit") {
          const ul = el("div", "edits");
          for (const x of d.applied as { find: string; replace: string }[]) {
            const row = el("div", "edit");
            row.append(el("del", "", x.find), el("span", "arrow", " → "), el("ins", "", x.replace || "(deleted)"));
            ul.append(row);
          }
          node.append(ul);
        }
        const det = el("details", "draftbody");
        det.append(el("summary", "", `show version ${d.version}`), el("pre", "", d.text));
        node.append(det);
        break;
      }
      case "interest":
        node = this.item(e, "post", `INTEREST ${d.value}/10`, `energy → ${(d.level * 100).toFixed(0)}%`, "minor");
        break;
      case "verdict":
        node = this.item(e, "post", d.verdict === "approve" ? "✔ APPROVED" : "✖ SENT BACK", d.reason, `verdict ${d.verdict}`);
        break;
      case "output":
        node = this.item(e, "post", "◀ SPOKEN REPLY", d.text, "output");
        node.title = "click to show the reply window";
        break;
      case "recall_search":
        if (d.hits?.length) node = this.item(e, "post", "COMES TO MIND", d.hits.map((h: any) => `• ${h.text}`).join("\n"), "memory");
        break;
      case "remember":
        node = this.item(e, "post", "STORED", d.items.map((i: string) => `• ${i}`).join("\n"), "memory");
        break;
      case "cycle":
        node = this.sys(e, `── ${d.wrap ? "WRAP-UP " : ""}CYCLE ${d.n} ── floor: ${d.ready.join(", ") || "—"}`);
        break;
      case "phase":
        node = this.sys(e, `══ PHASE ${String(d.phase).toUpperCase()} ${d.reason ? "· " + d.reason : ""}`);
        break;
      case "model_switch":
        node = this.sys(e, `⇄ loading ${d.model}`);
        break;
      case "error":
        node = this.item(e, "system", "ERROR", d.error, "error");
        break;
      case "session_end":
        node = this.sys(e, `■ END · ${d.seconds ?? "?"} s${d.cancelled ? " · cancelled" : ""}`);
        break;
    }
    if (!node) return;
    this.applyOne(node);
    this.list.appendChild(node);
    this.scroll();
  }
}
