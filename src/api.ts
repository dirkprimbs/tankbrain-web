// What used to be the server of Norbert, the brain, now running inside the page: the same
// operations with the same answers, backed by this browser's IndexedDB and by
// OpenRouter. Nothing here talks to any server other than OpenRouter (models)
// and Hugging Face (the speech model download).

import { Brain, newSessionId } from "./engine/brain";
import * as config from "./engine/config";
import { EventLog } from "./engine/events";
import { OpenRouterLLM, type CloudModel } from "./engine/llm";
import { LongTermMemory } from "./engine/memory/longterm";
import { forgetEverything, openStore, type EventRow, type Store } from "./engine/store";
import { exportSession as exportFile, forgetDemoMemories, importDemos, importSession, type SessionFile } from "./engine/sessionfile";
import { exportState as exportStateFile, importState as importStateFile, isStateFile } from "./engine/statefile";
import { settings } from "./settings";
import { OpenRouterSpeech, type SpeechModel } from "./speech/openrouter";
export type SpeechModelInfo = SpeechModel;
import { kokoroEngine, KokoroSynth, SpeechStore } from "./speech/synth";
import { chunkName, clampSpeed, DEFAULT_VOICE, speechPlan, type SpeechSpec } from "./speech/text";

/** Same role as an HTTP error from the server: a status and a readable detail. */
export class ApiError extends Error {
  constructor(public status: number, public detail: string) {
    super(detail);
  }
}

export const VOICES = [
  "af_alloy", "af_aoede", "af_bella", "af_heart", "af_jessica", "af_kore", "af_nicole", "af_nova", "af_river",
  "af_sarah", "af_sky", "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam", "am_michael", "am_onyx",
  "am_puck", "am_santa", "bf_alice", "bf_emma", "bf_isabella", "bf_lily", "bm_daniel", "bm_fable", "bm_george",
  "bm_lewis",
];

let db: Store;
let log: EventLog;
let ltm: LongTermMemory;
let speech: SpeechStore;
export const synth = new KokoroSynth();
const tts = new OpenRouterSpeech(() => settings.openrouterKey);
let speechModelList: { at: number; list: SpeechModel[] | null } = { at: 0, list: null };
const state: { brain: Brain | null; session: string | null; task: Promise<unknown> | null } =
  { brain: null, session: null, task: null };
let cloudModels: { at: number; list: CloudModel[] | null } = { at: 0, list: null };
// key from this browser's settings, read at the moment of each request
const openrouter = new OpenRouterLLM(() => settings.openrouterKey);
const llm = openrouter;

export async function init(): Promise<void> {
  db = await openStore();
  log = new EventLog(db);
  await log.markInterrupted(); // anything still "running" was cut off when the page closed
  await importDemos(db);        // example sessions shipped with the page (public/demos/)
  await forgetDemoMemories(db);
  ltm = new LongTermMemory(db, (t) => openrouter.embed(t));
  await ltm.seed((await config.load("dirksdefault", db)).self); // a fresh brain's core beliefs
  speech = new SpeechStore(db, { kokoro: kokoroEngine(synth), openrouter: tts });
}

const running = () => (state.task ? state.session : null);

// --- config & profiles --------------------------------------------------------
export async function getConfig(profile = "diverse") {
  const profiles = await config.listProfiles(db);
  if (!profiles.includes(profile)) throw new ApiError(404, "unknown profile");
  const cfg = await config.load(profile, db);
  return {
    profile,
    profiles: profiles.filter((p) => p !== "fake"),
    agents: [...cfg.agents.values()].map(config.publicView),
    disabled: [...cfg.disabled.values()].map(config.publicView),
    builtin: config.builtinProfiles(),
    cycle: cfg.cycle,
    energy: cfg.energy,
    topics: cfg.topics,
    input_pos: cfg.input_pos,
    running: running(),
    memories: await ltm.count(),
  };
}

/** All voices as a profile file (YAML), as the editor shows them, saved or not. */
export async function exportProfile(body: { voices: Record<string, config.VoiceSettings>; note?: string; based_on?: config.ProfileParent }): Promise<Blob> {
  try {
    const yaml = await config.profileYaml(db, body.voices, body.note ?? "", body.based_on ?? null);
    return new Blob([yaml], { type: "application/yaml" });
  } catch (e) {
    throw new ApiError(400, (e as Error).message);
  }
}

/** Read a profile file for the editor: its voices, a suggested name, and its text. */
export async function readProfileFile(f: File) {
  const text = await f.text();
  try {
    const cfg = await config.readProfileFile(text, db);
    return {
      name: config.profileNameFromFile(f.name),
      yaml: text,
      agents: [...cfg.agents.values()].map(config.publicView),
      disabled: [...cfg.disabled.values()].map(config.publicView),
    };
  } catch (e) {
    throw new ApiError(400, (e as Error).message);
  }
}

export async function saveProfile(name: string, body: { voices: Record<string, config.VoiceSettings>; note?: string; based_on?: config.ProfileParent }) {
  try {
    const cfg = await config.saveProfile(db, name, body.voices, body.note ?? "", body.based_on ?? null);
    return { profile: name, voices: cfg.agents.size, disabled: [...cfg.disabled.keys()].sort() };
  } catch (e) {
    throw new ApiError(400, (e as Error).message);
  }
}

/** Hosted models that support enforced JSON output (OpenRouter's public list, cached for an hour). */
export async function models() {
  const out: { cloud: CloudModel[]; cloud_error: string | null } = { cloud: [], cloud_error: null };
  if (!cloudModels.list || Date.now() - cloudModels.at > 3_600_000) {
    try {
      cloudModels = { list: await openrouter.models(), at: Date.now() };
    } catch (e) {
      out.cloud_error = `OpenRouter model list unavailable: ${e}`;
    }
  }
  out.cloud = cloudModels.list ?? [];
  return out;
}

export async function checkKey(key: string) {
  key = key.trim();
  if (!key) throw new ApiError(400, "no key given");
  const [ok, detail] = await openrouter.checkKey(key);
  return { ok, detail };
}

// --- sessions -------------------------------------------------------------------
export interface InspireBody {
  text: string;
  profile: string;
  cloud_concurrency: number;
  speak: boolean;
  speech: SpeechSpec;
}

function checkSpeech(spec: SpeechSpec): SpeechSpec {
  if (spec.engine === "kokoro" && !VOICES.includes(spec.voice)) throw new ApiError(400, `unknown voice ${JSON.stringify(spec.voice)}`);
  if (spec.engine === "openrouter" && (!spec.model || !spec.voice)) throw new ApiError(400, "pick a speech model and voice in Settings");
  return { ...spec, speed: clampSpeed(spec.speed) };
}

export async function inspire(body: InspireBody): Promise<{ session: string }> {
  if (state.task) throw new ApiError(409, "already thinking");
  if (!body.text.trim()) throw new ApiError(400, "empty inspiration");
  if (!(await config.listProfiles(db)).includes(body.profile)) throw new ApiError(404, "unknown profile");
  const cfg = await config.load(body.profile, db);
  if (!settings.openrouterKey && body.profile !== "fake") {
    throw new ApiError(400, "the voices run on OpenRouter, but no key is set in this browser (⚙ Settings)");
  }
  if (!(body.cloud_concurrency >= 1 && body.cloud_concurrency <= 16)) throw new ApiError(400, "cloud concurrency must be 1..16");
  openrouter.embedModel = cfg.embed_model;
  ltm.owner = config.owner(cfg, "remember") ?? "Recall";
  let audio = null;
  if (body.speak) {
    let spec = body.speech;
    // no key: OpenRouter can't speak, so Kokoro in the browser does
    if (spec.engine === "openrouter" && !settings.openrouterKey) spec = { engine: "kokoro", voice: settings.voice, speed: spec.speed, model: "", style: "" };
    audio = speech.channel(checkSpeech(spec));
  }
  const brain = new Brain(cfg, llm, log, ltm, body.cloud_concurrency, audio);
  const session = newSessionId();
  state.brain = brain;
  state.session = session;
  const alive = setInterval(() => log.heartbeat(session), 10_000);
  state.task = brain.run(body.text, session)
    .catch(() => { /* already logged as an error event */ })
    .finally(() => {
      clearInterval(alive);
      state.task = state.brain = state.session = null;
    });
  return { session };
}

export function stop(): { stopped: string | null } {
  if (state.brain && state.task) {
    state.brain.stop();
    return { stopped: state.session };
  }
  return { stopped: null };
}

export const sessions = () => log.sessions();
export const events = (session: string) => log.events(session);
/** Live events, in place of the server's WebSocket. */
export const subscribe = (fn: (e: EventRow) => void) => log.subscribe(fn);

// --- speech ---------------------------------------------------------------------
export function ttsInfo() {
  return { available: typeof Worker !== "undefined", voices: VOICES, default: DEFAULT_VOICE, engine: "Kokoro (in this browser)" };
}

/** OpenRouter's speech models with their voices (cached for an hour). */
export async function speechModels(): Promise<SpeechModel[]> {
  if (!speechModelList.list || Date.now() - speechModelList.at > 3_600_000) {
    speechModelList = { list: await tts.models(), at: Date.now() };
  }
  return speechModelList.list!;
}

export function ttsPreview(spec: SpeechSpec): Promise<string> {
  return speech.preview(checkSpeech(spec));
}

/** Chunk keys for speaking a past session's reply; each chunk is made on first request. */
export async function speechFor(session: string, spec: SpeechSpec) {
  const row = await log.session(session);
  if (!row || !row.answer) throw new ApiError(404, "this session has no reply to speak");
  spec = checkSpeech(spec);
  const plan = speechPlan(row.answer);
  return Promise.all(plan.map(async (t, i) => ({ url: `${session}/${await chunkName(spec, i, t)}`, text: t })));
}

const CHUNK = /^([a-z]{2}_[a-z]+)_(\d\.\d)_(\d{1,3})_([0-9a-f]{8})\.(wav)$/;

/** A playable URL for an audio chunk key ("<session>/<name>"); made on demand
 * for sessions spoken after the fact, with the speech settings of this browser. */
export function audioUrl(key: string): Promise<string> {
  return speech.url(key, async () => {
    const [session, name] = key.split("/");
    const m = CHUNK.exec(name ?? "");
    if (!m) return null;
    const speed = Number(m[2]), index = Number(m[3]);
    const current = settings.speechSpec();
    const spec: SpeechSpec = m[1] === "or_tts" ? { ...current, engine: "openrouter", speed }
      : { engine: "kokoro", voice: m[1], speed, model: "", style: "" };
    if (spec.engine === "kokoro" && !VOICES.includes(spec.voice)) return null;
    const row = await log.session(session);
    // the reply is said in the mood the Voice gave it
    const mood = (await log.events(session)).find((e) => e.kind === "output")?.data?.delivery;
    if (spec.engine === "openrouter" && mood) spec.mood = String(mood);
    const plan = row?.answer ? speechPlan(row.answer) : [];
    if (index >= plan.length || name !== (await chunkName(spec, index, plan[index]))) return null;
    return { text: plan[index], spec };
  });
}

/** Delete every session, memory, saved profile and recording kept in this browser. */
export async function forgetAll(): Promise<void> {
  if (state.task) throw new ApiError(409, "a session is running; stop it first");
  await forgetEverything();
  await importDemos(db); // the shipped example sessions come back
  await ltm.seed((await config.load("dirksdefault", db)).self); // and a fresh brain is Norbert again
}

/** A session as a portable file, for replaying (events and spoken audio). */
export async function exportSession(id: string): Promise<Blob> {
  const file = await exportFile(db, id);
  return new Blob([JSON.stringify(file)], { type: "application/json" });
}

/** Add a session file (exported from this or another browser). */
export async function importFile(f: File): Promise<string> {
  let file: SessionFile;
  try {
    file = JSON.parse(await f.text());
  } catch {
    throw new ApiError(400, "that file isn't JSON");
  }
  try {
    const added = await importSession(db, file);
    return added ? `imported "${file.session.question.slice(0, 60)}"` : "that session is already here";
  } catch (e) {
    throw new ApiError(400, (e as Error).message);
  }
}

// --- the whole state --------------------------------------------------------------
const SETTING = /^tankbrain\./;
const SECRET = "tankbrain.openrouterKey"; // never leaves this browser in a file

/** Everything this brain is: sessions, memories, profiles and settings (not the key). */
export async function exportState(): Promise<Blob> {
  const prefs: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)!;
    if (SETTING.test(k) && k !== SECRET) prefs[k] = localStorage.getItem(k)!;
  }
  return new Blob([JSON.stringify(await exportStateFile(db, prefs))], { type: "application/json" });
}

/** Replace this brain's whole state with a state file. The key stays as it is. */
export async function importState(f: File): Promise<string> {
  if (state.task) throw new ApiError(409, "wait until the brain has finished thinking");
  let file: unknown;
  try {
    file = JSON.parse(await f.text());
  } catch {
    throw new ApiError(400, "not a JSON file");
  }
  if (!isStateFile(file)) throw new ApiError(400, "not a state file of Norbert, the brain (to add a single session, use import… in the session list)");
  const n = await importStateFile(db, file);
  for (const [k, v] of Object.entries(file.settings ?? {})) if (SETTING.test(k) && k !== SECRET) localStorage.setItem(k, String(v));
  return `restored ${n.sessions} sessions, ${n.memories} memories and ${n.profiles} saved profiles`;
}

/** The long-term memories, strongest first (for looking at, not for the brain). */
export async function memoryList() {
  return (await ltm.all()).sort((a, b) => Number(b.pinned) - Number(a.pinned) || Number(b.verbatim) - Number(a.verbatim) || b.weight - a.weight)
    .map(({ embedding: _e, ...m }) => m);
}

