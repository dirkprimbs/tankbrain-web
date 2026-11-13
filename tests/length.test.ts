import { describe, expect, it } from "vitest";
import { Agent, moodText } from "../src/engine/agent";
import { Brain, sizeOf, wordCount } from "../src/engine/brain";
import { FakeLLM } from "../src/engine/llm";
import { LENGTH_BELIEFS } from "../src/engine/memory/longterm";
import { fresh, scripted, who } from "./helpers";

const LONG_DRAFT = "Seventeen times three is fifty-one. " + "Here is a lot more that nobody asked for. ".repeat(10);

/** The 17 * 3 script, with the Listener's judgement and the first draft as given. */
function script(opts: { size?: string; feedback?: string; draft?: string; prompts?: Record<string, string[]> }) {
  return (system: string, user: string) => {
    const out = scripted(system, user);
    const name = who(system);
    opts.prompts && (opts.prompts[name] ??= []).push(user);
    if (name === "Listener") {
      if (opts.size) out.size = opts.size;
      if (opts.feedback) out.length_feedback = opts.feedback;
    }
    if (name === "Drafter" && opts.draft && user.includes("(no draft yet)")) out.draft = opts.draft;
    return out;
  };
}

describe("reply size", () => {
  it("the Listener judges it; the writer, critic and gate are told; a long version gets a note", async () => {
    const { cfg, log, ltm } = await fresh();
    const prompts: Record<string, string[]> = {};
    const res = await new Brain(cfg, new FakeLLM(script({ size: "a sentence", draft: LONG_DRAFT, prompts })), log, ltm).run("What is 17 times 3?");
    const events = await log.events(res.session);
    expect(events.find((e) => e.kind === "size")!.data).toEqual({ size: "a sentence", words: 30 });
    for (const voice of ["Drafter", "Critic", "Inhibitor", "Voice"]) {
      expect(prompts[voice].some((p) => p.includes("## Reply size\nAbout a sentence (at most about 30 words)"))).toBe(true);
    }
    const tooLong = events.find((e) => e.kind === "too_long")!;
    expect(tooLong.data).toMatchObject({ version: 1, size: "a sentence", limit: 30, words: wordCount(LONG_DRAFT) });
    expect(prompts.Drafter.some((p) => p.includes("Cut it down"))).toBe(true);
    expect(events.find((e) => e.kind === "output")!.data.words).toBe(2); // "It's 51."
  });

  it("asks the Listener for size and feedback, the Voice for a mood", async () => {
    const { cfg } = await fresh();
    const listener = new Agent(cfg.agents.get("Listener")!, cfg);
    expect(listener.schema().required).toEqual(expect.arrayContaining(["size", "length_feedback"]));
    expect(listener.normalise({ size: "A Paragraph", length_feedback: "maybe" })).toMatchObject({ size: "a paragraph", lengthFeedback: null });
    const voice = new Agent(cfg.agents.get("Voice")!, cfg);
    expect(Object.keys(voice.schema().properties)).toEqual(["thought", "feeling", "energy", "pace", "timing", "reply"]);
    expect(moodText({ feeling: "amused", energy: "high", pace: "brisk", timing: "pause before the twist" }))
      .toBe("Amused, with high energy, at a brisk pace. Pause before the twist.");
    expect(moodText({ feeling: "", energy: "high", pace: "", timing: "" })).toBe("");
    expect([10, 60, 150, 300].map(sizeOf)).toEqual(["a sentence", "a few sentences", "a paragraph", "long"]);
  });
});

describe("learning how much the person wants", () => {
  it("being stopped mid-reply teaches 'short'; asking for more shifts it back", async () => {
    const { cfg, db, log, ltm } = await fresh();
    const first = await new Brain(cfg, new FakeLLM(script({})), log, ltm).run("What is 17 times 3?");
    // nothing to judge on a first exchange
    expect((await log.events(first.session)).some((e) => e.kind === "length_feedback")).toBe(false);

    // the person stops the spoken reply after the first of three parts
    const row = (await db.get("sessions", first.session))!;
    await db.put("sessions", { ...row, stopped: { heard: 1, of: 3 } });
    const prompts: Record<string, string[]> = {};
    const second = await new Brain(cfg, new FakeLLM(script({ feedback: "fine", prompts })), log, ltm).run("And 17 times 4?");
    expect(prompts.Listener[0]).toContain('## How your replies go down\nYour previous reply, to "What is 17 times 3?", was 2 words (a sentence). ' +
      "The person stopped it after hearing 1 of its 3 parts.");
    const fb = (await log.events(second.session)).find((e) => e.kind === "length_feedback")!;
    expect(fb.data).toMatchObject({ verdict: "too long", said: "fine", learned: { text: LENGTH_BELIEFS.short, new: true } });
    const short = (await ltm.byText(LENGTH_BELIEFS.short))!;
    expect(short.kind).toBe("believe");

    // the next message asks for more: the other belief grows, this one weakens
    const prompts3: Record<string, string[]> = {};
    const third = await new Brain(cfg, new FakeLLM(script({ feedback: "too short", prompts: prompts3 })), log, ltm).run("Why? Tell me more.");
    expect(prompts3.Listener[0]).toContain(`What you have learned: ${LENGTH_BELIEFS.short}`);
    const fb3 = (await log.events(third.session)).find((e) => e.kind === "length_feedback")!;
    expect(fb3.data.learned).toMatchObject({ text: LENGTH_BELIEFS.long, new: true });
    expect(fb3.data.weakened.weight).toBeLessThan(short.weight);
    // length beliefs never "come to mind" by similarity (judging them unrelated would wear them down)
    expect((await ltm.candidates(LENGTH_BELIEFS.short)).some((m) => m.text === LENGTH_BELIEFS.short)).toBe(false);
  });
});

describe("a settling draft", () => {
  it("from version 3 on, the writer is told to fix rather than swap in new material (once)", async () => {
    const { cfg, log, ltm } = await fresh();
    const prompts: string[] = [];
    let n = 0;
    const s = (system: string, user: string) => {
      const out = scripted(system, user);
      const name = who(system);
      if (name === "Drafter") {
        prompts.push(user);
        out.draft = `Draft number ${++n}: seventeen times three is fifty-one.`; // a new version every turn
      }
      if (name === "Critic") out.posts = [{ topic: "critique", text: `Point ${n}: try another angle.` }];
      return out;
    };
    const res = await new Brain(cfg, new FakeLLM(s), log, ltm).run("What is 17 times 3?");
    const events = await log.events(res.session);
    const settling = events.filter((e) => e.kind === "settling");
    expect(settling).toHaveLength(1);
    expect(settling[0].data.version).toBe(3);
    expect(prompts.some((p) => p.includes("The draft is settling."))).toBe(true);
  });

  it("clarity is something the critic and the gate check; the Curator no longer lobbies the writer", async () => {
    const { cfg } = await fresh();
    expect(cfg.agents.get("Inhibitor")!.persona).toMatch(/can't be\s+followed by someone hearing it once/);
    expect(cfg.agents.get("Critic")!.persona).toContain("never saw the notes");
    expect(cfg.agents.get("Drafter")!.persona).toContain("replace, don't stack");
    expect(cfg.agents.get("Curator")!.contacts).not.toContain("Drafter");
  });
});
