import { describe, expect, it } from "vitest";
import { Brain } from "../src/engine/brain";
import { FakeLLM } from "../src/engine/llm";
import { LongTermMemory, PROTECT_SESSIONS } from "../src/engine/memory/longterm";
import { fresh, scripted, who } from "./helpers";

const NAME = "My name is Norbert.";

/** The scripted brain, plus: a voice suggests a new name, Recall proposes it as
 * replacing the core belief, and the Inhibitor weighs it as told. */
const challenging = (convinced: boolean) => (system: string, user: string) => {
  const out = scripted(system, user);
  const name = who(system);
  if (name === "Logician") out.suggest_memory = { kind: "believe", text: "My name is Bob." };
  if (name === "Recall") {
    const core = /#(\d+) \(core belief\) My name is/.exec(user);
    const ref = user.split("\n").find((l) => l.includes("My name is Bob."))?.match(/^\[(\d+)\]/)?.[1];
    out.keep = core && ref ? [{ ref: Number(ref), reason: "they told me", replaces: Number(core[1]) }] : [];
  }
  if (name === "Inhibitor" && user.includes("core beliefs about yourself is being questioned")) {
    Object.assign(out, convinced ? { verdict: "approve", reason: "It has come up again and again." }
                                 : { verdict: "reject", reason: "Being told so once is not a reason." });
  }
  return out;
};

describe("core beliefs: who the brain is", () => {
  it("a fresh brain is seeded once; core beliefs never fade or get forgotten", async () => {
    const { db, cfg } = await fresh();
    const ltm = new LongTermMemory(db, null, "Recall");
    expect(await ltm.seed(cfg.self)).toBe(cfg.self.length);
    expect(await ltm.seed(cfg.self)).toBe(0); // only once
    expect((await ltm.core()).map((m) => m.text)).toContain(NAME);
    for (let i = 0; i < PROTECT_SESSIONS + 5; i++) await ltm.age();
    for (const m of await ltm.core()) expect(m.weight).toBe(1); // no fading
    await ltm.forget(0); // even with no room at all
    expect((await ltm.core()).length).toBe(cfg.self.length);
  });

  it("an existing brain gets a belief added to the starting set later, but not one it has changed", async () => {
    const { db } = await fresh();
    const ltm = new LongTermMemory(db, null, "Recall");
    await ltm.seed([NAME, "I am warm."]);
    const name = (await ltm.core()).find((m) => m.text === NAME)!;
    await ltm.changeCore("Recall", name.id, "My name is Bob.");
    expect(await ltm.seed([NAME, "I am warm.", "I keep stories punchy."])).toBe(1);
    expect((await ltm.core()).map((m) => m.text)).toEqual(["My name is Bob.", "I am warm.", "I keep stories punchy."]);
    // a core belief from before starting texts were recorded counts by its text
    await db.add("memories", { kind: "believe", text: "I like tea.", weight: 1, pinned: true } as any);
    expect(await ltm.seed(["I like tea."])).toBe(0);
  });

  it("only the voices that speak for the brain, or check what it says, know who it is", async () => {
    const { cfg, log, ltm } = await fresh();
    const llm = new FakeLLM(scripted);
    await new Brain(cfg, llm, log, ltm).run("Who are you?");
    const saw = (n: string) => llm.calls.filter((c) => c.system.includes(`Your name is ${n}.`)).some((c) => c.user.includes(NAME));
    for (const n of ["Listener", "Drafter", "Critic", "Inhibitor", "Voice"]) expect(saw(n)).toBe(true);
    for (const n of ["Logician", "Associator", "Motivator", "Coordinator"]) expect(saw(n)).toBe(false);
  });

  it("being told another name once doesn't change it, even if the brain is persuaded", async () => {
    const { cfg, log, ltm } = await fresh();
    const res = await new Brain(cfg, new FakeLLM(challenging(true)), log, ltm).run("Your name is Bob now.");
    const r = (await log.events(res.session)).find((e) => e.kind === "reconsidered")!.data;
    expect(r).toMatchObject({ belief: NAME, proposed: "My name is Bob.", convinced: true, sessions: 1, changed: false });
    expect((await ltm.core()).map((m) => m.text)).toContain(NAME);
    expect((await ltm.all()).some((m) => m.text === "My name is Bob.")).toBe(false); // never next to it
  });

  it("an unconvinced brain keeps its name however often it is told", async () => {
    const { cfg, log, ltm } = await fresh();
    for (const q of ["Your name is Bob.", "Really, it's Bob.", "Bob! Your name is Bob."]) {
      await new Brain(cfg, new FakeLLM(challenging(false)), log, ltm).run(q);
    }
    const core = await ltm.core();
    expect(core.map((m) => m.text)).toContain(NAME);
    expect(LongTermMemory.doubtSessions(core.find((m) => m.text === NAME)!)).toBe(3);
  });

  it("a belief questioned in several sessions, and reconsidered convincingly, changes", async () => {
    const { cfg, log, ltm } = await fresh();
    await new Brain(cfg, new FakeLLM(challenging(true)), log, ltm).run("Your name is Bob.");
    const res = await new Brain(cfg, new FakeLLM(challenging(true)), log, ltm).run("As I said: Bob.");
    const r = (await log.events(res.session)).find((e) => e.kind === "reconsidered")!.data;
    expect(r).toMatchObject({ sessions: 2, convinced: true, changed: true });
    const core = await ltm.core();
    expect(core.map((m) => m.text)).toContain("My name is Bob.");
    expect(core.map((m) => m.text)).not.toContain(NAME);
    expect(core.find((m) => m.text === "My name is Bob.")!.doubts).toEqual([]); // settled
  });
});
