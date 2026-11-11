// Voice editor: per-voice model, temperature, thinking, on/off and persona,
// saved as a custom profile in this browser (built-in profiles stay untouched).
// Every voice runs on an OpenRouter model.
import type { AgentInfo, ConfigInfo } from "./types";
import * as api from "./api";
import type { CloudModel } from "./engine/llm";
import { BROWSER_MODELS, BROWSER_PREFIX } from "./engine/browserllm";
import { GROUP_LABELS } from "./types";

interface ModelList { cloud: CloudModel[]; cloud_error: string | null }

const ABILITY_NOTE: Record<string, string> = {
  write_draft: "writes the draft",
  write_memory: "keeps the notebook",
  speak: "speaks the reply",
  verdict: "approves the reply",
  remember: "keeps long-term memory",
  interest: "drives the energy level",
};
const OFF_WARNING: Record<string, string> = {
  write_draft: "Without it there is no draft and nothing to say.",
  speak: "Without it the final draft is output unchanged.",
  verdict: "Without it nothing checks the reply.",
  interest: "Without it the session ends only on quiet, time or the cycle limit.",
};

interface Row {
  agent: AgentInfo;
  enabled: HTMLInputElement;
  model: HTMLSelectElement;
  temp: HTMLInputElement;
  think: HTMLSelectElement;
  persona: HTMLTextAreaElement;
  el: HTMLElement;
}

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

export class VoiceEditor {
  private root: HTMLElement;
  private list: HTMLElement;
  private nameInput: HTMLInputElement;
  private status: HTMLElement;
  private title: HTMLElement;
  private rows: Row[] = [];
  private profile = "";
  private only: string | null = null;
  private existing: string[] = [];
  private allBtn: HTMLButtonElement;
  onSaved: (profile: string) => void = () => {};

  constructor() {
    this.root = h("div", "editor-backdrop");
    const panel = h("div", "editor");
    const head = h("div", "editor-head");
    this.title = h("h2", "", "CONFIGURE VOICES");
    const close = h("button", "ghost", "×");
    close.addEventListener("click", () => this.close());
    this.allBtn = h("button", "ghost show-all", "show all voices");
    this.allBtn.addEventListener("click", () => {
      const keep = this.only;
      this.only = null;
      for (const r of this.rows) r.el.style.display = "";
      this.list.querySelectorAll<HTMLElement>(".editor-group").forEach((g) => (g.style.display = ""));
      this.allBtn.style.display = "none";
      this.title.textContent = `CONFIGURE VOICES · based on "${this.profile}"`;
      if (keep) this.rows.find((r) => r.agent.name === keep)?.el.scrollIntoView({ block: "center" });
    });
    head.append(this.title, this.allBtn, close);
    this.list = h("div", "editor-list");
    const foot = h("div", "editor-foot");
    const lab = h("label", "small", "save as profile");
    this.nameInput = h("input", "profile-name");
    this.nameInput.placeholder = "custom";
    this.nameInput.maxLength = 32;
    this.nameInput.addEventListener("input", () => this.checkName());
    const save = h("button", "primary", "SAVE PROFILE");
    save.addEventListener("click", () => this.save());
    this.status = h("span", "editor-status");
    foot.append(lab, this.nameInput, save, this.status);
    panel.append(head, this.list, foot);
    this.root.append(panel);
    this.root.addEventListener("mousedown", (e) => { if (e.target === this.root) this.close(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") this.close(); });
    document.body.append(this.root);
  }

  /** only=true shows just the focused voice (all are still saved). */
  async open(profile: string, focus?: string, only = false) {
    this.profile = profile;
    this.only = only && focus ? focus : null;
    this.status.textContent = "loading…";
    this.status.className = "editor-status";
    this.root.classList.add("show");
    const [cfg, models]: [ConfigInfo, ModelList] = await Promise.all([api.getConfig(profile), api.models()]);
    const problems = [models.cloud_error].filter(Boolean);
    this.title.textContent = this.only ? `CONFIGURE ${this.only.toUpperCase()} · profile "${profile}"`
      : `CONFIGURE VOICES · based on "${profile}"`;
    this.existing = cfg.profiles;
    // from a built-in profile, suggest a name that doesn't replace anything
    let suggestion = profile;
    if (cfg.builtin.includes(profile)) {
      suggestion = "custom";
      for (let i = 2; this.existing.includes(suggestion); i++) suggestion = `custom-${i}`;
    }
    this.nameInput.value = suggestion;
    this.status.textContent = problems.length ? `⚠ ${problems.join(" · ")}` : "";
    if (!problems.length) this.checkName();
    this.build([...cfg.agents.map((a) => ({ a, on: true })), ...cfg.disabled.map((a) => ({ a, on: false }))], models);
    // single-voice window: hide the others (they are still saved unchanged)
    this.allBtn.style.display = this.only ? "" : "none";
    if (this.only) {
      for (const r of this.rows) r.el.style.display = r.agent.name === this.only ? "" : "none";
      this.list.querySelectorAll<HTMLElement>(".editor-group").forEach((g) => (g.style.display = "none"));
      this.rows.find((r) => r.agent.name === this.only)?.el.querySelector("details")?.setAttribute("open", "");
    } else if (focus) {
      const row = this.rows.find((r) => r.agent.name === focus);
      row?.el.scrollIntoView({ block: "center" });
      row?.el.classList.add("focus");
      setTimeout(() => row?.el.classList.remove("focus"), 1600);
    }
  }

  close() {
    this.root.classList.remove("show");
  }

  private build(voices: { a: AgentInfo; on: boolean }[], models: ModelList) {
    this.list.innerHTML = "";
    this.rows = [];
    const groups = [...new Set(voices.map((v) => v.a.group))];
    for (const g of groups) {
      this.list.append(h("div", "editor-group", GROUP_LABELS[g] ?? g.toUpperCase()));
      for (const { a, on } of voices.filter((v) => v.a.group === g)) this.rows.push(this.row(a, on, models));
    }
  }

  private row(a: AgentInfo, on: boolean, models: ModelList): Row {
    const el = h("div", "voice-row");
    el.style.setProperty("--c", a.color);

    const name = h("div", "vname");
    const enabled = h("input");
    enabled.type = "checkbox";
    enabled.checked = on;
    enabled.title = "voice on/off";
    const nm = h("b", "", a.name);
    const sub = h("span", "", `${a.region}${a.abilities.length ? " · " + a.abilities.map((x) => ABILITY_NOTE[x] ?? x).join(", ") : ""}`);
    const label = h("label");
    label.append(enabled, nm);
    name.append(label, sub);

    const model = this.modelSelect(a.model, models);

    const temp = h("input");
    temp.type = "number";
    temp.min = "0";
    temp.max = "2";
    temp.step = "0.1";
    temp.placeholder = "default";
    temp.title = "temperature (empty = model default)";
    if (a.options?.temperature !== undefined) temp.value = String(a.options.temperature);

    const think = h("select");
    think.title = "thinking (reasoning before answering). Only models marked '· thinking' in the list support it.";
    for (const [v, t] of [["off", "no thinking"], ["on", "thinking"]]) {
      const o = h("option", "", t);
      o.value = v;
      o.selected = (a.think ? "on" : "off") === v;
      think.append(o);
    }

    const det = h("details", "persona");
    det.append(h("summary", "", "persona"));
    const persona = h("textarea");
    persona.value = a.persona.trim();
    persona.rows = 5;
    det.append(persona);

    const warn = h("div", "warn");
    const updateWarn = () => {
      el.classList.toggle("off", !enabled.checked);
      const w = a.abilities.map((x) => OFF_WARNING[x]).filter(Boolean);
      const msgs = [];
      if (!enabled.checked && w.length) msgs.push(`⚠ ${w.join(" ")}`);
      const info = models.cloud.find((m) => m.id === model.value);
      if (enabled.checked && think.value === "on" && info && !info.reasoning) {
        msgs.push("⚠ this model can't think: OpenRouter will refuse the request; switch thinking off");
      }
      warn.textContent = msgs.join("  ");
    };
    enabled.addEventListener("change", updateWarn);
    model.addEventListener("change", updateWarn);
    think.addEventListener("change", updateWarn);
    updateWarn();

    const controls = h("div", "vcontrols");
    controls.append(model, temp, think);
    el.append(name, controls, det, warn);
    this.list.append(el);
    return { agent: a, enabled, model, temp, think, persona, el };
  }

  private modelSelect(current: string, models: ModelList): HTMLSelectElement {
    const sel = h("select");
    const add = (parent: HTMLElement, value: string, label: string) => {
      const o = h("option", "", label);
      o.value = value;
      o.selected = value === current;
      parent.append(o);
    };
    const inBrowser = BROWSER_MODELS.map((m) => BROWSER_PREFIX + m.id);
    if (!models.cloud.some((m) => m.id === current) && !inBrowser.includes(current)) {
      add(sel, current, `${current}  (${models.cloud.length ? "not offered by OpenRouter right now" : "model list unavailable"})`);
    }
    if (models.cloud.length) {
      const cloud = h("optgroup");
      cloud.label = "OpenRouter · price per 1M tokens in/out";
      for (const m of models.cloud) {
        const price = m.price_in == null ? "" : `  $${fmt(m.price_in)}/$${fmt(m.price_out ?? 0)}`;
        add(cloud, m.id, `${m.id}${price}${m.reasoning ? "  · thinking" : ""}`);
      }
      sel.append(cloud);
    }
    const local = h("optgroup");
    local.label = "in this browser (WebGPU, no key, weaker) · GPU memory";
    for (const m of BROWSER_MODELS) add(local, BROWSER_PREFIX + m.id, `⌂ ${m.label}  ${m.vramGB} GB`);
    sel.append(local);
    return sel;
  }

  private checkName() {
    const name = this.nameInput.value.trim().toLowerCase();
    const replaces = name && name !== this.profile && this.existing.includes(name);
    this.status.textContent = replaces ? `⚠ saving will replace the existing profile "${name}"` : "";
    this.status.className = replaces ? "editor-status error" : "editor-status";
  }

  private async save() {
    const name = this.nameInput.value.trim().toLowerCase() || "custom";
    const voices: Record<string, any> = {};
    for (const r of this.rows) {
      voices[r.agent.name] = {
        enabled: r.enabled.checked,
        model: r.model.value,
        temperature: r.temp.value === "" ? null : Number(r.temp.value),
        think: r.think.value === "on",
        persona: r.persona.value,
      };
    }
    this.status.textContent = "saving…";
    try {
      await api.saveProfile(name, { voices, note: `Based on "${this.profile}".`, based_on: this.profile });
    } catch (e) {
      this.status.textContent = `⚠ ${(e as api.ApiError).detail ?? e}`;
      this.status.className = "editor-status error";
      return;
    }
    this.status.textContent = `saved "${name}"`;
    this.status.className = "editor-status ok";
    this.onSaved(name);
    setTimeout(() => this.close(), 600);
  }
}

function fmt(n: number): string {
  return n === 0 ? "0" : n < 0.1 ? n.toFixed(3) : n < 10 ? n.toFixed(2) : n.toFixed(0);
}
