// A small model running in this browser (WebLLM on WebGPU): an imperfect,
// offline-capable stand-in for the hosted voices. Model ids are written as
// "browser:<WebLLM model id>". One model is loaded at a time and calls take
// turns on the GPU. The weights download once (from Hugging Face) and are
// cached by the browser.

import type { WebWorkerMLCEngine } from "@mlc-ai/web-llm";
import { parseJSON, type LLM, type LLMResult } from "./llm";

export const BROWSER_PREFIX = "browser:";

/** Models offered in the voice editor, with what they need (GPU memory, download). */
export const BROWSER_MODELS: { id: string; label: string; vramGB: number }[] = [
  { id: "Qwen3.5-2B-q4f32_1-MLC", label: "Qwen3.5 2B (default)", vramGB: 2.6 },
  { id: "Qwen3.5-4B-q4f32_1-MLC", label: "Qwen3.5 4B (better, slower)", vramGB: 4.7 },
  { id: "Qwen3-1.7B-q4f32_1-MLC", label: "Qwen3 1.7B", vramGB: 2.6 },
  { id: "Llama-3.2-3B-Instruct-q4f32_1-MLC", label: "Llama 3.2 3B", vramGB: 2.9 },
  { id: "gemma-4-E2B-it-q4f32_1-MLC", label: "Gemma 4 E2B", vramGB: 3.9 },
];

export const isBrowserModel = (model: string) => model.startsWith(BROWSER_PREFIX);

const result = (r: Partial<LLMResult>): LLMResult =>
  ({ data: {}, thinking: "", seconds: 0, loadSeconds: 0, tokens: 0, raw: "", error: null, ...r });

const CALL_TIMEOUT_MS = 180_000; // a call that takes longer is treated as hung

export class BrowserLLM implements LLM {
  private engine: Promise<WebWorkerMLCEngine> | null = null;
  private worker: Worker | null = null;
  private loaded = "";
  private chain: Promise<unknown> = Promise.resolve();
  /** Download/compile progress of the model (0..1) with a readable status. */
  onProgress: (fraction: number, text: string) => void = () => {};

  static supported(): boolean {
    return typeof navigator !== "undefined" && "gpu" in navigator;
  }

  private async engineFor(model: string): Promise<[WebWorkerMLCEngine, number]> {
    const t0 = performance.now();
    if (!this.engine) {
      this.engine = (async () => {
        const { CreateWebWorkerMLCEngine } = await import("@mlc-ai/web-llm");
        const worker = (this.worker = new Worker(new URL("./webllm.worker.ts", import.meta.url), { type: "module" }));
        return CreateWebWorkerMLCEngine(worker, model, {
          initProgressCallback: (p) => this.onProgress(p.progress, p.text),
        });
      })();
      this.loaded = model;
      this.engine.catch(() => this.reset());
    }
    const engine = await this.engine;
    if (this.loaded !== model) {
      this.loaded = model;
      await engine.reload(model);
    }
    return [engine, (performance.now() - t0) / 1000];
  }

  /** Throw the engine away (after a crash or hang); the next call starts a fresh one. */
  private reset() {
    this.worker?.terminate();
    this.worker = null;
    this.engine = null;
    this.loaded = "";
  }

  chat(model: string, system: string, user: string, schema: object, options: Record<string, any> = {},
       think: boolean | null = null, signal?: AbortSignal): Promise<LLMResult> {
    // one at a time: there is one GPU and one loaded model
    const job = this.chain.then(() => this.run(model.slice(BROWSER_PREFIX.length), system, user, schema, options, think, signal));
    this.chain = job.catch(() => {});
    return job;
  }

  private async run(model: string, system: string, user: string, schema: object, options: Record<string, any>,
                    think: boolean | null, signal?: AbortSignal): Promise<LLMResult> {
    if (signal?.aborted) throw new DOMException("stopped", "AbortError");
    if (!BrowserLLM.supported()) return result({ error: "this browser has no WebGPU, so it can't run a model itself" });
    const t0 = performance.now();
    let engine: WebWorkerMLCEngine, loadSeconds: number;
    try {
      [engine, loadSeconds] = await this.engineFor(model);
    } catch (e) {
      return result({ error: `in-browser model failed to load: ${(e as Error).message ?? e}` });
    }
    // Stop must work even if the engine never answers (e.g. after a crash in its worker)
    let onAbort = () => {};
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => {
        engine.interruptGenerate();
        reject(new DOMException("stopped", "AbortError"));
      };
      signal?.addEventListener("abort", onAbort);
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hung = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        this.reset();
        reject(new Error(`no answer after ${CALL_TIMEOUT_MS / 1000} s; the model was restarted`));
      }, CALL_TIMEOUT_MS);
    });
    aborted.catch(() => {});
    hung.catch(() => {});
    try {
      const create = engine.chat.completions.create({
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        response_format: { type: "json_object", schema: JSON.stringify(schema) },
        temperature: options.temperature,
        max_tokens: options.num_predict ? Math.trunc(options.num_predict) : 1200,
        extra_body: { enable_thinking: !!think },
      } as any);
      const r = await Promise.race([create, aborted, hung]);
      if (signal?.aborted) throw new DOMException("stopped", "AbortError");
      const raw: string = (r as any).choices?.[0]?.message?.content ?? "";
      const data = parseJSON(raw);
      const seconds = (performance.now() - t0) / 1000;
      if (data === null) return result({ seconds, loadSeconds, error: `unparseable JSON: ${raw.slice(0, 200)}` });
      return result({ data, raw, seconds, loadSeconds, tokens: (r as any).usage?.completion_tokens ?? 0 });
    } catch (e) {
      if (signal?.aborted) throw e;
      // a crash inside the engine's worker leaves it unusable: start fresh next time
      if (/Aborted\(\)|RuntimeError|disposed/i.test(String((e as Error)?.message ?? e))) this.reset();
      return result({ seconds: (performance.now() - t0) / 1000, error: `in-browser model: ${(e as Error).message ?? e}` });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async embed(): Promise<number[] | null> {
    return null; // long-term memory falls back to word matching
  }
}

/** Sends "browser:" models to the in-browser engine, everything else to OpenRouter. */
export class ModelRouter implements LLM {
  constructor(private cloud: LLM, private browser: LLM) {}

  chat(model: string, ...rest: Parameters<LLM["chat"]> extends [string, ...infer R] ? R : never): Promise<LLMResult> {
    return (isBrowserModel(model) ? this.browser : this.cloud).chat(model, ...rest);
  }

  embed(text: string): Promise<number[] | null> {
    return this.cloud.embed(text);
  }
}
