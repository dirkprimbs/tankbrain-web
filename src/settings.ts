// Client-side settings: they live in this browser only. The OpenRouter key is
// sent only to OpenRouter, with the requests the voices make.

import { DEFAULT_STYLE, DEFAULT_TTS_MODEL, DEFAULT_TTS_VOICE } from "./speech/openrouter";
import type { SpeechSpec } from "./speech/text";

const KEY = "tankbrain.openrouterKey";
const CONC = "tankbrain.cloudConcurrency";
const SPEAK = "tankbrain.speak";
const VOICE = "tankbrain.voice";
const SPEED = "tankbrain.speed";
const MUTED = "tankbrain.muted";
const ENGINE = "tankbrain.speechEngine";
const TTS_MODEL = "tankbrain.ttsModel";
const TTS_VOICE = "tankbrain.ttsVoice";
const STYLE = "tankbrain.speechStyle";

function store(): Storage {
  // "remember on this device" = localStorage; otherwise only for this tab
  return localStorage.getItem(KEY) !== null ? localStorage : sessionStorage;
}

export const settings = {
  get openrouterKey(): string {
    return localStorage.getItem(KEY) ?? sessionStorage.getItem(KEY) ?? "";
  },
  get remembered(): boolean {
    return localStorage.getItem(KEY) !== null;
  },
  setKey(key: string, remember: boolean) {
    localStorage.removeItem(KEY);
    sessionStorage.removeItem(KEY);
    if (key) (remember ? localStorage : sessionStorage).setItem(KEY, key);
  },
  get cloudConcurrency(): number {
    const n = Number(store().getItem(CONC) ?? localStorage.getItem(CONC) ?? 4);
    return Number.isFinite(n) && n >= 1 && n <= 16 ? n : 4;
  },
  setCloudConcurrency(n: number) {
    localStorage.setItem(CONC, String(Math.min(16, Math.max(1, Math.round(n)))));
  },
  // --- speech (all local to this browser)
  get speak(): boolean {
    return localStorage.getItem(SPEAK) !== "off";
  },
  set speak(on: boolean) {
    localStorage.setItem(SPEAK, on ? "on" : "off");
  },
  /** "openrouter" (a hosted speech model) or "kokoro" (in this browser). */
  get speechEngine(): "openrouter" | "kokoro" {
    return localStorage.getItem(ENGINE) === "kokoro" ? "kokoro" : "openrouter";
  },
  set speechEngine(e: "openrouter" | "kokoro") {
    localStorage.setItem(ENGINE, e);
  },
  get ttsModel(): string {
    return localStorage.getItem(TTS_MODEL) ?? DEFAULT_TTS_MODEL;
  },
  set ttsModel(m: string) {
    localStorage.setItem(TTS_MODEL, m);
  },
  get ttsVoice(): string {
    return localStorage.getItem(TTS_VOICE) ?? DEFAULT_TTS_VOICE;
  },
  set ttsVoice(v: string) {
    localStorage.setItem(TTS_VOICE, v);
  },
  get speechStyle(): string {
    return localStorage.getItem(STYLE) ?? DEFAULT_STYLE;
  },
  set speechStyle(t: string) {
    localStorage.setItem(STYLE, t.trim().slice(0, 600));
  },
  /** Kokoro's voice. */
  get voice(): string {
    return localStorage.getItem(VOICE) ?? "af_heart";
  },
  set voice(v: string) {
    localStorage.setItem(VOICE, v);
  },
  get speed(): number {
    const n = Number(localStorage.getItem(SPEED) ?? 1);
    return Number.isFinite(n) && n >= 0.5 && n <= 2 ? n : 1;
  },
  set speed(n: number) {
    localStorage.setItem(SPEED, String(Math.round(Math.min(2, Math.max(0.5, n)) * 10) / 10));
  },
  get muted(): boolean {
    return localStorage.getItem(MUTED) === "1";
  },
  set muted(m: boolean) {
    localStorage.setItem(MUTED, m ? "1" : "0");
  },
  /** Everything that decides how replies sound, from the settings above. */
  speechSpec(): SpeechSpec {
    const kokoro = this.speechEngine === "kokoro";
    return { engine: this.speechEngine, voice: kokoro ? this.voice : this.ttsVoice, speed: this.speed,
             model: kokoro ? "" : this.ttsModel, style: kokoro ? "" : this.speechStyle };
  },
  hint(): string {
    const k = this.openrouterKey;
    return k.length >= 8 ? `…${k.slice(-4)}` : "";
  },
};
