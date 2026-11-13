import "@fontsource/orbitron/500.css";
import "@fontsource/orbitron/800.css";
import "@fontsource/rajdhani/400.css";
import "@fontsource/rajdhani/600.css";
import "@fontsource/share-tech-mono/400.css";
import "./style.css";
import { TankScene } from "./scene";
import { Stream } from "./stream";
import { DraftView } from "./draftview";
import { VoiceEditor } from "./editor";
import { VoiceCard } from "./voicecard";
import { SettingsWindow } from "./settingswin";
import { AboutWindow } from "./about";
import { MemoryWindow } from "./memorywin";
import { settings } from "./settings";
import * as api from "./api";
import { finishSignIn, startSignIn } from "./signin";
import { VERSION, SEEN, changelog, whatsNew, showChangelog } from "./changelog";
import { VoicePlayer } from "./player";
import type { AgentInfo, ConfigInfo, SessionInfo, TankEvent } from "./types";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const scene = new TankScene($("stage"));
const stream = new Stream($("stream"), $("chips"), $("toggles"));
const editor = new VoiceEditor();
const card = new VoiceCard();
const player = new VoicePlayer();
let speechUrls: string[] = [];        // audio chunks of the session on screen
let speaker = "Voice";
stream.onFilterChange = (f) => {
  scene.setDimmed(f.hidden);
  card.hidden = f.hidden;
};
stream.onConfigure = (name) => editor.open(ui.profile.value, name, true);
// on the brain: hover = info card, click = adjust, shift = solo, ctrl/cmd = hide/show
scene.onRegionHover = (name, el) => (name ? card.show(name, el) : card.hide());
scene.onRegionClick = (name, ev) => {
  card.hide();
  if (ev.shiftKey) stream.toggleAgent(name, true);
  else if (ev.ctrlKey || ev.metaKey) stream.toggleAgent(name);
  else editor.open(ui.profile.value, name, true);
};

const ui = {
  input: $<HTMLTextAreaElement>("inspiration"),
  go: $<HTMLButtonElement>("go"),
  stop: $<HTMLButtonElement>("stop"),
  profile: $<HTMLSelectElement>("profile"),
  phase: $("phase"),
  cycle: $("cycle"),
  model: $("model"),
  energyBar: $("energy-bar"),
  energyVal: $("energy-val"),
  question: $("question"),
  sessions: $("sessions"),
  notebook: $("notebook"),
  reply: $("reply"),
  replyCard: $("reply-card"),
  speed: $<HTMLSelectElement>("speed"),
  mode: $("mode"),
  dock: $("dock"),
};

let current = "";          // session being shown
// --- spoken reply ------------------------------------------------------------
const muteBtn = document.getElementById("mute")!;
const playBtn = document.getElementById("reply-play")!;
function showMute() {
  muteBtn.textContent = settings.muted ? "🔇" : "🔊";
  muteBtn.title = settings.muted ? "Spoken replies: muted (click to unmute)" : "Spoken replies: on (click to mute)";
  muteBtn.classList.toggle("muted", settings.muted);
}
muteBtn.addEventListener("click", () => {
  settings.muted = !settings.muted;
  if (settings.muted) player.stop();
  else player.unlock();
  showMute();
});
showMute();
player.onLevel = (level) => scene.flash(speaker, Math.min(1, level));
player.onState = (playing) => {
  playBtn.textContent = playing ? "■ stop" : "▶ hear it";
  replyShow.classList.toggle("speaking", playing); // visible even when the reply window is closed
};
// the reply window can be closed while the voice goes on; these bring it back
const replyShow = $<HTMLButtonElement>("reply-show");
function setReplyAvailable(on: boolean) {
  replyShow.disabled = !on;
  replyShow.title = on ? "Show the spoken reply" : "No reply yet";
}
replyShow.addEventListener("click", () => {
  if (ui.replyCard.classList.contains("show")) closeReply();
  else ui.replyCard.classList.add("show");
});
$("stream").addEventListener("click", (ev) => {
  if ((ev.target as HTMLElement).closest(".msg.output") && ui.reply.textContent) ui.replyCard.classList.add("show");
});
player.onBlocked = () => alertLine("⚠ the browser blocked sound: click ▶ hear it to play the reply");
/** Speak a session's reply in its current chunking (recorded chunks are reused, the rest made on demand). */
async function speakSession(session: string) {
  let plan: { url: string }[];
  try {
    plan = await api.speechFor(session, settings.speechSpec());
  } catch (e) {
    return alertLine(`⚠ ${(e as api.ApiError).detail ?? e}`);
  }
  if (session !== current) return;
  player.stop();
  for (const c of plan) player.enqueue(c.url);
}
player.resolve = api.audioUrl;
// the speech model downloads once (~90 MB) and is then cached by the browser
let modelLine: HTMLElement | null = null;
api.synth.onProgress = (f) => {
  if (!modelLine) {
    modelLine = document.createElement("div");
    modelLine.className = "sysline";
    $("stream").appendChild(modelLine);
  }
  modelLine.textContent = f < 1 ? `loading the speech model (first time only): ${Math.round(f * 100)}%` : "speech model loaded";
  if (f >= 1) modelLine = null;
};
playBtn.addEventListener("click", async () => {
  player.unlock();
  if (player.playing) return silence();
  voiceDismissed = false;
  // the audio recorded with the session if there is any (demos have no key to make new audio)
  if (speechUrls.length) for (const u of speechUrls) player.enqueue(u);
  else if (current) await speakSession(current);
});
let limits = { max_cycles: 10, wrap_cycles: 4, threshold: 0.3 };
const PHASE_LABEL: Record<string, string> = { think: "THINKING", wrapup: "WRAPPING UP", speak: "SPEAKING" };
let mode: "idle" | "live" | "replay" = "idle";
let replayToken = 0;
let replayHasAudio = false; // the session being replayed has recorded speech
const draft = new DraftView($("draft-text"), $("draft-meta"), $<HTMLInputElement>("draft-slider"), $("draft-ver"),
  $<HTMLInputElement>("draft-changes"));
const seen = new Set<string>();

// --- helpers -----------------------------------------------------------
/** The floor: every voice thinking right now (several at once with hosted models). */
const thinking = new Map<string, string>();
function showFloor() {
  const names = [...thinking.keys()];
  ui.model.textContent = !names.length ? "—" : names.length === 1 ? `${names[0]} · ${thinking.get(names[0])}` : names.join(", ");
  ui.model.title = [...thinking].map(([n, m]) => `${n}: ${m}`).join("\n");
}
function setMode(m: typeof mode) {
  mode = m;
  ui.mode.textContent = { idle: "STANDBY", live: "LIVE", replay: "REPLAY" }[m];
  ui.mode.className = `mode ${m}`;
  const busy = m === "live";
  ui.go.disabled = busy;
  ui.stop.disabled = !busy;
}

function setEnergy(level: number) {
  scene.setEnergy(level);
  ui.energyBar.style.width = `${Math.round(level * 100)}%`;
  ui.energyVal.textContent = `${Math.round(level * 100)}%`;
  ui.energyBar.classList.toggle("low", level < limits.threshold + 0.05);
}

function showAgents(agents: AgentInfo[], inputPos?: number[]) {
  scene.setAgents(agents, inputPos);
  stream.setAgents(agents);
  card.setAgents(agents);
  draft.agents = new Map(agents.map((a) => [a.name, a]));
}

// --- mood ---------------------------------------------------------------
let resting = new Set<string>();
function showMood(m: { valence: number; arousal: number; word: string }) {
  $("mood").textContent = m.word;
  const dot = $("mood-dot");
  // hue from unpleasant (red) through neutral (amber) to pleasant (green); stirred up pulses faster
  dot.style.setProperty("--hue", String(Math.round(10 + (m.valence + 1) * 55)));
  dot.style.setProperty("--speed", `${(2.6 - m.arousal * 2).toFixed(2)}s`);
  $("mood-stat").dataset.valence = m.valence.toFixed(2);
}
async function showCurrentMood() {
  showMood(await api.currentMood());
}

function reset() {
  stream.clear();
  player.stop();
  speechUrls = [];
  draft.reset();
  ui.notebook.innerHTML = `<div class="empty">— empty —</div>`;
  ui.reply.textContent = "";
  ui.replyCard.classList.remove("show");
  setReplyAvailable(false);
  voiceDismissed = false;
  ui.cycle.textContent = "0";
  ui.phase.textContent = "—";
  thinking.clear();
  showFloor();
  setEnergy(1);
  resting = new Set();
  scene.setResting(resting);
  for (const r of scene.regions.values()) scene.activate(r.agent.name, false);
}

// --- event handling ----------------------------------------------------
function handle(e: TankEvent) {
  const key = `${e.session}:${e.seq}`;
  if (seen.has(key)) return;
  seen.add(key);
  const d = e.data;
  if (e.kind === "session_start") {
    current = e.session;
    reset();
    showAgents(d.agents, d.input_pos);
    ui.question.textContent = d.question;
  } else if (e.session !== current) {
    return;
  }
  stream.add(e);
  card.track(e);
  switch (e.kind) {
    case "input":
      scene.pulseInput(d.recipients);
      break;
    case "turn_start":
      scene.activate(e.agent!, true);
      thinking.set(e.agent!, d.model);
      showFloor();
      break;
    case "model_switch":
      scene.activate(e.agent!, true, true);
      break;
    case "turn_end":
      thinking.delete(e.agent!);
      showFloor();
      scene.activate(e.agent!, false);
      break;
    case "post":
      scene.pulse(e.agent!, d.recipients ?? [], "post");
      break;
    case "dm":
      scene.pulse(e.agent!, [d.to], "dm");
      break;
    case "signal":
      for (const name of e.agent ? [e.agent] : d.to ?? []) scene.flash(name, 1);
      break;
    case "draft":
      draft.add(d);
      ui.dock.dataset.tab = ui.dock.dataset.tab || "draft";
      break;
    case "memory_stored":
      $("mem-count").textContent = String(d.total);
      if (memoryWin.isOpen) memoryWin.refresh();
      break;
    case "memory":
      ui.notebook.innerHTML = "";
      for (const i of d.items) {
        const row = document.createElement("div");
        row.className = `nb ${i.kind} ${i.status}`;
        row.innerHTML = `<span class="k"></span><span class="t"></span>`;
        row.querySelector(".k")!.textContent = `${i.status === "done" ? "✓" : "○"} ${i.kind}`;
        row.querySelector(".t")!.textContent = i.text;
        ui.notebook.appendChild(row);
      }
      break;
    case "mood":
      showMood(d);
      if (e.agent) scene.flash(e.agent, 0.9);
      break;
    case "initiative":
      for (const n of d.spoke ?? []) resting.delete(n);
      scene.setResting(resting);
      for (const n of d.spoke ?? []) scene.flash(n, 1);
      break;
    case "recruited":
      if (d.woken) resting.delete(d.woken);
      else resting = new Set(d.asleep ?? []);
      scene.setResting(resting);
      break;
    case "energy":
    case "interest":
      setEnergy(d.level);
      break;
    case "cycle":
      ui.cycle.textContent = d.wrap ? `${d.n} · wrap-up` : `${d.n}/${limits.max_cycles}`;
      break;
    case "phase":
      ui.phase.textContent = PHASE_LABEL[d.phase] ?? String(d.phase).toUpperCase();
      ui.phase.title = d.reason ? `why: ${d.reason}` : "";
      break;
    case "verdict":
      scene.flash(e.agent!, 1);
      break;
    case "audio":
      speechUrls.push(d.url);
      const replaying = mode === "replay" && ui.speed.value !== "instant";
      if (!settings.muted && !voiceDismissed && (mode === "live" || replaying)) player.enqueue(d.url);
      break;
    case "output":
      if (e.agent) speaker = e.agent;
      ui.reply.textContent = d.text;
      ui.replyCard.classList.add("show");
      setReplyAvailable(true);
      if (e.agent) scene.pulseOutput(e.agent);
      // a replay plays the recorded audio as its events come; only without any is it spoken now
      if (mode === "replay" && !replayHasAudio && !settings.muted && ui.speed.value !== "instant" && current) speakSession(current);
      break;
    case "session_end":
      ui.phase.textContent = d.cancelled ? "CANCELLED" : "DONE";
      thinking.clear();
      showFloor();
      for (const r of scene.regions.values()) scene.activate(r.agent.name, false);
      if (mode === "live") setMode("idle");
      loadSessions();
      break;
  }
}

// --- live --------------------------------------------------------------
function connect() {
  api.subscribe((e) => {
    if (e.kind === "session_start") {
      replayToken++;          // a live session interrupts any replay
      setMode("live");
    }
    if (mode === "live") handle(e as TankEvent);
  });
}

async function inspire() {
  const text = ui.input.value.trim();
  if (!text) return;
  ui.go.disabled = true;
  player.unlock();  // this click lets the browser play the reply later
  try {
    await api.inspire({ text, profile: ui.profile.value, cloud_concurrency: settings.cloudConcurrency,
      speak: settings.speak, speech: settings.speechSpec() });
  } catch (e) {
    ui.go.disabled = false;
    alertLine(`⚠ ${(e as api.ApiError).detail ?? e}`);
  }
}

/** No key yet: offer to sign in with OpenRouter, or to paste a key in Settings. */
function askForKey() {
  const back = document.createElement("div");
  back.className = "editor-backdrop show";
  const box = document.createElement("div");
  box.className = "editor settings keyask";
  box.innerHTML = `<div class="editor-head"><h2>OPENROUTER</h2></div><div class="settings-body">
    <p>The voices think with models hosted on OpenRouter, paid from your own OpenRouter account.
    Sign in there and approve a key for Norbert, the brain: it stays in this browser and goes only to OpenRouter.</p>
    <p class="settings-note">Have a key already? Paste it in Settings. Without one you can still replay the demo sessions.</p>
    <div class="row"><button class="primary" data-a="signin">SIGN IN WITH OPENROUTER</button>
    <button class="ghost" data-a="yes">paste a key</button>
    <button class="ghost" data-a="no">not now</button></div></div>`;
  back.append(box);
  document.body.append(back);
  const close = () => back.remove();
  box.querySelector('[data-a="signin"]')!.addEventListener("click", () => startSignIn());
  box.querySelector('[data-a="yes"]')!.addEventListener("click", () => {
    close();
    settingsWin.open();
  });
  box.querySelector('[data-a="no"]')!.addEventListener("click", () => {
    close();
    alertLine("No OpenRouter key: add it any time in ⚙ Settings (it stays in this browser).");
  });
  back.addEventListener("mousedown", (e) => { if (e.target === back) close(); });
}

function alertLine(t: string, kind: "error" | "ok" = "error") {
  const n = document.createElement("div");
  n.className = kind === "error" ? "sysline error" : "sysline";
  n.textContent = t;
  $("stream").appendChild(n);
}

ui.go.addEventListener("click", inspire);
ui.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) inspire();
});
ui.stop.addEventListener("click", () => {
  silence(); // stopping the session stops its voice too
  api.stop();
});

// --- replay ------------------------------------------------------------
async function replay(id: string) {
  if (mode === "live") return;
  player.unlock();
  const token = ++replayToken;
  setMode("replay");
  const events = (await api.events(id)) as TankEvent[];
  replayHasAudio = events.some((e) => e.kind === "audio");
  for (const e of events) seen.delete(`${e.session}:${e.seq}`);
  const speed = ui.speed.value;
  for (let i = 0; i < events.length; i++) {
    if (token !== replayToken) return;
    handle(events[i]);
    if (speed !== "instant" && i + 1 < events.length) {
      const gap = Math.min(events[i + 1].ts - events[i].ts, 2.5) / Number(speed);
      if (gap > 0.01) await new Promise((r) => setTimeout(r, gap * 1000));
    }
  }
  if (token === replayToken) setMode("idle");
}

async function loadSessions() {
  const list: SessionInfo[] = await api.sessions();
  ui.sessions.innerHTML = "";
  for (const s of list) {
    const item = document.createElement("div");
    item.className = "session-item";
    const b = document.createElement("button");
    b.className = `session ${s.status}`;
    const when = new Date(s.started * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    b.innerHTML = `<span class="q"></span><span class="w"></span>`;
    b.querySelector(".q")!.textContent = s.question;
    b.querySelector(".w")!.textContent = `${when} · ${s.profile} · ${s.status}`;
    b.addEventListener("click", () => replay(s.id));
    const ex = document.createElement("button");
    ex.className = "ghost export";
    ex.textContent = "⤓";
    ex.title = "export this session as a file, to replay elsewhere (events and spoken audio)";
    ex.addEventListener("click", () => exportSession(s.id, s.question));
    item.append(b, ex);
    ui.sessions.appendChild(item);
  }
}

async function exportSession(id: string, question: string) {
  const blob = await api.exportSession(id);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  const slug = question.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40).replace(/^-|-$/g, "");
  a.download = `tankbrain-${slug || "session"}-${id}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}
const importInput = $<HTMLInputElement>("import-file");
$("import").addEventListener("click", () => importInput.click());
importInput.addEventListener("change", async () => {
  const f = importInput.files?.[0];
  importInput.value = "";
  if (!f) return;
  try {
    alertLine(await api.importFile(f));
    loadSessions();
    $("mem-count").textContent = String((await api.getConfig(ui.profile.value)).memories);
  } catch (e) {
    alertLine(`⚠ ${(e as api.ApiError).detail ?? e}`);
  }
});

// --- dock tabs ---------------------------------------------------------
for (const t of document.querySelectorAll<HTMLElement>("[data-tab-btn]")) {
  t.addEventListener("click", () => (ui.dock.dataset.tab = t.dataset.tabBtn));
}
// closing the reply stops the voice; minimizing it lets the voice go on
let voiceDismissed = false; // stopped or closed this reply: later chunks of it are not played either
/** Stop the spoken reply for good: chunks of it still being made or replayed aren't played either. */
function silence() {
  voiceDismissed = true;
  // stopping the reply partway tells the brain it went on too long
  const key = player.currentKey;
  if (key) api.noteStopped(key).catch(() => {});
  player.stop();
}
function closeReply() {
  replySize("");
  ui.replyCard.classList.remove("show");
  silence();
}
$("reply-close").addEventListener("click", closeReply);
// minimize to the title bar / maximize to a large reading view
const replyMin = $("reply-min"), replyMax = $("reply-max");
function replySize(size: "" | "min" | "max") {
  ui.replyCard.classList.toggle("min", size === "min");
  ui.replyCard.classList.toggle("max", size === "max");
  replyMin.textContent = size === "min" ? "▴" : "–";
  replyMin.title = size === "min" ? "Restore" : "Minimize";
  replyMax.textContent = size === "max" ? "❐" : "□";
  replyMax.title = size === "max" ? "Restore" : "Maximize";
}
replyMin.addEventListener("click", () => replySize(ui.replyCard.classList.contains("min") ? "" : "min"));
replyMax.addEventListener("click", () => replySize(ui.replyCard.classList.contains("max") ? "" : "max"));

// --- example prompts -----------------------------------------------------
const EXAMPLES: [string, string][] = [
  ["Trick question: the bat and the ball", "A bat and a ball cost $1.10 in total. The bat costs $1.00 more than the ball. How much does the ball cost?"],
  ["Logic: machines and widgets", "If it takes 5 machines 5 minutes to make 5 widgets, how long would it take 100 machines to make 100 widgets?"],
  ["Science: sky and sunsets", "Why is the sky blue, but sunsets are red?"],
  ["Explain: vaccines for a ten-year-old", "Explain how vaccines work to a curious ten-year-old."],
  ["Story: a robot discovers music", "Tell me a short story about a robot who discovers music."],
  ["Creative: a weekend for almost nothing", "Give me five unusual ideas for a weekend with friends that costs almost nothing."],
  ["What if: two hours of sleep", "What would change if humans needed only two hours of sleep a night?"],
  ["Philosophy: the heavy stone", "Can God create a stone too heavy for him to lift?"],
  ["Mind: dreaming machines", "Why do we dream, and could a machine ever dream?"],
  ["Advice: big fish or small pond", "Is it better to be a big fish in a small pond or a small fish in a big pond?"],
];
const examples = $<HTMLSelectElement>("examples");
examples.append(new Option("✦ example prompts…", ""));
for (const [label, text] of EXAMPLES) examples.append(new Option(label, text));
examples.addEventListener("change", () => {
  if (!examples.value) return;
  ui.input.value = examples.value;
  examples.value = "";
  ui.input.focus();
});

// --- boot --------------------------------------------------------------
async function loadProfile(name: string) {
  const c: ConfigInfo = await api.getConfig(name);
  ui.profile.innerHTML = "";
  for (const p of c.profiles) {
    const o = document.createElement("option");
    o.value = o.textContent = p;
    o.selected = p === c.profile;
    ui.profile.append(o);
  }
  if (mode === "idle") showAgents(c.agents, c.input_pos);
  limits = { max_cycles: c.cycle.max_cycles, wrap_cycles: c.cycle.wrap_cycles, threshold: c.energy.threshold };
  $("energy-mark").style.left = `${limits.threshold * 100}%`;
  $("energy-mark").title = `thinking stops below ${Math.round(limits.threshold * 100)}%`;
  return c;
}

$("configure").addEventListener("click", () => editor.open(ui.profile.value));
const settingsWin = new SettingsWindow();
const about = new AboutWindow();
const memoryWin = new MemoryWindow();
$("memory").addEventListener("click", () => memoryWin.open());
$("mem-open").addEventListener("click", () => memoryWin.open());
settingsWin.onMemory = () => memoryWin.open();
$("about").addEventListener("click", () => about.open());
$("settings").addEventListener("click", () => settingsWin.open());
settingsWin.onPreview = () => player.stop();
settingsWin.onForgotten = () => {
  current = "";
  reset();
  ui.question.textContent = "";
  $("mem-count").textContent = "0";
  loadSessions();
  loadProfile("dirksdefault");
  showCurrentMood();
};
editor.onSaved = (name) => loadProfile(name);

/** The version next to the title; a returning visitor sees what's new since last time. */
async function announceVersion() {
  const btn = $("version");
  btn.textContent = `v${VERSION}`;
  btn.addEventListener("click", () => showChangelog(changelog(), "CHANGELOG"));
  const seen = localStorage.getItem(SEEN);
  const returning = seen !== null
    || Object.keys(localStorage).some((k) => k.startsWith("tankbrain."))
    || (await api.sessions()).some((s: SessionInfo) => !s.profile.startsWith("demo"));
  const news = whatsNew(changelog(), seen, returning);
  localStorage.setItem(SEEN, VERSION);
  if (news.length) showChangelog(news, "WHAT'S NEW");
}

async function boot() {
  await api.init();
  const cfg = await loadProfile("dirksdefault");
  showAgents(cfg.agents, cfg.input_pos);
  ui.profile.addEventListener("change", () => loadProfile(ui.profile.value));
  $("mem-count").textContent = String(cfg.memories);
  showCurrentMood();
  // between sessions the mood drifts back towards the temperament
  setInterval(() => { if (mode === "idle") showCurrentMood(); }, 10 * 60_000);
  setMode("idle");
  if (cfg.running) setMode("live");
  connect();
  loadSessions();
  // back from signing in on openrouter.ai?
  const signedIn = await finishSignIn();
  if (signedIn && "key" in signedIn) {
    settings.setKey(signedIn.key, true);
    alertLine("Signed in with OpenRouter: the key is saved in this browser (remove it any time in ⚙ Settings).", "ok");
  } else if (signedIn) {
    alertLine(`⚠ Sign-in with OpenRouter failed: ${signedIn.error}`);
  }
  if (!settings.openrouterKey) askForKey();
  await announceVersion(); // after the key question, so it opens on top
}
boot();
