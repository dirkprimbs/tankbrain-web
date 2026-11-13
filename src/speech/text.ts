// Turning a reply into speakable, sentence-sized chunks (same rules as the
// server version, so the same reply is spoken in the same pieces).

export const DEFAULT_VOICE = "af_heart";
export const ENGLISH_PREFIXES = ["af_", "am_", "bf_", "bm_"]; // American/British, female/male
export const PREVIEW_TEXT = "Hello. This is how I sound when I say what the tank has been thinking.";

const SYMBOLS: [string, string][] = [
  ["\\propto", " is proportional to "], ["\\approx", " approximately "], ["\\times", " times "],
  ["\\cdot", " times "], ["\\leq", " less than or equal to "], ["\\geq", " greater than or equal to "],
  ["\\neq", " not equal to "], ["\\pi", " pi "], ["\\lambda", " lambda "], ["\\alpha", " alpha "],
  ["\\beta", " beta "], ["\\theta", " theta "], ["\\mu", " mu "], ["\\sigma", " sigma "], ["\\Delta", " delta "],
  ["λ", " lambda "], ["≈", " approximately "], ["∝", " is proportional to "], ["×", " times "], ["→", " to "],
  ["≤", " less than or equal to "], ["≥", " greater than or equal to "], ["≠", " not equal to "],
];
const ORDINAL: Record<string, string> = { "2": "squared", "3": "cubed", "4": "to the fourth power", "5": "to the fifth power" };

/** Turn a markdown/LaTeX-ish reply into something a voice can read aloud. */
export function cleanForSpeech(text: string): string {
  let t = text;
  t = t.replace(/```[\s\S]*?```/g, " ");                                   // code blocks
  t = t.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");                           // links -> text
  // money first ("$0.05", "$1,200"), so the dollar sign isn't taken for formula markup
  // ("$2x" is a formula, not money: a dollar amount isn't followed by a letter)
  t = t.replace(/\$(\d[\d,]*(?:\.\d+)?)(?![\d.,]*[A-Za-z])/g, (_, n) => `${n} dollars`);
  t = t.replace(/\$([^$]+)\$/g, " $1 ");                                   // $formula$ -> formula
  t = t.replace(/\\frac\{([^}]*)\}\{([^}]*)\}/g, "$1 over $2");
  for (const [k, v] of SYMBOLS) t = t.split(k).join(v);
  t = t.replace(/\^\{?(\d)\}?/g, (_, d) => " " + (ORDINAL[d] ?? `to the power of ${d}`));
  t = t.replace(/\\[a-zA-Z]+/g, " ");                                      // other LaTeX commands
  t = t.replace(/[$`*_#>{}\\]/g, "");                                      // markup characters
  t = t.replace(/^\s*[-•]\s+/gm, "");                                      // bullet markers
  // lines without closing punctuation (headings, list items) become sentences
  const lines = t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    .map((l) => l + (/[.!?:;,]$/.test(l) ? "" : "."));
  return lines.join(" ").replace(/\s+/g, " ").trim();
}

/** Sentence-sized chunks. The first is short so playback starts quickly; after
 * that each may be at most `growth` times as long as the one before it (but
 * never shorter than the first), so a chunk is ready before the previous one
 * has finished playing. Cuts fall at sentence ends, else at commas, else
 * between words; never inside a word. */
export function splitForSpeech(text: string, maxChars = 300, first = 140, growth = 1.6): string[] {
  const chunks: string[] = [];
  const limit = () => (chunks.length ? Math.max(first, Math.min(maxChars, Math.trunc(chunks[chunks.length - 1].length * growth))) : first);
  const cutPoint = (s: string, lim: number) => {
    for (const sep of [", ", "; ", " "]) {
      const i = s.lastIndexOf(sep, lim - sep.length);
      if (i > Math.trunc(lim / 3)) return i + sep.length - 1;
    }
    return lim;
  };
  let cur = "";
  for (const s of text.split(/(?<=[.!?])\s+/)) {
    if (cur && cur.length + s.length + 1 > limit()) {
      chunks.push(cur);
      cur = s;
    } else cur = `${cur} ${s}`.trim();
    while (cur.length > limit()) { // a single very long sentence
      const cut = cutPoint(cur, limit());
      chunks.push(cur.slice(0, cut).trim());
      cur = cur.slice(cut).trim();
    }
  }
  if (cur) chunks.push(cur);
  return chunks.filter(Boolean);
}

/** The exact chunks a reply is spoken in (shared by live and on-demand speech). */
export const speechPlan = (text: string) => splitForSpeech(cleanForSpeech(text));

/** Everything that decides how a reply sounds. */
export interface SpeechSpec {
  engine: "openrouter" | "kokoro";
  voice: string;   // Kokoro: af_heart, …; OpenRouter: the model's own voice id (Puck, george, …)
  speed: number;
  model: string;   // OpenRouter speech model (unused for Kokoro)
  style: string;   // OpenRouter delivery instructions (unused for Kokoro)
}

/** The voice part of a chunk name: Kokoro voices as they are; OpenRouter voice
 * ids vary wildly (capitals, colons), so they go into the fingerprint instead. */
export const voiceId = (s: SpeechSpec) => (s.engine === "kokoro" ? s.voice : "or_tts");

/** Voice, speed, position and a fingerprint of the exact words (and, for
 * OpenRouter, the model and style), so stored audio is never reused for a
 * different text or a different way of saying it. */
export async function chunkName(spec: SpeechSpec, index: number, text: string): Promise<string> {
  const what = spec.engine === "kokoro" ? text : [text, spec.model, spec.voice, spec.style].join("\u0000");
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(what));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 8);
  return `${voiceId(spec)}_${clampSpeed(spec.speed).toFixed(1)}_${index}_${hex}.wav`;
}

export const clampSpeed = (s: number) => Math.round(Math.max(0.5, Math.min(2, Number(s) || 1)) * 10) / 10;

/** 16-bit mono WAV, like the server wrote. */
export function wavBlob(samples: Float32Array, rate: number): Blob {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const w = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF"); v.setUint32(4, 36 + samples.length * 2, true); w(8, "WAVE");
  w(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, "data"); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const x = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, Math.trunc(x * 32767), true);
  }
  return new Blob([buf], { type: "audio/wav" });
}
