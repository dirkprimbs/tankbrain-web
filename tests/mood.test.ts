import { describe, expect, it } from "vitest";
import { Agent } from "../src/engine/agent";
import { Brain } from "../src/engine/brain";
import { FakeLLM } from "../src/engine/llm";
import { BASELINE, feel, label, restore } from "../src/engine/mood";
import { fresh, scripted, who } from "./helpers";

/** The 17 * 3 script, with the Listener naming a kind and the Feeler feeling something. */
function script(opts: { kind?: string; feel?: { feeling: string; valence: number; arousal: number }; prompts?: Record<string, string[]>;
                        dmAssociator?: boolean }) {
  return (system: string, user: string) => {
    const out = scripted(system, user);
    const name = who(system);
    opts.prompts && (opts.prompts[name] ??= []).push(user);
    if (name === "Listener" && opts.kind) out.kind = opts.kind;
    if (name === "Feeler" && opts.feel) Object.assign(out, opts.feel);
    if (name === "Curator" && opts.dmAssociator) out.messages = [{ to: "Associator", text: "Any odd angle on 17?" }];
    return out;
  };
}

describe("recruiting", () => {
  it("the Listener hears first and names the kind; only the voices it needs think, a private message wakes one", async () => {
    const { cfg, log, ltm } = await fresh();
    const prompts: Record<string, string[]> = {};
    const res = await new Brain(cfg, new FakeLLM(script({ kind: "calculation", prompts })), log, ltm).run("What is 17 times 3?");
    const events = await log.events(res.session);
    const rec = events.find((e) => e.kind === "recruited")!;
    expect(rec.agent).toBe("Listener");
    expect(rec.data.kind).toBe("calculation");
    expect(rec.data.asleep).toEqual(expect.arrayContaining(["Associator", "Inventor", "Curator", "Storyteller", "Coordinator"]));
    expect(rec.data.awake).toEqual(expect.arrayContaining(["Listener", "Drafter", "Critic", "Logician", "Feeler"]));
    // the Listener went before cycle 1, and the resting voices never took a turn
    const firstCycle = events.findIndex((e) => e.kind === "cycle");
    expect(events.findIndex((e) => e.kind === "turn_start" && e.agent === "Listener")).toBeLessThan(firstCycle);
    for (const v of ["Associator", "Inventor", "Storyteller"]) expect(prompts[v]).toBeUndefined();
    expect(res.answer).toBeTruthy();

    // an explanation: the Curator thinks along but the Associator rests, until the Curator writes to it
    const res2 = await new Brain(cfg, new FakeLLM(script({ kind: "explanation", dmAssociator: true })), log, ltm).run("Why 51?");
    const ev2 = await log.events(res2.session);
    expect(ev2.find((e) => e.kind === "recruited" && e.data.kind)!.data.asleep).toContain("Associator");
    expect(ev2.find((e) => e.kind === "recruited" && e.data.woken)!.data).toEqual({ woken: "Associator", by: "Curator" });
    expect(ev2.some((e) => e.kind === "turn_start" && e.agent === "Associator")).toBe(true);
  });

  it("asks for a kind from the recruit table; the Coordinator no longer gives orders", async () => {
    const { cfg } = await fresh();
    const listener = new Agent(cfg.agents.get("Listener")!, cfg);
    expect(listener.schema().properties.kind.enum).toEqual(expect.arrayContaining(["fact", "story", "about me"]));
    expect(listener.normalise({ kind: "Story" }).kind).toBe("story");
    expect(listener.normalise({ kind: "poem" }).kind).toBeNull();
    expect(cfg.agents.get("Coordinator")!.contacts).toEqual([]);
  });
});

describe("mood", () => {
  it("moves with what the Feeler feels, is carried over, and colours the self-aware voices", async () => {
    const { cfg, db, log, ltm } = await fresh();
    const prompts: Record<string, string[]> = {};
    const res = await new Brain(cfg, new FakeLLM(script({ feel: { feeling: "Delighted", valence: 5, arousal: 9 }, prompts })), log, ltm)
      .run("What is 17 times 3?");
    const moods = (await log.events(res.session)).filter((e) => e.kind === "mood");
    expect(moods[0].data).toMatchObject({ why: "carried over", word: "curious", valence: BASELINE.valence });
    const felt = moods.find((e) => e.agent === "Feeler")!;
    expect(felt.data.word).toBe("delighted");
    expect(felt.data.valence).toBeGreaterThan(BASELINE.valence);
    const row = (await db.get("sessions", res.session))!;
    expect(row.mood!.word).toBe(moods.at(-1)!.data.word);
    // the voices that speak for the brain hear it, the others don't
    expect(prompts.Drafter.at(-1)).toMatch(/Right now they feel delighted \(pleasant, /);
    expect(prompts.Associator?.some((u) => u.includes("Right now they feel"))).toBeFalsy();

    // the next session starts from it
    const res2 = await new Brain(cfg, new FakeLLM(script({})), log, ltm).run("And 17 times 4?");
    const carried = (await log.events(res2.session)).find((e) => e.kind === "mood")!;
    expect(carried.data.word).toBe("delighted");
  });

  it("drifts back to the temperament between sessions", () => {
    const t = 1_000_000;
    const m = feel(restore(null, t), -5, 10, "Furious", t);
    expect(m.word).toBe("furious");
    expect(m.valence).toBeLessThan(0);
    const soon = restore(m, t + 600);
    expect(soon.word).toBe("furious");
    const later = restore(m, t + 24 * 3600);
    expect(Math.abs(later.valence - BASELINE.valence)).toBeLessThan(0.02);
    expect(later.word).toBe(label(later.valence, later.arousal));
    expect(label(BASELINE.valence, BASELINE.arousal)).toBe("curious");
  });
});
