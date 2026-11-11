// Spoken output in the browser: Kokoro in a worker, one synthesis at a time,
// audio chunks kept in IndexedDB per session so replays play the same audio.

import type { AudioChannel } from "../engine/brain";
import type { Store } from "../engine/store";
import { chunkName, clampSpeed, ENGLISH_PREFIXES, PREVIEW_TEXT, speechPlan, voiceId, wavBlob, type SpeechSpec } from "./text";

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

export class KokoroSynth {
  private worker: Worker | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private chain: Promise<unknown> = Promise.resolve();
  private voiceList: Promise<string[]> | null = null;
  ready = false;
  onProgress: (fraction: number) => void = () => {};

  private call<T>(msg: Record<string, unknown>): Promise<T> {
    if (!this.worker) {
      this.worker = new Worker(new URL("./kokoro.worker.ts", import.meta.url), { type: "module" });
      this.worker.onmessage = (ev) => {
        const d = ev.data;
        if (d.type === "progress") {
          if (d.total) this.onProgress(d.loaded / d.total);
          return;
        }
        const p = this.pending.get(d.id);
        if (!p) return;
        this.pending.delete(d.id);
        if (d.ok) {
          this.ready = true;
          p.resolve(d);
        } else p.reject(new Error(d.error));
      };
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker!.postMessage({ id, ...msg });
    });
  }

  /** English voices only (American/British). Loads the model on first call. */
  voiceNames(): Promise<string[]> {
    if (!this.voiceList) {
      this.voiceList = this.call<{ voices: string[] }>({ type: "voices" })
        .then((d) => d.voices.filter((v) => ENGLISH_PREFIXES.some((p) => v.startsWith(p))).sort());
      this.voiceList.catch(() => (this.voiceList = null));
    }
    return this.voiceList;
  }

  /** One synthesis at a time (it already uses all cores). */
  synth(text: string, voice: string, speed: number): Promise<{ wav: Blob; seconds: number }> {
    const job = this.chain.then(async () => {
      const d = await this.call<{ samples: Float32Array; rate: number }>({ type: "synth", text, voice, speed });
      return { wav: wavBlob(d.samples, d.rate), seconds: d.samples.length / d.rate };
    });
    this.chain = job.catch(() => {});
    return job;
  }
}

/** Something that turns one chunk of text into audio. */
export interface Engine {
  synth(text: string, spec: SpeechSpec): Promise<{ wav: Blob; seconds: number }>;
}

/** Kokoro as an engine (voice and speed only). */
export const kokoroEngine = (k: KokoroSynth): Engine => ({ synth: (text, spec) => k.synth(text, spec.voice, spec.speed) });

const LOOKAHEAD = 3; // chunks made ahead of the one being reported (OpenRouter: in parallel)

/** Audio for a session: made live while the session ends, or on demand later. */
export class SpeechStore {
  private urls = new Map<string, Promise<string>>();

  constructor(private db: Store, private engines: Record<SpeechSpec["engine"], Engine>) {}

  /** Object URL for a stored chunk ("<session>/<name>"), making it first if needed.
   * Concurrent requests for the same chunk share one synthesis and one URL. */
  url(key: string, make?: () => Promise<{ text: string; spec: SpeechSpec } | null>): Promise<string> {
    let p = this.urls.get(key);
    if (!p) {
      p = this.load(key, make);
      this.urls.set(key, p);
      p.catch(() => this.urls.delete(key)); // allow a retry
    }
    return p;
  }

  private async load(key: string, make?: () => Promise<{ text: string; spec: SpeechSpec } | null>): Promise<string> {
    let blob = (await this.db.get("audio", key))?.wav;
    if (!blob) {
      const job = make ? await make() : null;
      if (!job) throw new Error("audio not found");
      blob = (await this.engines[job.spec.engine].synth(job.text, job.spec)).wav;
      await this.db.put("audio", { key, session: key.split("/")[0], wav: blob });
    }
    return URL.createObjectURL(blob);
  }

  async preview(spec: SpeechSpec): Promise<string> {
    const key = `preview/${await chunkName(spec, 0, PREVIEW_TEXT)}`;
    return this.url(key, async () => ({ text: PREVIEW_TEXT, spec }));
  }

  /** The spoken output channel for one live session. */
  channel(spec: SpeechSpec): AudioChannel {
    spec = { ...spec, speed: clampSpeed(spec.speed) };
    const engine = this.engines[spec.engine];
    return {
      deliver: async (text, session, emit, cancelled) => {
        const chunks = speechPlan(text);
        const jobs: Promise<{ wav: Blob; seconds: number }>[] = [];
        const start = (i: number) => {
          if (i < chunks.length && !jobs[i]) {
            jobs[i] = engine.synth(chunks[i], spec);
            jobs[i].catch(() => {}); // reported below, in order
          }
        };
        let total = 0;
        for (let i = 0; i < chunks.length; i++) {
          if (cancelled()) break;
          for (let j = i; j < i + LOOKAHEAD; j++) start(j);
          let wav: Blob, secs: number;
          try {
            ({ wav, seconds: secs } = await jobs[i]);
          } catch (e) { // a voice problem must never break the session
            emit("audio_error", { error: `speech failed: ${(e as Error).message}` });
            break;
          }
          const name = await chunkName(spec, i, chunks[i]);
          await this.db.put("audio", { key: `${session}/${name}`, session, wav });
          total += secs;
          emit("audio", { index: i, of: chunks.length, url: `${session}/${name}`, seconds: Math.round(secs * 100) / 100, text: chunks[i] });
        }
        emit("audio_end", { chunks: chunks.length, seconds: Math.round(total * 10) / 10, voice: voiceId(spec) });
        return { chunks: chunks.length, seconds: total };
      },
    };
  }
}
