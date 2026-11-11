import { describe, expect, it } from "vitest";
import { Agent } from "../src/engine/agent";
import { Brain } from "../src/engine/brain";
import * as config from "../src/engine/config";
import { FakeLLM, type LLM } from "../src/engine/llm";
import { exportSession, importDemos, importSession } from "../src/engine/sessionfile";
import { wavBlob } from "../src/speech/text";
import { fresh, scripted } from "./helpers";

describe("Inventor and Storyteller", () => {
  it("are wired in: sparks reach the Curator, telling reaches the Drafter", async () => {
    const { db } = await fresh();
    const cfg = await config.load("diverse", db);
    const inv = cfg.agents.get("Inventor")!, st = cfg.agents.get("Storyteller")!;
    expect(inv.posts_to).toEqual(["sparks"]);
    expect(st.posts_to).toEqual(["telling"]);
    expect(cfg.agents.get("Curator")!.subscriptions).toContain("sparks");
    expect(cfg.agents.get("Drafter")!.subscriptions).toContain("telling");
    expect(st.subscriptions).toEqual(expect.arrayContaining(["sparks", "draft"]));
    for (const a of [inv, st]) {
      const text = new Agent(a, cfg).systemPrompt().toLowerCase();
      expect(text).not.toContain("brain");
      expect(text).not.toContain(a.region.toLowerCase());
    }
  });

  it("a Storyteller suggestion reaches the Drafter's next turn", async () => {
    const { cfg, log, ltm } = await fresh();
    const script = (s: string, u: string) => {
      const out = scripted(s, u);
      if (s.startsWith("Your name is Storyteller.")) out.posts = [{ topic: "telling", text: "Open with a picture of a baseball bat." }];
      return out;
    };
    const llm = new FakeLLM(script);
    await new Brain(cfg, llm, log, ltm).run("What is 17 times 3?");
    const drafterSaw = llm.calls.filter((c) => c.system.startsWith("Your name is Drafter.")).some((c) => c.user.includes("Open with a picture"));
    expect(drafterSaw).toBe(true);
  });
});

describe("session files and demos", () => {
  it("export and import round-trip a whole session: events, audio, memories", async () => {
    const a = await fresh();
    const res = await new Brain(a.cfg, new FakeLLM(scripted), a.log, a.ltm).run("What is 17 times 3?");
    await a.log.flush();
    await a.db.put("audio", { key: `${res.session}/af_heart_1.0_0_abcdef12.wav`, session: res.session, wav: wavBlob(new Float32Array(10), 24000) });
    const file = JSON.parse(JSON.stringify(await exportSession(a.db, res.session)));
    const b = await fresh();
    expect(await importSession(b.db, file)).toBe(true);
    expect(await importSession(b.db, file)).toBe(false); // already there
    expect((await b.log.events(res.session)).length).toBe((await a.log.events(res.session)).length);
    expect((await b.db.get("audio", `${res.session}/af_heart_1.0_0_abcdef12.wav`))!.wav.size).toBe(44 + 20);
    expect(await b.ltm.count()).toBe(1);
    expect((await b.ltm.search("17 times 3"))[0][1]).toContain("51");
    await expect(importSession(b.db, { nope: 1 } as any)).rejects.toThrow("not a Tankbrain session file");
  });

  it("imports the shipped demos once, labelled as demos", async () => {
    const a = await fresh();
    const res = await new Brain(a.cfg, new FakeLLM(scripted), a.log, a.ltm).run("What is 17 times 3?");
    await a.log.flush();
    const file = await exportSession(a.db, res.session);
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => new Response(JSON.stringify(
      String(url).endsWith("index.json") ? { files: ["one.json", "../evil.json"] } : file))) as typeof fetch;
    try {
      const b = await fresh();
      expect(await importDemos(b.db)).toBe(1);
      expect(await importDemos(b.db)).toBe(0);
      expect((await b.log.sessions())[0].profile).toBe("demo · fake");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("dirksdefault profile", () => {
  it("keeps the best finds and puts everything else on Gemini 3.8 Flash", async () => {
    const { db } = await fresh();
    const cfg = await config.load("dirksdefault", db);
    const m = Object.fromEntries([...cfg.agents.values()].map((a) => [a.name, a.model]));
    expect(m.Logician).toBe("z-ai/glm-5.3-flash");
    expect(cfg.agents.get("Logician")!.think).toBe(true);
    expect(m.Storyteller).toBe("google/gemma-4-26b-a4b-it");
    expect(m.Inhibitor).toBe("google/gemma-4-26b-a4b-it");
    expect(m.Critic).toBe("z-ai/glm-5.3-flash");   // judges the Drafter's work: another family
    expect(m.Curator).toBe("z-ai/glm-5.3-flash");  // picks among Gemini ideas: another family
    expect(cfg.agents.get("Critic")!.think).toBe(false);
    const rest = Object.entries(m).filter(([n]) => !["Logician", "Storyteller", "Inhibitor", "Critic", "Curator"].includes(n));
    expect(rest.length).toBe(8);
    expect(rest.every(([, model]) => model === "google/gemini-3.8-flash")).toBe(true);
    expect([...cfg.agents.values()].filter((a) => a.name !== "Logician").every((a) => a.think === false)).toBe(true);
    expect(cfg.agents.get("Inventor")!.options.temperature).toBe(0.8); // personalities stay
  });
});
