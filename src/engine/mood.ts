// Norbert's mood: core affect, as in Russell's circumplex. Valence says how
// pleasant it feels (-1..1), arousal how stirred up (0..1). The Feeler's
// reports move it during a session; between sessions it drifts back towards
// the temperament (curious) with a half-life of a few hours. It colours how
// the voices that speak for the brain put things, never what is true.

export interface MoodState {
  valence: number;  // -1 unpleasant .. 1 pleasant
  arousal: number;  // 0 calm .. 1 stirred up
  word: string;     // how it would put it: "curious", "delighted", "uneasy"
  at: number;       // when (seconds)
}

export const BASELINE = { valence: 0.25, arousal: 0.4 };  // the temperament it returns to
export const HALF_LIFE_HOURS = 4;   // between sessions, half of the difference to the baseline is gone in this time
export const FEEL_WEIGHT = 0.35;    // how far one report of the Feeler moves the mood

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const round = (x: number) => Math.round(x * 100) / 100;

/** A word for a point on the circumplex (used when the mood has drifted on its own). */
export function label(valence: number, arousal: number): string {
  const row = valence > 0.35 ? ["content", "cheerful", "excited"]
    : valence > 0.1 ? ["calm", "curious", "eager"]
    : valence > -0.2 ? ["quiet", "thoughtful", "restless"]
    : ["glum", "uneasy", "tense"];
  return row[arousal > 0.6 ? 2 : arousal >= 0.4 ? 1 : 0];
}

export function baseline(at = Date.now() / 1000): MoodState {
  return { ...BASELINE, word: label(BASELINE.valence, BASELINE.arousal), at };
}

/** The mood a while later: it drifts back towards the temperament. */
export function restore(prev: MoodState | null | undefined, at = Date.now() / 1000): MoodState {
  if (!prev) return baseline(at);
  const hours = Math.max(0, at - prev.at) / 3600;
  const k = 0.5 ** (hours / HALF_LIFE_HOURS); // what is left of the difference
  const valence = round(BASELINE.valence + (prev.valence - BASELINE.valence) * k);
  const arousal = round(BASELINE.arousal + (prev.arousal - BASELINE.arousal) * k);
  // mostly faded: the old word no longer fits
  return { valence, arousal, word: k >= 0.5 ? prev.word : label(valence, arousal), at };
}

/** The Feeler reports a feeling (valence -5..5, arousal 0..10): the mood moves towards it. */
export function feel(m: MoodState, valence: number, arousal: number, word: string, at = Date.now() / 1000): MoodState {
  const v = clamp(valence, -5, 5) / 5, a = clamp(arousal, 0, 10) / 10;
  const nv = round(m.valence + (v - m.valence) * FEEL_WEIGHT);
  const na = round(m.arousal + (a - m.arousal) * FEEL_WEIGHT);
  return { valence: nv, arousal: na, word: word.trim().toLowerCase().slice(0, 30) || label(nv, na), at };
}

/** How the mood reads to the voices that speak for the brain. */
export function describe(m: MoodState): string {
  const pleasant = m.valence > 0.15 ? "pleasant" : m.valence < -0.15 ? "unpleasant" : "neither good nor bad";
  const stirred = m.arousal > 0.6 ? "stirred up" : m.arousal < 0.3 ? "calm" : "awake";
  return `${m.word} (${pleasant}, ${stirred})`;
}
