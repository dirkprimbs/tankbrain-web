// LLM backends: OpenRouter (real, called straight from the browser) and a
// scripted fake (tests). The key lives in this browser's storage and goes only
// to OpenRouter.

export interface LLMResult {
  data: Record<string, any>;
  thinking: string;
  seconds: number;
  loadSeconds: number;
  tokens: number;
  raw: string;
  error: string | null;
}

export interface LLM {
  chat(model: string, system: string, user: string, schema: object,
       options?: Record<string, any>, think?: boolean | null, signal?: AbortSignal): Promise<LLMResult>;
  embed(text: string): Promise<number[] | null>;
}

const result = (r: Partial<LLMResult>): LLMResult =>
  ({ data: {}, thinking: "", seconds: 0, loadSeconds: 0, tokens: 0, raw: "", error: null, ...r });

export function parseJSON(raw: string): Record<string, any> | null {
  raw = raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim(); // reasoning some models emit before the JSON
  try {
    return JSON.parse(raw);
  } catch {
    const m = /\{[\s\S]*\}/.exec(raw);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch { /* fall through */ }
    }
  }
  return repairTruncated(raw);
}

/** Output cut off at the length limit: keep what was complete. Closes an open
 * string, drops a dangling key or comma, and closes open arrays and objects. */
export function repairTruncated(raw: string): Record<string, any> | null {
  const start = raw.indexOf("{");
  if (start < 0) return null;
  const text = raw.slice(start);
  const stack: string[] = [];
  let inString = false, escaped = false;
  for (const c of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{" || c === "[") stack.push(c);
    else if (c === "}" || c === "]") stack.pop();
  }
  if (!stack.length) return null; // complete but invalid: nothing to repair
  let fixed = text.replace(/\\$/, "") + (inString ? '"' : "");
  // trim an incomplete tail: a trailing comma, or (inside an object) a key
  // without its value; a string after ':' or in an array is a value and stays
  const key = /([{,])\s*"(?:[^"\\]|\\.)*"\s*:?\s*$/;
  for (let i = 0; i < 3; i++) {
    fixed = fixed.replace(/,\s*$/, "");
    if (stack[stack.length - 1] === "{") fixed = fixed.replace(key, (_m, p) => (p === "{" ? "{" : ""));
  }
  fixed += stack.reverse().map((c) => (c === "{" ? "}" : "]")).join("");
  try {
    const data = JSON.parse(fixed);
    return data && typeof data === "object" && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

export const OPENROUTER = "https://openrouter.ai/api/v1";

export interface CloudModel {
  id: string;
  name: string;
  price_in: number | null;
  price_out: number | null;
  reasoning: boolean;
  context: number | null;
}

type Fetch = typeof fetch;

/** Tokens a thinking voice may spend on reasoning, on top of its answer's own limit. */
export const REASONING_BUDGET = 3000;

export class OpenRouterLLM implements LLM {
  private reasoningModels: Promise<Set<string>> | null = null;

  constructor(private key: () => string, public embedModel = "openai/text-embedding-3-small",
              private fetchFn: Fetch = (...a) => fetch(...a), private timeoutMs = 60_000,
              private thinkingTimeoutMs = 150_000) {}

  /** Which models accept a reasoning setting (from the public model list, fetched once). */
  private canReason(model: string): Promise<boolean> {
    if (!this.reasoningModels) {
      this.reasoningModels = this.models().then((ms) => new Set(ms.filter((m) => m.reasoning).map((m) => m.id)));
      this.reasoningModels.catch(() => (this.reasoningModels = null));
    }
    return this.reasoningModels.then((s) => s.has(model), () => false);
  }

  private headers(key = this.key()): Record<string, string> {
    return { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "X-Title": "Norbert, the brain" };
  }

  /** A request that takes longer is given up and retried: answers normally come in 1-25 s,
   * so a long silence means a stuck provider. Thinking voices get more time. */
  private async post(path: string, body: any, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(body?.reasoning?.enabled ? this.thinkingTimeoutMs : this.timeoutMs);
    return this.fetchFn(`${OPENROUTER}${path}`, {
      method: "POST", headers: this.headers(), body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  }

  async chat(model: string, system: string, user: string, schema: object,
             options: Record<string, any> = {}, think: boolean | null = null, signal?: AbortSignal): Promise<LLMResult> {
    if (!this.key()) return result({ error: "OpenRouter key not configured (Settings)" });
    const body: Record<string, any> = {
      model,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      response_format: { type: "json_schema", json_schema: { name: "response", strict: false, schema } },
      provider: { require_parameters: true },
    };
    if ("temperature" in options) body.temperature = options.temperature;
    if (options.num_predict) body.max_tokens = Math.trunc(options.num_predict);
    // Thinking on or off is said explicitly, like ollama's think flag: left unsaid, many
    // models reason anyway (slow, costly). Only for models that accept the setting,
    // since providers must honour every parameter we send.
    if (think) {
      body.reasoning = { enabled: true, max_tokens: REASONING_BUDGET };
      if (body.max_tokens) body.max_tokens += REASONING_BUDGET; // reasoning must not eat the answer's room
    } else if (await this.canReason(model)) {
      body.reasoning = { enabled: false };
    }
    const t0 = performance.now();
    let lastErr: string | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      let r: Response;
      try {
        r = await this.post("/chat/completions", body, signal);
      } catch (e) {
        if (signal?.aborted) throw e; // the session was stopped
        lastErr = `OpenRouter unreachable: ${e}`;
        continue;
      }
      let payload: any;
      try {
        if (r.status !== 200) {
          let msg = await r.text();
          try {
            msg = JSON.parse(msg)?.error?.message ?? msg;
          } catch { /* plain text */ }
          lastErr = `OpenRouter ${r.status}: ${String(msg).slice(0, 300)}`;
          // some models must reason: try once more without switching it off
          if (r.status === 400 && body.reasoning?.enabled === false && attempt === 0) {
            delete body.reasoning;
            continue;
          }
          if ([400, 401, 402, 403, 404].includes(r.status)) break; // retrying won't help
          continue;
        }
        payload = await r.json(); // the answer can still time out while it arrives
      } catch (e) {
        if (signal?.aborted) throw e;
        lastErr = `OpenRouter answer not received: ${e}`;
        continue;
      }
      const msg = payload?.choices?.[0]?.message ?? {};
      const raw: string = msg.content ?? "";
      const data = parseJSON(raw);
      if (data !== null) {
        return result({ data, thinking: msg.reasoning ?? "", seconds: (performance.now() - t0) / 1000,
                        tokens: payload?.usage?.completion_tokens ?? 0, raw });
      }
      lastErr = `unparseable JSON: ${raw.slice(0, 200)}`;
    }
    return result({ seconds: (performance.now() - t0) / 1000, error: lastErr });
  }

  /** Embeddings for long-term memory, also via OpenRouter. */
  async embed(text: string): Promise<number[] | null> {
    if (!this.key() || !this.embedModel) return null;
    try {
      const r = await this.post("/embeddings", { model: this.embedModel, input: text });
      if (!r.ok) return null;
      const v = (await r.json())?.data?.[0]?.embedding;
      return Array.isArray(v) ? v : null;
    } catch {
      return null;
    }
  }

  /** Ask OpenRouter whether a key is valid (before saving it). */
  async checkKey(key: string): Promise<[boolean, string]> {
    let r: Response;
    try {
      r = await this.fetchFn(`${OPENROUTER}/key`, { headers: this.headers(key), signal: AbortSignal.timeout(20_000) });
    } catch (e) {
      return [false, `OpenRouter unreachable: ${e}`];
    }
    if (r.status === 200) {
      const label = (await r.json())?.data?.label || "key";
      return [true, `valid (${label})`];
    }
    return [false, `rejected by OpenRouter (${r.status})`];
  }

  /** Hosted models that support enforced JSON-schema output (public list, no key needed). */
  async models(): Promise<CloudModel[]> {
    const r = await this.fetchFn(`${OPENROUTER}/models`, { signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw new Error(`OpenRouter ${r.status}`);
    const out: CloudModel[] = [];
    for (const m of (await r.json()).data ?? []) {
      const params: string[] = m.supported_parameters ?? [];
      if (!params.includes("structured_outputs")) continue;
      const p = m.pricing ?? {};
      const num = (x: unknown) => (x === undefined || x === null || isNaN(Number(x)) ? null : Number(x) * 1e6);
      out.push({ id: m.id, name: m.name ?? m.id, price_in: num(p.prompt), price_out: num(p.completion),
                 reasoning: params.includes("reasoning"), context: m.context_length ?? null });
    }
    return out.sort((a, b) => (a.id < b.id ? -1 : 1));
  }
}

/** Scripted backend: script(system, user) -> data. The agent is identified by a
 * marker in its system prompt, so tests can script per-agent behaviour. */
export class FakeLLM implements LLM {
  calls: { model: string; system: string; user: string; schema: object }[] = [];
  constructor(private script: (system: string, user: string) => Record<string, any>,
              private delayMs = 0) {}

  async chat(model: string, system: string, user: string, schema: object, _o?: object, _t?: boolean | null,
             signal?: AbortSignal): Promise<LLMResult> {
    this.calls.push({ model, system, user, schema });
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (signal?.aborted) throw new DOMException("stopped", "AbortError");
    return result({ data: this.script(system, user) });
  }

  async embed(): Promise<number[] | null> {
    return null;
  }
}
