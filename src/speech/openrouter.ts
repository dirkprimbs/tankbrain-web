// Speech from OpenRouter's text-to-speech endpoint (/audio/speech): a real
// TTS model reads each chunk verbatim; the speaking style goes into the
// delivery instructions, never into the text.

import { OPENROUTER } from "../engine/llm";
import type { SpeechSpec } from "./text";
import { wavBlob } from "./text";

export const DEFAULT_TTS_MODEL = "google/gemini-3.8-flash-tts";
export const DEFAULT_TTS_VOICE = "Puck";
export const DEFAULT_STYLE =
  "Warm, curious and expressive, like someone sharing an idea they find genuinely fascinating. " +
  "Vary pace and emphasis naturally.";
const PCM_RATE = 24000; // raw PCM from these providers: 16-bit mono, 24 kHz

export interface SpeechModel {
  id: string;
  name: string;
  voices: string[];
  price_in: number | null;  // per 1M input units, as OpenRouter lists it
  price_out: number | null;
}

function pace(speed: number): string {
  if (speed <= 0.8) return " Speak slowly.";
  if (speed < 1) return " Speak a little slower than usual.";
  if (speed >= 1.3) return " Speak quickly.";
  if (speed > 1) return " Speak a little faster than usual.";
  return "";
}

/** Delivery instructions: the chosen style plus the speed (not every model has a speed setting). */
export const instructions = (style: string, speed: number) => (style.trim() || DEFAULT_STYLE) + pace(speed);

export class OpenRouterSpeech {
  constructor(private key: () => string, private fetchFn: typeof fetch = (...a) => fetch(...a)) {}

  async synth(text: string, spec: SpeechSpec): Promise<{ wav: Blob; seconds: number }> {
    try {
      return await this.once(text, spec, "pcm");
    } catch (e) {
      // a few providers (e.g. MiniMax) only deliver mp3
      if ((e as Error).message.startsWith("OpenRouter 400")) return this.once(text, spec, "mp3");
      throw e;
    }
  }

  private async once(text: string, spec: SpeechSpec, format: "pcm" | "mp3"): Promise<{ wav: Blob; seconds: number }> {
    const key = this.key();
    if (!key) throw new Error("no OpenRouter key set (Settings)");
    const r = await this.fetchFn(`${OPENROUTER}/audio/speech`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "X-Title": "Tankbrain" },
      body: JSON.stringify({ model: spec.model, input: text, voice: spec.voice,
                             instructions: instructions(spec.style, spec.speed), response_format: format, speed: spec.speed }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!r.ok) {
      let msg = await r.text();
      try {
        msg = JSON.parse(msg)?.error?.message ?? msg;
      } catch { /* plain text */ }
      throw new Error(`OpenRouter ${r.status}: ${String(msg).slice(0, 200)}`);
    }
    const bytes = new Uint8Array(await r.arrayBuffer());
    if (!bytes.length) throw new Error("OpenRouter returned no audio");
    if ((r.headers.get("Content-Type") ?? "").includes("mpeg") || format === "mp3") {
      return { wav: new Blob([bytes], { type: "audio/mpeg" }), seconds: (bytes.length * 8) / 128_000 }; // ~128 kbit/s
    }
    const n = Math.floor(bytes.length / 2);
    const view = new DataView(bytes.buffer, bytes.byteOffset, n * 2);
    const samples = new Float32Array(n);
    for (let i = 0; i < n; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
    return { wav: wavBlob(samples, PCM_RATE), seconds: n / PCM_RATE };
  }

  /** OpenRouter's speech models, each with its own voices (public list, no key needed). */
  async models(): Promise<SpeechModel[]> {
    const r = await this.fetchFn(`${OPENROUTER}/models?output_modalities=speech`, { signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw new Error(`OpenRouter ${r.status}`);
    const num = (x: unknown) => (x === undefined || x === null || isNaN(Number(x)) ? null : Number(x) * 1e6);
    return ((await r.json()).data ?? [])
      .map((m: any) => ({ id: m.id, name: m.name ?? m.id, voices: Array.isArray(m.supported_voices) ? m.supported_voices : [],
                          price_in: num(m.pricing?.prompt), price_out: num(m.pricing?.completion) }))
      .sort((a: SpeechModel, b: SpeechModel) => (a.id < b.id ? -1 : 1));
  }
}
