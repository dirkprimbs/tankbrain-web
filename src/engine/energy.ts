// Interest / energy: the Motivator's drive, turned into a guaranteed stop.

export interface EnergySettings {
  level?: number;
  decay?: number;          // lost every cycle
  novelty_bump?: number;   // gained per fresh (non-echo) post
  novelty_cap?: number;    // max novelty gain per cycle
  interest_weight?: number; // how strongly a Motivator report pulls the level
  threshold?: number;      // below this: wrap up
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

export class Energy {
  level: number;
  decay: number;
  noveltyBump: number;
  noveltyCap: number;
  interestWeight: number;
  threshold: number;

  constructor(s: EnergySettings = {}) {
    this.level = s.level ?? 1.0;
    this.decay = s.decay ?? 0.07;
    this.noveltyBump = s.novelty_bump ?? 0.02;
    this.noveltyCap = s.novelty_cap ?? 0.08;
    this.interestWeight = s.interest_weight ?? 0.5;
    this.threshold = s.threshold ?? 0.25;
  }

  tick(freshPosts: number): number {
    const gain = Math.min(this.noveltyCap, freshPosts * this.noveltyBump);
    this.level = clamp(this.level - this.decay + gain, 0, 1);
    return this.level;
  }

  /** interest in 0..10 from the Motivator. */
  reportInterest(interest: number): number {
    const target = clamp(interest, 0, 10) / 10;
    const w = this.interestWeight;
    this.level = clamp((1 - w) * this.level + w * target, 0, 1);
    return this.level;
  }

  get exhausted(): boolean {
    return this.level < this.threshold;
  }
}
