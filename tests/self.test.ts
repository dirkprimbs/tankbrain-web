import { describe, expect, it } from "vitest";
import { Agent } from "../src/engine/agent";
import { Brain } from "../src/engine/brain";
import { FakeLLM } from "../src/engine/llm";
import { PROMOTE_SESSIONS } from "../src/engine/memory/longterm";
import { fresh, scripted, who } from "./helpers";

const FOUND = "I was told I run inside a web browser.";

/** The 17 * 3 script, where only the Drafter suggests a memory: something found out about itself. */
function script(prompts: Record<string, string[]>, gate = "approve", noticed = "") {
  return (system: string, user: string) => {
    const out = scripted(system, user);
    const name = who(system);
    (prompts[name] ??= []).push(user);
    delete out.suggest_memory;
    if (name === "Drafter") out.suggest_memory = { kind: "self", text: FOUND };
    if (name === "Recall") Object.assign(out, { keep: user.includes("[1]") ? [{ ref: 1, reason: "it was told so" }] : [], noticed });
    if (name === "Inhibitor" && user.includes("may become a core belief")) Object.assign(out, { verdict: gate, reason: "It held up." });
    return out;
  };
}

describe("finding out about itself", () => {
  it("only the voices that speak for the brain may suggest self-knowledge", async () => {
    const { cfg } = await fresh();
    const drafter = new Agent(cfg.agents.get("Drafter")!, cfg);
    const associator = new Agent(cfg.agents.get("Associator")!, cfg);
    expect(drafter.schema().properties.suggest_memory.properties.kind.enum).toContain("self");
    expect(associator.schema().properties.suggest_memory.properties.kind.enum).not.toContain("self");
    expect(associator.normalise({ suggest_memory: { kind: "self", text: "x" } }).suggestion).toBeNull();
    expect(drafter.normalise({ suggest_memory: { kind: "self", text: FOUND } }).suggestion).toEqual({ kind: "self", text: FOUND });
  });

  it("a discovery is kept, given to the self-aware voices, confirmed across sessions, then becomes core", async () => {
    const { cfg, log, ltm } = await fresh();
    const p1: Record<string, string[]> = {};
    const s1 = await new Brain(cfg, new FakeLLM(script(p1)), log, ltm).run("What is 17 times 3?");
    const found = (await ltm.all()).find((m) => m.text === FOUND)!;
    expect(found).toMatchObject({ kind: "self", pinned: false, seen: [s1.session], context: "What is 17 times 3?" });
    // a fresh brain: the new starting belief, and the rule against assumptions
    expect(p1.Drafter[0]).toContain("I know very little about what I am, where I am or what I'm for.");
    expect(p1.Drafter[0]).toContain("it never fills the gap with assumptions");

    const p2: Record<string, string[]> = {};
    await new Brain(cfg, new FakeLLM(script(p2)), log, ltm).run("And 17 times 4?");
    // the self-aware voices hear it; the others never do
    expect(p2.Drafter[0]).toContain(`What they have found out about themself so far (likely, not certain):\n- ${FOUND}`);
    expect(p2.Inhibitor[0]).toContain(FOUND);
    expect(p2.Associator.some((u) => u.includes(FOUND))).toBe(false);
    // and it never "comes to mind" (being judged unrelated would wear it down)
    expect((await ltm.candidates(FOUND)).some((m) => m.text === FOUND)).toBe(false);
    expect((await ltm.byText(FOUND))!.seen.length).toBe(2);

    const p3: Record<string, string[]> = {};
    const s3 = await new Brain(cfg, new FakeLLM(script(p3)), log, ltm).run("And 17 times 5?");
    const promo = (await log.events(s3.session)).find((e) => e.kind === "promotion")!;
    expect(promo.data).toMatchObject({ text: FOUND, sessions: PROMOTE_SESSIONS, promoted: true });
    expect(p3.Inhibitor.some((u) => u.includes("may become a core belief") && u.includes("My name is Norbert."))).toBe(true);
    const core = await ltm.core();
    expect(core.map((m) => m.text)).toContain(FOUND);
    expect(core.find((m) => m.text === FOUND)!.promoted).not.toBeNull();
    // core beliefs are seeded once: the promoted one isn't duplicated or handed back
    expect(await ltm.seed(cfg.self)).toBe(0);
  });

  it("a rejected promotion waits for another session; Recall can notice things too", async () => {
    const { cfg, log, ltm } = await fresh();
    const noticed = "I noticed I lose interest quickly in plain arithmetic.";
    for (const q of ["What is 17 times 3?", "And 17 times 4?", "And 17 times 5?"]) {
      await new Brain(cfg, new FakeLLM(script({}, "reject", noticed)), log, ltm).run(q);
    }
    const m = (await ltm.byText(FOUND))!;
    expect(m.pinned).toBe(false);
    expect(m.considered).toBe(PROMOTE_SESSIONS);
    // not asked again until it holds up once more; the noticed one is next in line (one per session)
    expect((await ltm.promotable()).map((x) => x.text)).toEqual([noticed]);
    const n = (await ltm.byText(noticed))!;
    expect(n.kind).toBe("self");
    expect(n.seen.length).toBe(3);
  });
});
