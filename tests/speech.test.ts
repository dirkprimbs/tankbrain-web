import { describe, expect, it } from "vitest";
import { Brain } from "../src/engine/brain";
import { FakeLLM } from "../src/engine/llm";
import { DEFAULT_STYLE, instructions, OpenRouterSpeech } from "../src/speech/openrouter";
import { SpeechStore, type Engine } from "../src/speech/synth";
import { chunkName, cleanForSpeech, speechPlan, splitForSpeech, wavBlob, type SpeechSpec } from "../src/speech/text";
import { fresh, scripted } from "./helpers";

const CHUNK = /^([a-z]{2}_[a-z]+)_(\d\.\d)_(\d{1,3})_([0-9a-f]{8})\.wav$/;

class FakeSynth implements Engine {
  calls: string[] = [];
  async synth(text: string) {
    this.calls.push(text);
    return { wav: wavBlob(new Float32Array(2400), 24000), seconds: 0.1 };
  }
}
const KOKORO: SpeechSpec = { engine: "kokoro", voice: "af_heart", speed: 1, model: "", style: "" };
const GEMINI: SpeechSpec = { engine: "openrouter", voice: "Puck", speed: 1, model: "google/gemini-3.8-flash-tts", style: "Dry and deadpan." };
const store = (db: any, e: Engine) => new SpeechStore(db, { kokoro: e, openrouter: e });

describe("speech text", () => {
  it("does not read markup aloud", () => {
    const raw = "# Why is the sky blue?\n\nThe **intensity** is $I \\propto 1/\\lambda^4$, so blue wins.\n" +
      "- Path length\n- See [this](http://x.y)\n1. **First** point";
    const spoken = cleanForSpeech(raw);
    for (const junk of ["#", "*", "$", "\\", "http", "["]) expect(spoken).not.toContain(junk);
    for (const want of ["is proportional to", "lambda to the fourth power", "Why is the sky blue?", "Path length.", "See this."]) {
      expect(spoken).toContain(want);
    }
  });

  it("speaks money as money", () => {
    const spoken = cleanForSpeech("The ball costs $0.05 and the bat $1.05, so $1.10 in total; $x + 1$ is the bat.");
    for (const want of ["0.05 dollars", "1.05 dollars", "1.10 dollars", "x + 1 is the bat"]) expect(spoken).toContain(want);
    expect(spoken).not.toContain("$");
  });

  it("starts short and covers everything", () => {
    const text = Array.from({ length: 30 }, (_, i) => `This is sentence number ${i} of a fairly long reply.`).join(" ");
    const chunks = splitForSpeech(text);
    expect(chunks[0].length).toBeLessThanOrEqual(140);
    expect(chunks.every((c) => c.length <= 300)).toBe(true);
    expect(chunks.join(" ")).toBe(text);
    expect(splitForSpeech("word, ".repeat(120) + "end.").every((c) => c.length <= 300)).toBe(true);
  });

  it("grows chunks gradually so playback never waits", () => {
    const text = Array.from({ length: 40 }, (_, i) => `Sentence ${i} explains one more part of a long answer about the sky.`).join(" ");
    for (const t of [text, "Short. ".repeat(3) + text]) {
      const chunks = splitForSpeech(t);
      expect(chunks[0].length).toBeLessThanOrEqual(140);
      for (let i = 1; i < chunks.length; i++) expect(chunks[i].length).toBeLessThanOrEqual(1.6 * chunks[i - 1].length);
      expect(chunks.join(" ")).toBe(t.trim());
    }
  });

  it("never lets a short piece make the rest shrink, and never cuts inside a word", () => {
    const text = ("The question 'Can God create a stone too heavy for him to lift?' is a logical paradox " +
      "arising from self-reference, not a limitation on God's power. By definition, an omnipotent " +
      "being can perform any logically possible action, but creating such a stone is logically " +
      "impossible as it negates omnipotence itself. ").repeat(4);
    const chunks = splitForSpeech(text);
    expect(chunks.length).toBeLessThanOrEqual(Math.floor(text.length / 60));
    const words = new Set(text.split(/\s+/).map((w) => w.replace(/[.,;:']/g, "")));
    for (const c of chunks) {
      const ws = c.split(/\s+/);
      for (const w of [ws[0], ws[ws.length - 1]]) expect(words.has(w.replace(/[.,;:']/g, ""))).toBe(true);
    }
  });

  it("names chunks by voice, speed, index and the exact words (and how they are said)", async () => {
    const name = await chunkName(KOKORO, 3, "Hello there.");
    const m = CHUNK.exec(name)!;
    expect(m.slice(1, 4)).toEqual(["af_heart", "1.0", "3"]);
    expect(await chunkName(KOKORO, 3, "Hello there!")).not.toBe(name);
    const g = await chunkName(GEMINI, 0, "Hello.");
    expect(CHUNK.exec(g)![1]).toBe("or_tts");
    for (const change of [{ style: "Breathless." }, { voice: "Kore" }, { model: "elevenlabs/eleven-v3" }]) {
      expect(await chunkName({ ...GEMINI, ...change }, 0, "Hello.")).not.toBe(g);
    }
  });

  it("writes 16-bit mono WAV", async () => {
    const v = new DataView(await wavBlob(new Float32Array([0, 1, -1]), 24000).arrayBuffer());
    expect(v.getUint32(24, true)).toBe(24000);
    expect(v.getUint16(22, true)).toBe(1);
    expect(v.getUint16(34, true)).toBe(16);
    expect([v.getInt16(44, true), v.getInt16(46, true), v.getInt16(48, true)]).toEqual([0, 32767, -32767]);
  });
});

describe("spoken output channel", () => {
  it("stores chunks in the browser and reports them", async () => {
    const { db } = await fresh();
    const events: [string, any][] = [];
    const synth = new FakeSynth();
    const out = store(db, synth).channel(KOKORO);
    const text = "First sentence here. ".repeat(20);
    const res: any = await out.deliver(text, "abc123", (k, d) => events.push([k, d]), () => false);
    const plan = speechPlan(text);
    const audio = events.filter(([k]) => k === "audio").map(([, d]) => d);
    expect(res.chunks).toBe(plan.length);
    expect(audio.length).toBe(plan.length);
    expect(events[events.length - 1][0]).toBe("audio_end");
    const first = await chunkName(KOKORO, 0, plan[0]);
    expect(audio[0].url).toBe(`abc123/${first}`);
    const row = await db.get("audio", `abc123/${first}`);
    expect(row!.wav.size).toBe(44 + 2400 * 2);
  });

  it("a session speaks its reply, and survives a broken speech model", async () => {
    const { cfg, db, log, ltm } = await fresh();
    const synth = new FakeSynth();
    const res = await new Brain(cfg, new FakeLLM(scripted), log, ltm, 4, store(db, synth).channel(GEMINI)).run("What is 17 times 3?");
    const kinds = (await log.events(res.session)).map((e) => e.kind);
    expect(kinds.indexOf("output")).toBeLessThan(kinds.indexOf("audio"));
    expect(kinds.indexOf("audio")).toBeLessThan(kinds.indexOf("audio_end"));
    expect(kinds.indexOf("audio_end")).toBeLessThan(kinds.indexOf("session_end"));
    expect(synth.calls).toEqual(speechPlan(res.answer!));

    const broken: Engine = { synth: async () => { throw new Error("no sound card"); } };
    const res2 = await new Brain(cfg, new FakeLLM(scripted), log, ltm, 4, store(db, broken).channel(GEMINI)).run("Again?");
    const kinds2 = (await log.events(res2.session)).map((e) => e.kind);
    expect(kinds2).toContain("audio_error");
    expect(res2.answer).toBeTruthy();
    expect((await log.sessions())[0].status).toBe("done");
  });

  it("makes a missing chunk on demand, once", async () => {
    const { db } = await fresh();
    const synth = new FakeSynth();
    const st = store(db, synth);
    const make = async () => ({ text: "Hello.", spec: KOKORO });
    const [a, b] = await Promise.all([st.url("s1/x.wav", make), st.url("s1/x.wav", make)]);
    expect(a).toBe(b);
    expect(synth.calls).toEqual(["Hello."]);
    await expect(st.url("s1/missing.wav")).rejects.toThrow();
  });
});

describe("OpenRouter speech", () => {
  const mock = (respond: (body: any) => Response) => {
    const calls: { url: string; body: any; auth: string }[] = [];
    const fn = (async (url: string, init: RequestInit = {}) => {
      const body = init.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url, body, auth: (init.headers as any)?.Authorization });
      return respond(body);
    }) as unknown as typeof fetch;
    return { fn, calls };
  };
  const pcm = (n: number) => {
    const b = new ArrayBuffer(n * 2);
    new DataView(b).setInt16(0, 16384, true);
    return new Response(b, { headers: { "Content-Type": "audio/pcm" } });
  };

  it("asks the speech endpoint to read the text verbatim, style in the instructions", async () => {
    const { fn, calls } = mock(() => pcm(24000));
    const r = await new OpenRouterSpeech(() => "sk-x", fn).synth("Hello there.", { ...GEMINI, speed: 1.2 });
    expect(calls[0].url).toBe("https://openrouter.ai/api/v1/audio/speech");
    expect(calls[0].auth).toBe("Bearer sk-x");
    expect(calls[0].body).toEqual({ model: "google/gemini-3.8-flash-tts", input: "Hello there.", voice: "Puck",
      instructions: "Dry and deadpan. Speak a little faster than usual.", response_format: "pcm", speed: 1.2 });
    expect(r.seconds).toBe(1);
    const v = new DataView(await r.wav.arrayBuffer());
    expect(v.getUint32(24, true)).toBe(24000);
    expect(v.getInt16(44, true)).toBe(16383);
    expect(instructions("", 1)).toBe(DEFAULT_STYLE);
  });

  it("falls back to mp3 for models that only deliver mp3, and reports errors", async () => {
    const { fn, calls } = mock((b) => b.response_format === "pcm"
      ? new Response(JSON.stringify({ error: { message: "format not supported" } }), { status: 400 })
      : new Response(new Uint8Array(16000), { headers: { "Content-Type": "audio/mpeg" } }));
    const r = await new OpenRouterSpeech(() => "k", fn).synth("Hi.", { ...GEMINI, model: "minimax/speech-2.8-hd" });
    expect(calls.map((c) => c.body.response_format)).toEqual(["pcm", "mp3"]);
    expect(r.wav.type).toBe("audio/mpeg");
    const bad = mock(() => new Response(JSON.stringify({ error: { message: "no credit" } }), { status: 402 }));
    await expect(new OpenRouterSpeech(() => "k", bad.fn).synth("Hi.", GEMINI)).rejects.toThrow("OpenRouter 402: no credit");
    await expect(new OpenRouterSpeech(() => "", bad.fn).synth("Hi.", GEMINI)).rejects.toThrow("no OpenRouter key");
  });

  it("lists speech models with their own voices", async () => {
    const { fn, calls } = mock(() => new Response(JSON.stringify({ data: [
      { id: "google/gemini-3.8-flash-tts", supported_voices: ["Zephyr", "Puck"], pricing: { prompt: "0.0000005", completion: "0.000009" } },
      { id: "fish-audio/s1", supported_voices: null, pricing: {} },
    ] })));
    const models = await new OpenRouterSpeech(() => "", fn).models();
    expect(calls[0].url).toBe("https://openrouter.ai/api/v1/models?output_modalities=speech");
    expect(models[1]).toMatchObject({ id: "google/gemini-3.8-flash-tts", voices: ["Zephyr", "Puck"] });
    expect(models[1].price_out).toBeCloseTo(9);
    expect(models[0].voices).toEqual([]);
  });

  it("makes upcoming chunks in parallel but reports them in order", async () => {
    const { db } = await fresh();
    let running = 0, peak = 0;
    const slow: Engine = { synth: async (t) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, t.length % 3 === 0 ? 15 : 5));
      running--;
      return { wav: wavBlob(new Float32Array(240), 24000), seconds: 0.01 };
    } };
    const events: any[] = [];
    const text = Array.from({ length: 12 }, (_, i) => `Sentence ${i} is here to be spoken aloud, slowly${"!".repeat(i % 3)}.`).join(" ");
    await store(db, slow).channel(GEMINI).deliver(text, "s9", (k, d) => events.push([k, d]), () => false);
    const order = events.filter(([k]) => k === "audio").map(([, d]) => d.index);
    expect(order).toEqual([...order.keys()]);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(3);
  });
});

describe("money next to formulas", () => {
  it("reads $2x as a formula, not as dollars", () => {
    const spoken = cleanForSpeech("Solving that, $2x + $1.00 = $1.10, so $2x = $0.10, and $x = $0.05.");
    expect(spoken).not.toContain("dollarsx");
    expect(spoken).toContain("2x");
    for (const want of ["1.00 dollars", "1.10 dollars", "0.10 dollars", "0.05 dollars"]) expect(spoken).toContain(want);
  });
});
