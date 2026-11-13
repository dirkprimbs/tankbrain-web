import { describe, expect, it } from "vitest";
import { Agent } from "../src/engine/agent";
import { Brain } from "../src/engine/brain";
import { FakeLLM } from "../src/engine/llm";
import { BASELINE, feel, label, restore } from "../src/engine/mood";
import { fresh, scripted, who } from "./helpers";

/** The 17 * 3 script, with the Listener naming a kind and the Feeler feeling something. */
function script(opts: { kind?: string; feel?: { feeling: string; valence: number; arousal: number }; prompts?: Record<string, string[]>;
}) {
  return (system: string, user: string) => {
    const out = scripted(system, user);
    const name = who(system);
    opts.prompts && (opts.prompts[name] ??= []).push(user);
    if (name === "Listener" && opts.kind) out.kind = opts.kind;
    if (name === "Feeler" && opts.feel) Object.assign(out, opts.feel);
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
    expect(rec.data.asleep).toEqual(expect.arrayContaining(["Associator", "Inventor", "Curator", "Coordinator"]));
    expect(rec.data.awake).toEqual(expect.arrayContaining(["Listener", "Drafter", "Critic", "Logician", "Feeler", "Storyteller"]));
    // the Listener went before cycle 1, and the resting voices never took a turn
    const firstCycle = events.findIndex((e) => e.kind === "cycle");
    expect(events.findIndex((e) => e.kind === "turn_start" && e.agent === "Listener")).toBeLessThan(firstCycle);
    // once the first draft is there, each resting voice gets one look: the Associator and Curator (scripted to
    // always post) speak up and stay awake, the Inventor and Coordinator (silent) go back to resting
    expect(prompts.Inventor).toHaveLength(1);
    expect(prompts.Inventor[0]).toContain("Nobody asked you");
    const init = events.find((e) => e.kind === "initiative")!;
    expect(init.data.spoke.sort()).toEqual(["Associator", "Curator"]);
    expect(init.data.silent.sort()).toEqual(["Coordinator", "Inventor"]);
    expect(events.findIndex((e) => e.kind === "draft")).toBeLessThan(events.indexOf(init));
    expect(events.filter((e) => e.kind === "initiative")).toHaveLength(1);
    expect(res.answer).toBeTruthy();

    // a private message wakes a resting voice (a turn-level check: in a full session the resting voice
    // usually reads it during its look at the first draft already)
    const b = new Brain(cfg, new FakeLLM(script({})), log, ltm);
    b.agents = new Map([...cfg.agents].map(([n, sp]) => [n, new Agent(sp, cfg)]));
    b.asleep.add("Associator");
    b.bus.add(1, "Curator", "post", "17 is prime.", { topic: "ideas" });
    expect((b as any).ready(2)[0].some(([a]: [Agent]) => a.name === "Associator")).toBe(false);
    b.bus.add(1, "Curator", "dm", "Any odd angle on 17?", { to: "Associator" });
    expect((b as any).ready(2)[0].some(([a]: [Agent]) => a.name === "Associator")).toBe(true);
    expect(b.asleep.has("Associator")).toBe(false);
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

describe("recruit table", () => {
  it("every kind recruits a working chain: what an awake voice posts reaches another awake voice", async () => {
    const { cfg } = await fresh();
    const thinking = [...cfg.agents.values()].filter((a) => a.phase === "think");
    const listed = new Set(Object.values(cfg.recruit).flat());
    for (const kind of Object.keys(cfg.recruit).filter((k) => k !== "always")) {
      const awake = new Set([...cfg.recruit.always, ...cfg.recruit[kind], ...thinking.filter((a) => !listed.has(a.name)).map((a) => a.name)]);
      // the Motivator's #mood is a side remark: its real output is the energy level
      for (const a of thinking.filter((x) => awake.has(x.name) && x.name !== "Motivator")) {
        for (const topic of a.posts_to) {
          const readers = thinking.filter((r) => r.name !== a.name && awake.has(r.name) && r.subscriptions.includes(topic));
          expect(readers.length, `${kind}: ${a.name} posts on #${topic} but nobody awake reads it`).toBeGreaterThan(0);
        }
      }
    }
  });
});
