// Hover card for a voice on the brain: configuration, task and current state.
import type { AgentInfo, TankEvent } from "./types";
import { GROUP_LABELS } from "./types";

const ABILITY: Record<string, string> = {
  write_draft: "writes the draft",
  write_memory: "keeps the notebook",
  speak: "speaks the reply",
  verdict: "approves or sends back the reply",
  remember: "keeps long-term memory",
  interest: "drives the energy level",
};

interface VoiceState {
  status: "standby" | "listening" | "thinking" | "loading" | "waiting" | "done";
  since: number;          // event timestamp the status started
  turns: number;
  lastSeconds: number | null;
  lastSaid: string | null;
  lastThought: string | null;
}

const fresh = (): VoiceState => ({ status: "standby", since: 0, turns: 0, lastSeconds: null, lastSaid: null, lastThought: null });

const h = (tag: string, cls = "", text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

export class VoiceCard {
  private el = h("div", "voice-card");
  private agents = new Map<string, AgentInfo>();
  private states = new Map<string, VoiceState>();
  private shown: string | null = null;
  private anchor: HTMLElement | null = null;
  private lastTs = 0;
  hidden: Set<string> = new Set();   // voices filtered out of the stream

  constructor() {
    document.body.append(this.el);
    setInterval(() => this.shown && this.render(), 1000); // keep "for 12 s" ticking
  }

  setAgents(agents: AgentInfo[]) {
    this.agents = new Map(agents.map((a) => [a.name, a]));
    this.states = new Map(agents.map((a) => [a.name, fresh()]));
    if (this.shown && !this.agents.has(this.shown)) this.hide();
  }

  /** Follow the event stream (live or replay) to know what each voice is doing. */
  track(e: TankEvent) {
    this.lastTs = e.ts;
    const d = e.data;
    if (e.kind === "session_start") {
      for (const [name, a] of this.agents) {
        this.states.set(name, { ...fresh(), status: a.phase === "think" ? "listening" : "waiting", since: e.ts });
      }
    } else if (e.kind === "session_end") {
      for (const s of this.states.values()) Object.assign(s, { status: "done", since: e.ts });
    }
    const s = e.agent ? this.states.get(e.agent) : undefined;
    if (s) {
      switch (e.kind) {
        case "model_switch": Object.assign(s, { status: "loading", since: e.ts }); break;
        case "turn_start": Object.assign(s, { status: "thinking", since: e.ts }); s.turns++; break;
        case "turn_end": {
          const a = this.agents.get(e.agent!);
          Object.assign(s, { status: a?.phase === "think" ? "listening" : "waiting", since: e.ts, lastSeconds: d.seconds });
          break;
        }
        case "thought": if (d.text) s.lastThought = d.text; break;
        case "post": if (!d.system) s.lastSaid = `#${d.topic}: ${d.text}`; break;
        case "dm": s.lastSaid = `→ ${d.to} (private): ${d.text}`; break;
        case "draft": s.lastSaid = `draft v${d.version}${d.note ? ": " + d.note : ""}`; break;
        case "verdict": s.lastSaid = `${d.verdict}: ${d.reason}`; break;
        case "output": s.lastSaid = `said: ${d.text}`; break;
        case "interest": s.lastSaid = `interest ${d.value}/10`; break;
      }
    }
    if (this.shown) this.render();
  }

  show(name: string, anchor: HTMLElement) {
    this.shown = name;
    this.anchor = anchor;
    this.render();
    this.el.classList.add("show");
  }

  hide() {
    this.shown = null;
    this.el.classList.remove("show");
  }

  private statusText(a: AgentInfo, s: VoiceState): string {
    const ago = s.since && this.lastTs ? Math.max(0, Math.round((this.liveNow() - s.since))) : 0;
    const dur = ago ? ` · ${ago} s` : "";
    switch (s.status) {
      case "thinking": return `thinking now${dur}`;
      case "loading": return `loading ${a.model}${dur}`;
      case "listening": return "listening: speaks when something new reaches it";
      case "waiting": return a.phase === "gate" ? "waits until the draft is declared ready" : "waits for its cue to speak";
      case "done": return `finished · ${s.turns} turn${s.turns === 1 ? "" : "s"}`;
      default: return "standby: no session running";
    }
  }

  // during a live session use the wall clock, during a replay the last event time
  private liveNow(): number {
    return Math.max(this.lastTs, document.querySelector(".mode.live") ? Date.now() / 1000 : this.lastTs);
  }

  private render() {
    const a = this.shown ? this.agents.get(this.shown) : undefined;
    if (!a) return;
    const s = this.states.get(a.name) ?? fresh();
    this.el.innerHTML = "";
    this.el.style.setProperty("--c", a.color);

    const head = h("div", "vc-head");
    head.append(h("b", "", a.name), h("span", "", `${a.region} · ${(GROUP_LABELS[a.group] ?? a.group).toLowerCase()}`));
    this.el.append(head);

    const state = h("div", `vc-state ${s.status}`);
    state.append(h("i"), h("span", "", this.statusText(a, s)));
    this.el.append(state);
    if (this.hidden.has(a.name)) this.el.append(h("div", "vc-note", "hidden in the stream by the filter"));

    const sec = (title: string, rows: [string, string][]) => {
      const box = h("div", "vc-sec");
      box.append(h("label", "", title));
      for (const [k, v] of rows) {
        if (!v) continue;
        const r = h("div", "vc-row");
        r.append(h("span", "k", k), h("span", "v", v));
        box.append(r);
      }
      this.el.append(box);
    };

    sec("TASK", [
      ["job", a.public],
      ["owns", a.abilities.map((x) => ABILITY[x] ?? x).join(", ")],
      ["reads", a.subscriptions.map((t) => (t === "inspiration" ? "the question" : "#" + t)).join(", ") || (a.phase === "think" ? "" : "the question and the draft, when called")],
      ["writes to", a.posts_to.map((t) => "#" + t).join(", ")],
      ["can message", a.contacts.join(", ")],
    ]);
    sec("CONFIGURATION", [
      ["model", a.model],
      ["temperature", a.options?.temperature !== undefined ? String(a.options.temperature) : "model default"],
      ["thinking", a.think ? "on" : "off"],
      ["runs on", "OpenRouter"],
    ]);
    sec("THIS SESSION", [
      ["turns", s.turns ? `${s.turns}${s.lastSeconds != null ? ` · last took ${s.lastSeconds} s` : ""}` : "none yet"],
      ["last said", clip(s.lastSaid)],
      ["last thought", clip(s.lastThought)],
    ]);
    this.el.append(h("div", "vc-hint", "click: adjust parameters · shift-click: solo in stream · ctrl-click: hide/show"));
    this.place();
  }

  private place() {
    if (!this.anchor) return;
    const r = this.anchor.getBoundingClientRect();
    const w = this.el.offsetWidth || 320, ht = this.el.offsetHeight || 300;
    let x = r.right + 12, y = r.top - 10;
    if (x + w > window.innerWidth - 8) x = r.left - w - 12;
    y = Math.min(Math.max(8, y), window.innerHeight - ht - 8);
    this.el.style.left = `${Math.max(8, x)}px`;
    this.el.style.top = `${y}px`;
  }
}

function clip(t: string | null, n = 180): string {
  if (!t) return "";
  return t.length > n ? t.slice(0, n) + " …" : t;
}
