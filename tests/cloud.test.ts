import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Brain } from "../src/engine/brain";
import { OpenRouterLLM, OPENROUTER } from "../src/engine/llm";
import { fresh, scripted } from "./helpers";

type Call = { url: string; init: RequestInit };
function mock(handler: (url: string, body: any, init: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return handler(url, init.body ? JSON.parse(String(init.body)) : null, init);
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

describe("OpenRouter from the browser", () => {
  it("sends the schema, options and key only to OpenRouter, and parses the answer", async () => {
    const { fn, calls } = mock((url) => url.endsWith("/models")
      ? json({ data: [{ id: "m", supported_parameters: ["structured_outputs", "reasoning"] }] })
      : json({ choices: [{ message: { content: '{"thought":"hi"}', reasoning: "hmm" } }], usage: { completion_tokens: 7 } }));
    const llm = new OpenRouterLLM(() => "sk-test", "openai/text-embedding-3-small", fn);
    const schema = { type: "object", properties: { thought: { type: "string" } } };
    const r = await llm.chat("qwen/qwen3-30b-a3b", "sys", "user", schema, { temperature: 0.4, num_predict: 900 }, true);
    expect(r.data).toEqual({ thought: "hi" });
    expect(r.thinking).toBe("hmm");
    expect(r.tokens).toBe(7);
    const { url, init } = calls[0];
    expect(url).toBe(`${OPENROUTER}/chat/completions`);
    expect((init.headers as any).Authorization).toBe("Bearer sk-test");
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("qwen/qwen3-30b-a3b");
    expect(body.response_format.json_schema.schema).toEqual(schema);
    expect(body.provider).toEqual({ require_parameters: true });
    expect(body.temperature).toBe(0.4);
    // thinking gets its own budget on top of the answer's limit
    expect(body.max_tokens).toBe(900 + 3000);
    expect(body.reasoning).toEqual({ enabled: true, max_tokens: 3000 });
    // thinking off is said explicitly to models that accept it, and not sent to others
    await llm.chat("m", "s", "u", schema, {}, false);
    const chats = calls.filter((c) => c.url.endsWith("/chat/completions")).map((c) => JSON.parse(String(c.init.body)));
    expect(chats[1].reasoning).toEqual({ enabled: false });
    await llm.chat("microsoft/phi-4", "s", "u", schema, {}, false);
    const last = calls.filter((c) => c.url.endsWith("/chat/completions")).pop()!;
    expect("reasoning" in JSON.parse(String(last.init.body))).toBe(false);
  });

  it("doesn't retry hopeless errors, retries flaky ones, and checks keys", async () => {
    let n = 0;
    const { fn, calls: all } = mock((url) => {
      if (url.endsWith("/key")) return json({ data: { label: "mine" } });
      if (url.endsWith("/models")) return json({ data: [] });
      n++;
      return n === 1 ? json({ error: { message: "bad key" } }, 401) : json({}, 500);
    });
    const calls = { get length() { return all.filter((c) => c.url.endsWith("/chat/completions")).length; } };
    const llm = new OpenRouterLLM(() => "k", "", fn);
    const r = await llm.chat("m", "s", "u", {});
    expect(r.error).toBe("OpenRouter 401: bad key");
    expect(calls.length).toBe(1);
    const r2 = await llm.chat("m", "s", "u", {});
    expect(r2.error).toContain("OpenRouter 500");
    expect(calls.length).toBe(3); // one retry
    expect(await llm.checkKey("k")).toEqual([true, "valid (mine)"]);
    expect(await new OpenRouterLLM(() => "", "", fn).chat("m", "s", "u", {})).toMatchObject({ error: "OpenRouter key not configured (Settings)" });
  });

  it("lists only models that support enforced JSON output", async () => {
    const { fn } = mock(() => json({ data: [
      { id: "a/json", supported_parameters: ["structured_outputs", "reasoning"], pricing: { prompt: "0.0000001", completion: "0.0000004" } },
      { id: "b/plain", supported_parameters: ["temperature"] },
    ] }));
    const models = await new OpenRouterLLM(() => "", "", fn).models();
    expect(models.map((m) => m.id)).toEqual(["a/json"]);
    expect(models[0].reasoning).toBe(true);
    expect(models[0].price_in).toBeCloseTo(0.1);
  });

  it("embeds for long-term memory through OpenRouter", async () => {
    const { fn, calls } = mock(() => json({ data: [{ embedding: [0.1, 0.2] }] }));
    const v = await new OpenRouterLLM(() => "k", "openai/text-embedding-3-small", fn).embed("hello");
    expect(v).toEqual([0.1, 0.2]);
    expect(calls[0].url).toBe(`${OPENROUTER}/embeddings`);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ model: "openai/text-embedding-3-small", input: "hello" });
  });

  it("the key never ends up in the browser's stored data", async () => {
    const { cfg, db, log, ltm } = await fresh();
    const { fn } = mock((url, body) => {
      const name = /Your name is (\w+)\./.exec(body.messages[0].content)![1];
      void name;
      return json({ choices: [{ message: { content: JSON.stringify(scripted(body.messages[0].content, body.messages[1].content)) } }] });
    });
    const key = "sk-or-v1-SECRET-KEY-123";
    const llm = new OpenRouterLLM(() => key, "", fn);
    const res = await new Brain(cfg, llm, log, ltm).run("What is 17 times 3?");
    expect(res.answer).toBe("It's 51.");
    for (const store of ["sessions", "events", "memories", "profiles", "audio"] as const) {
      expect(JSON.stringify(await db.getAll(store))).not.toContain("SECRET");
    }
  });
});

describe("a static page", () => {
  const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
  const src = files(join(__dirname, "../src")).filter((f) => /\.(ts|html)$/.test(f));

  it("reads no environment variables", () => {
    for (const f of src) expect(readFileSync(f, "utf8"), f).not.toMatch(/process\.env|import\.meta\.env/);
  });

  it("talks to no server of its own: only OpenRouter (and Hugging Face for the speech model)", () => {
    for (const f of src) {
      const text = readFileSync(f, "utf8");
      expect(text, f).not.toMatch(/new WebSocket|fetch\(\s*["'`]\/api/);
      // links a person clicks (href) are not the app contacting a server
      for (const host of text.replace(/href="[^"]*"/g, "").match(/https?:\/\/[^\s"'`)]+/g) ?? []) {
        expect(host, f).toMatch(/^https:\/\/(openrouter\.ai|huggingface\.co)\b|^http:\/\/x\.y$/);
      }
    }
  });
});

describe("parsing model output", () => {
  it("ignores a <think> block before the JSON", async () => {
    const { parseJSON } = await import("../src/engine/llm");
    expect(parseJSON('<think>\n\n</think>\n\n{"thought": "x"}')).toEqual({ thought: "x" });
    expect(parseJSON('<think>{"no": 1}</think>{"yes": 2}')).toEqual({ yes: 2 });
  });
});

describe("output cut off at the length limit", () => {
  it("keeps what was complete", async () => {
    const { parseJSON } = await import("../src/engine/llm");
    expect(parseJSON('<think>\n\n</think>\n\n{\n  "thought": "The number crunching 5/5 becomes')).toEqual({ thought: "The number crunching 5/5 becomes" });
    expect(parseJSON('{"thought": "ok", "posts": [{"topic": "focus", "text": "a"}, {"topic": "fo')).toEqual({ thought: "ok", posts: [{ topic: "focus", text: "a" }, { topic: "fo" }] });
    expect(parseJSON('{"thought": "ok", "draft": ')).toEqual({ thought: "ok" });
    expect(parseJSON('{"thought": "ok", "dr')).toEqual({ thought: "ok" });
    expect(parseJSON('{"a": "x\\')).toEqual({ a: "x" });
    expect(parseJSON("no json at all")).toBeNull();
  });
});

describe("output cut off at the length limit (values stay)", () => {
  it("keeps a cut-off value in an array or after a colon", async () => {
    const { parseJSON } = await import("../src/engine/llm");
    expect(parseJSON('{"remember": ["a", "b')).toEqual({ remember: ["a", "b"] });
    expect(parseJSON('{"thought": "x", "posts": [{"topic": "focus", "text": "half a sen')).toEqual(
      { thought: "x", posts: [{ topic: "focus", text: "half a sen" }] });
    expect(parseJSON('{"thought": "x", "posts": [{"topic": "focus", "te')).toEqual({ thought: "x", posts: [{ topic: "focus" }] });
  });
});

describe("one voice's failure is not the session's", () => {
  it("a timeout while the answer arrives costs that turn only", async () => {
    const { fn } = mock((url) => {
      if (url.endsWith("/models")) return json({ data: [] });
      // headers arrive, then the body never completes in time
      return new Response(new ReadableStream({ start(c) { c.error(new DOMException("signal timed out", "TimeoutError")); } }), { status: 200 });
    });
    const r = await new OpenRouterLLM(() => "k", "", fn).chat("m", "s", "u", {});
    expect(r.error).toContain("OpenRouter answer not received");
  });

  it("a voice whose call throws gets an error event and the session goes on", async () => {
    const { cfg, log, ltm } = await fresh();
    const llm = new (await import("../src/engine/llm")).FakeLLM(scripted);
    const chat = llm.chat.bind(llm);
    llm.chat = async (model, system, ...rest) => {
      if (system.startsWith("Your name is Associator.")) throw new DOMException("signal timed out", "TimeoutError");
      return chat(model, system, ...rest);
    };
    const res = await new Brain(cfg, llm, log, ltm).run("What is 17 times 3?");
    expect(res.answer).toBe("It's 51.");
    const ev = await log.events(res.session);
    expect(ev.some((e) => e.kind === "error" && e.agent === "Associator" && e.data.error.includes("timed out"))).toBe(true);
    expect((await log.sessions())[0].status).toBe("done");
  });
});
