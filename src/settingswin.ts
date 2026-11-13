// Settings window: OpenRouter key, parallelism, speech and the data kept in this browser.
import { settings } from "./settings";
import * as api from "./api";
import { startSignIn } from "./signin";

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

export class SettingsWindow {
  private root = h("div", "editor-backdrop");
  private keyInput = h("input", "key-input");
  private remember = h("input");
  private conc = h("input");
  private state = h("div", "key-state");
  private status = h("span", "editor-status");
  onChanged: () => void = () => {};
  onPreview: () => void = () => {};
  onForgotten: () => void = () => {};
  onMemory: () => void = () => {};
  private speak = h("input");
  private voice = h("select");       // Kokoro voice
  private engine = h("select");
  private ttsModel = h("select");
  private ttsVoice = h("select");
  private style = h("textarea");
  private orBox = h("div");
  private kokoroBox = h("div");
  private models: api.SpeechModelInfo[] = [];
  private speed = h("input");
  private speedVal = h("span");

  constructor() {
    const panel = h("div", "editor settings");
    const head = h("div", "editor-head");
    const close = h("button", "ghost", "×");
    close.addEventListener("click", () => this.close());
    head.append(h("h2", "", "SETTINGS"), close);

    const body = h("div", "settings-body");

    // --- OpenRouter
    body.append(h("div", "editor-group", "MODELS · OPENROUTER"));
    body.append(h("p", "settings-note",
      "Every voice runs on a model hosted by OpenRouter (pick each one in the voice's settings), so a key " +
      "is needed. The key is kept only in this browser and is sent only to OpenRouter. Everything a voice " +
      "reads (the question, notes, the draft) goes to OpenRouter and the model's provider."));
    body.append(this.state);
    const signin = h("button", "primary", "SIGN IN WITH OPENROUTER");
    signin.addEventListener("click", () => startSignIn());
    const signRow = h("div", "row");
    signRow.append(signin);
    body.append(signRow);
    body.append(h("p", "settings-note", "Signing in creates a key for Norbert, the brain, in your OpenRouter account and saves it here. Or paste a key:"));
    this.keyInput.type = "password";
    this.keyInput.placeholder = "sk-or-v1-…";
    this.keyInput.autocomplete = "off";
    this.keyInput.spellcheck = false;
    const show = h("button", "ghost", "show");
    show.addEventListener("click", () => {
      this.keyInput.type = this.keyInput.type === "password" ? "text" : "password";
      show.textContent = this.keyInput.type === "password" ? "show" : "hide";
    });
    const keyRow = h("div", "row");
    keyRow.append(this.keyInput, show);
    body.append(keyRow);

    this.remember.type = "checkbox";
    const remLabel = h("label", "small check");
    remLabel.append(this.remember, document.createTextNode(" remember on this device (otherwise forgotten when the tab closes)"));
    body.append(remLabel);

    const btns = h("div", "row");
    const save = h("button", "primary", "CHECK & SAVE KEY");
    save.addEventListener("click", () => this.saveKey());
    const remove = h("button", "ghost", "remove key");
    remove.addEventListener("click", () => {
      settings.setKey("", false);
      this.keyInput.value = "";
      this.say("key removed from this browser", "ok");
      this.refresh();
      this.onChanged();
    });
    btns.append(save, remove);
    body.append(btns);

    // --- parallelism
    body.append(h("div", "editor-group", "PARALLELISM"));
    body.append(h("p", "settings-note", "How many voices may think at the same time."));
    this.conc.type = "number";
    this.conc.min = "1";
    this.conc.max = "16";
    this.conc.addEventListener("change", () => {
      settings.setCloudConcurrency(Number(this.conc.value));
      this.conc.value = String(settings.cloudConcurrency);
      this.say("saved", "ok");
    });
    const concRow = h("div", "row");
    concRow.append(h("label", "small", "voices at once"), this.conc);
    body.append(concRow);

    // --- speech
    body.append(h("div", "editor-group", "SPOKEN REPLY"));
    this.speak.type = "checkbox";
    const speakLabel = h("label", "small check");
    speakLabel.append(this.speak, document.createTextNode(" speak replies aloud"));
    this.speak.addEventListener("change", () => {
      settings.speak = this.speak.checked;
      this.say("saved", "ok");
    });
    body.append(speakLabel);

    for (const [v, t] of [["openrouter", "OpenRouter speech model"], ["kokoro", "Kokoro, in this browser (offline)"]]) {
      const o = h("option", "", t);
      o.value = v;
      this.engine.append(o);
    }
    this.engine.addEventListener("change", () => {
      settings.speechEngine = this.engine.value as "openrouter" | "kokoro";
      this.showEngine();
      this.say("saved", "ok");
    });
    const engineRow = h("div", "row");
    engineRow.append(h("label", "small", "engine"), this.engine);
    body.append(engineRow);

    // OpenRouter: model, its voices, and how to speak
    this.orBox.append(h("p", "settings-note",
      "A hosted text-to-speech model reads the reply word for word; the style below tells it how. " +
      "The reply's text goes to OpenRouter and the model's provider, using your key."));
    this.ttsModel.addEventListener("change", () => {
      settings.ttsModel = this.ttsModel.value;
      this.fillTtsVoices();
      settings.ttsVoice = this.ttsVoice.value;
      this.say("saved", "ok");
    });
    this.ttsVoice.addEventListener("change", () => {
      settings.ttsVoice = this.ttsVoice.value;
      this.say("saved", "ok");
    });
    const modelRow = h("div", "row");
    modelRow.append(h("label", "small", "model"), this.ttsModel);
    const ttsVoiceRow = h("div", "row");
    ttsVoiceRow.append(h("label", "small", "voice"), this.ttsVoice, this.sampleButton());
    this.style.rows = 3;
    this.style.className = "style-input";
    this.style.placeholder = "e.g. warm and a little theatrical; a dry, deadpan radio host; breathless excitement";
    this.style.addEventListener("change", () => {
      settings.speechStyle = this.style.value;
      this.say("saved", "ok");
    });
    const styleLabel = h("label", "small", "speaking style (only some models follow it, e.g. Gemini TTS)");
    this.orBox.append(modelRow, ttsVoiceRow, styleLabel, this.style);

    // Kokoro: the voice list is fixed
    this.kokoroBox.append(h("p", "settings-note",
      "A small speech model rendered in this browser. It (about 330 MB with a graphics card, 90 MB without) downloads from Hugging Face the " +
      "first time it is needed and is cached afterwards. No text leaves the browser for this."));
    this.voice.addEventListener("change", () => {
      settings.voice = this.voice.value;
      this.say("saved", "ok");
    });
    const kokoroRow = h("div", "row");
    kokoroRow.append(h("label", "small", "voice"), this.voice, this.sampleButton());
    this.kokoroBox.append(kokoroRow);
    body.append(this.orBox, this.kokoroBox);

    this.speed.type = "range";
    this.speed.min = "0.7";
    this.speed.max = "1.4";
    this.speed.step = "0.1";
    const speedVal = h("span", "small");
    this.speed.addEventListener("input", () => (speedVal.textContent = `${Number(this.speed.value).toFixed(1)}×`));
    this.speed.addEventListener("change", () => {
      settings.speed = Number(this.speed.value);
      this.say("saved", "ok");
    });
    const speedRow = h("div", "row");
    speedRow.append(h("label", "small", "speed"), this.speed, speedVal);
    body.append(speedRow);
    this.speedVal = speedVal;

    // --- data
    body.append(h("div", "editor-group", "DATA IN THIS BROWSER"));
    body.append(h("p", "settings-note",
      "Past sessions, long-term memories, saved voice profiles and spoken audio are stored in this " +
      "browser only (IndexedDB). They stay until you delete them here or clear the site's data."));
    const forget = h("button", "ghost danger", "forget everything");
    let armed = false;
    forget.addEventListener("click", async () => {
      if (!armed) {
        armed = true;
        forget.textContent = "click again to delete it all";
        this.say("this deletes every session, memory, saved profile and recording; it can't be undone", "error");
        setTimeout(() => {
          armed = false;
          forget.textContent = "forget everything";
        }, 5000);
        return;
      }
      armed = false;
      forget.textContent = "forget everything";
      try {
        await api.forgetAll();
        this.say("everything deleted from this browser", "ok");
        this.onForgotten();
      } catch (e) {
        this.say(`not deleted: ${(e as api.ApiError).detail ?? e}`, "error");
      }
    });
    const dataRow = h("div", "row");
    dataRow.append(forget);
    body.append(dataRow);

    // --- the whole state, as a file
    body.append(h("p", "settings-note",
      "Export everything (sessions, memories, saved profiles, settings; never the key) as one file, to keep it " +
      "or move this brain to another browser. Importing such a file replaces everything here with it."));
    const exp = h("button", "ghost", "export everything");
    exp.addEventListener("click", async () => {
      try {
        const blob = await api.exportState();
        const a = h("a");
        a.href = URL.createObjectURL(blob);
        a.download = `tankbrain-state-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
        this.say(`exported (${(blob.size / 1e6).toFixed(1)} MB)`, "ok");
      } catch (e) {
        this.say(`not exported: ${(e as api.ApiError).detail ?? e}`, "error");
      }
    });
    const pick = h("input");
    pick.type = "file";
    pick.accept = ".json,application/json";
    pick.hidden = true;
    const imp = h("button", "ghost danger", "import everything…");
    let chosen: File | null = null;
    imp.addEventListener("click", async () => {
      if (!chosen) return pick.click();
      const f = chosen;
      chosen = null;
      imp.textContent = "import everything…";
      try {
        this.say(await api.importState(f) + "; reloading…", "ok");
        setTimeout(() => location.reload(), 1200);
      } catch (e) {
        this.say(`not imported: ${(e as api.ApiError).detail ?? e}`, "error");
      }
    });
    pick.addEventListener("change", () => {
      chosen = pick.files?.[0] ?? null;
      pick.value = "";
      if (!chosen) return;
      imp.textContent = "click again to replace everything";
      this.say(`"${chosen.name}" will replace every session, memory, profile and setting here; it can't be undone`, "error");
      setTimeout(() => {
        if (chosen) {
          chosen = null;
          imp.textContent = "import everything…";
        }
      }, 8000);
    });
    const stateRow = h("div", "row");
    stateRow.append(exp, imp, pick);
    body.append(stateRow);

    // --- long-term memory has its own window
    body.append(h("div", "editor-group", "LONG-TERM MEMORY"));
    const memRow = h("div", "row");
    const memBtn = h("button", "ghost", "open memory…");
    memBtn.addEventListener("click", () => { this.close(); this.onMemory(); });
    memRow.append(h("span", "settings-note", "What Norbert remembers and believes: "), memBtn);
    body.append(memRow);

    const foot = h("div", "editor-foot");
    foot.append(this.status);
    panel.append(head, body, foot);
    this.root.append(panel);
    this.root.addEventListener("mousedown", (e) => { if (e.target === this.root) this.close(); });
    document.body.append(this.root);
  }

  open() {
    this.keyInput.value = "";
    this.remember.checked = settings.openrouterKey ? settings.remembered : true;
    this.conc.value = String(settings.cloudConcurrency);
    this.speak.checked = settings.speak;
    this.speed.value = String(settings.speed);
    this.speedVal.textContent = `${settings.speed.toFixed(1)}×`;
    this.engine.value = settings.speechEngine;
    this.style.value = settings.speechStyle;
    this.showEngine();
    this.loadVoices();
    this.loadTtsModels();
    this.say("", "");
    this.refresh();
    this.root.classList.add("show");
  }

  private sample: HTMLAudioElement | null = null;

  /** "▶" next to a voice list: hear the selected voice (with the current speed and style). */
  private sampleButton(): HTMLButtonElement {
    const b = h("button", "ghost icon-btn", "▶ sample");
    b.title = "hear a sample of this voice";
    b.addEventListener("click", () => this.playSample());
    return b;
  }

  private playSample() {
    this.onPreview();
    this.sample?.pause();
    settings.speechStyle = this.style.value; // a sample with the style as typed
    this.say("making a sample…", "");
    try {
      api.ttsPreview(settings.speechSpec()).then((url) => {
        const a = (this.sample = new Audio(url));
        a.oncanplay = () => this.say("", "");
        a.onerror = () => this.say("couldn't play the sample", "error");
        a.play().catch(() => {});
      }, (e) => this.say(`couldn't make the sample: ${e.detail ?? e.message ?? e}`, "error"));
    } catch (e) {
      this.say(`couldn't make the sample: ${(e as api.ApiError).detail ?? e}`, "error");
    }
  }

  private showEngine() {
    const kokoro = this.engine.value === "kokoro";
    this.kokoroBox.style.display = kokoro ? "" : "none";
    this.orBox.style.display = kokoro ? "none" : "";
  }

  private async loadTtsModels() {
    try {
      this.models = await api.speechModels();
    } catch (e) {
      this.say(`OpenRouter speech models unavailable: ${(e as Error).message}`, "error");
      return;
    }
    this.ttsModel.innerHTML = "";
    const fmt = (n: number | null) => (n == null ? "?" : n === 0 ? "0" : n < 0.1 ? n.toFixed(3) : n < 10 ? n.toFixed(2) : n.toFixed(0));
    const current = settings.ttsModel;
    if (!this.models.some((m) => m.id === current)) {
      const o = h("option", "", `${current} (not offered right now)`);
      o.value = current;
      this.ttsModel.append(o);
    }
    for (const m of this.models) {
      const o = h("option", "", `${m.id}  $${fmt(m.price_in)}/$${fmt(m.price_out)}`);
      o.value = m.id;
      o.title = "price per 1M input/output units, as OpenRouter lists it";
      this.ttsModel.append(o);
    }
    this.ttsModel.value = current;
    this.fillTtsVoices();
  }

  private fillTtsVoices() {
    const model = this.models.find((m) => m.id === this.ttsModel.value);
    const voices = model?.voices ?? [];
    const keep = settings.ttsVoice;
    this.ttsVoice.innerHTML = "";
    for (const v of voices.length ? voices : [keep]) {
      const o = h("option", "", v);
      o.value = v;
      this.ttsVoice.append(o);
    }
    this.ttsVoice.value = voices.includes(keep) ? keep : voices[0] ?? keep;
    this.ttsVoice.disabled = !voices.length;
    this.ttsVoice.title = voices.length ? "" : "this model lists no voices; its default voice is used";
  }

  private async loadVoices() {
    const info = api.ttsInfo();
    this.voice.innerHTML = "";
    const label: Record<string, string> = { af: "US · female", am: "US · male", bf: "UK · female", bm: "UK · male" };
    for (const v of info.voices as string[]) {
      const o = h("option", "", `${v.slice(3)}  (${label[v.slice(0, 2)] ?? v.slice(0, 2)})`);
      o.value = v;
      o.selected = v === settings.voice;
      this.voice.append(o);
    }
    this.speak.disabled = !info.available;
    if (!info.available) this.say("this browser can't run the speech model", "error");
  }

  close() {
    this.root.classList.remove("show");
  }

  private refresh() {
    const k = settings.openrouterKey;
    this.state.className = `key-state ${k ? "set" : ""}`;
    this.state.textContent = k
      ? `key set (${settings.hint()}) · ${settings.remembered ? "remembered on this device" : "this tab only"}`
      : "no key set: sessions can't start until you add one";
  }

  private say(text: string, kind: "" | "ok" | "error") {
    this.status.textContent = text;
    this.status.className = `editor-status ${kind}`;
  }

  private async saveKey() {
    const key = this.keyInput.value.trim();
    if (!key) {
      // only the remember choice changed
      if (settings.openrouterKey) {
        settings.setKey(settings.openrouterKey, this.remember.checked);
        this.refresh();
        this.say("saved", "ok");
      } else this.say("enter a key first", "error");
      return;
    }
    this.say("checking with OpenRouter…", "");
    try {
      const body = await api.checkKey(key);
      if (!body.ok) {
        this.say(`not saved: ${body.detail}`, "error");
        return;
      }
      settings.setKey(key, this.remember.checked);
      this.keyInput.value = "";
      this.refresh();
      this.say(`saved · ${body.detail}`, "ok");
      this.onChanged();
    } catch (e) {
      this.say(`check failed: ${e}`, "error");
    }
  }
}
