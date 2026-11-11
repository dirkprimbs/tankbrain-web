import { describe, expect, it } from "vitest";
import { CAPACITY, DECAY, JUDGE_DELTA, LongTermMemory, NEIGHBOUR, PROTECT_SESSIONS, REINFORCE } from "../src/engine/memory/longterm";
import { fresh } from "./helpers";

const brainMemory = async () => new LongTermMemory((await fresh()).db, null, "Recall");

describe("long-term memory: weights, fading and forgetting", () => {
  it("only Recall writes it", async () => {
    const ltm = await brainMemory();
    await expect(ltm.store("Drafter", "believe", "x")).rejects.toThrow("may not write");
  });

  it("fades every session and moves with the Listener's judgement", async () => {
    const ltm = await brainMemory();
    const m = (await ltm.store("Recall", "believe", "Cats sleep most of the day.", { weight: 0.5 }))!;
    await ltm.age();
    let [now] = await ltm.all();
    expect(now.weight).toBeCloseTo(0.5 * DECAY);
    expect(now.age).toBe(1);
    await ltm.judge(m.id, "related");
    [now] = await ltm.all();
    expect(now.weight).toBeCloseTo(0.5 * DECAY + JUDGE_DELTA.related);
    expect(now.uses).toBe(1);
    await ltm.judge(m.id, "unrelated");
    [now] = await ltm.all();
    expect(now.weight).toBeCloseTo(0.5 * DECAY + JUDGE_DELTA.related + JUDGE_DELTA.unrelated);
    expect(now.uses).toBe(1); // unrelated isn't a use
    await ltm.reinforce(m.id);
    [now] = await ltm.all();
    expect(now.weight).toBeCloseTo(0.5 * DECAY + JUDGE_DELTA.related + JUDGE_DELTA.unrelated + REINFORCE);
  });

  it("keeps the latest reply word for word; the one before fades to its gist", async () => {
    const ltm = await brainMemory();
    await ltm.said("Recall", "A long first reply with all its details.", "first?", "Asked first; answered with details.", "s1");
    await ltm.said("Recall", "The second reply.", "second?", "Asked second.", "s2");
    const all = await ltm.all();
    expect(all.filter((m) => m.verbatim).map((m) => m.text)).toEqual(["The second reply."]);
    expect(all.find((m) => !m.verbatim)!.text).toBe("Asked first; answered with details.");
    // the latest reply always comes to mind, whatever the wording
    expect((await ltm.candidates("something else entirely"))[0].text).toBe("The second reply.");
  });

  it("forgets the weakest beyond capacity, but not the new or the latest reply", async () => {
    const ltm = await brainMemory();
    await ltm.said("Recall", "Latest reply.", "q", "gist", null);
    for (let i = 0; i < CAPACITY + 4; i++) await ltm.store("Recall", "believe", `belief number ${i}`, { weight: 0.2 + i / 1000 });
    expect(await ltm.forget()).toEqual([]); // all still young
    for (let i = 0; i < PROTECT_SESSIONS; i++) await ltm.age();
    const gone = await ltm.forget();
    expect(gone.length).toBe(5); // back to capacity
    expect(gone.map((m) => m.text)).toContain("belief number 0"); // the weakest went first
    expect(await ltm.count()).toBe(CAPACITY);
    expect((await ltm.all()).some((m) => m.verbatim)).toBe(true);
  });

  it("forgets what has faded away even under capacity", async () => {
    const ltm = await brainMemory();
    await ltm.store("Recall", "interesting", "barely there", { weight: 0.04 });
    await ltm.store("Recall", "interesting", "still strong", { weight: 0.8 });
    for (let i = 0; i < PROTECT_SESSIONS; i++) await ltm.age();
    expect((await ltm.forget()).map((m) => m.text)).toEqual(["barely there"]);
  });

  it("reads memories from before weights existed as weak beliefs", async () => {
    const { db } = await fresh();
    await db.add("memories", { session: null, created: 1, text: "old style memory", embedding: null });
    const [m] = await new LongTermMemory(db).all();
    expect(m.kind).toBe("believe");
    expect(m.weight).toBeCloseTo(0.3);
  });

  it("links a conversation into a thread and keeps it in order when the middle is forgotten", async () => {
    const ltm = await brainMemory();
    const a = await ltm.said("Recall", "Reply A", "Question A?", "gist A", "s1");
    const b = await ltm.said("Recall", "Reply B", "Question B?", "gist B", "s2", a.id);
    const c = await ltm.said("Recall", "Reply C", "Question C?", "gist C", "s3", b.id);
    expect((await ltm.thread(c)).map((m) => m.question)).toEqual(["Question A?", "Question B?"]);
    expect((await ltm.thread(c, 1)).map((m) => m.question)).toEqual(["Question B?"]);
    // a faded exchange keeps its question
    expect((await ltm.all()).find((m) => m.id === a.id)!.text).toBe("gist A");
    // the middle fades out: the thread closes over it
    for (let i = 0; i < PROTECT_SESSIONS; i++) await ltm.age();
    const rowB = (await ltm.all()).find((m) => m.id === b.id)!;
    await ltm["db"].put("memories", { ...rowB, weight: 0.01 } as any);
    expect((await ltm.forget()).map((m) => m.id)).toEqual([b.id]);
    expect((await ltm.all()).find((m) => m.id === c.id)!.follows).toBe(a.id);
  });

  it("a belief keeps what was asked when the exchange it came from is forgotten", async () => {
    const ltm = await brainMemory();
    const ex = await ltm.said("Recall", "Reply", "Is the sky blue?", "gist", "s1");
    await ltm.said("Recall", "Next", "Something else?", "gist 2", "s2"); // ex is no longer the latest
    const belief = (await ltm.store("Recall", "believe", "Rayleigh scattering explains it.", { origin: ex.id, context: "Is the sky blue?" }))!;
    for (let i = 0; i < PROTECT_SESSIONS; i++) await ltm.age();
    const rowEx = (await ltm.all()).find((m) => m.id === ex.id)!;
    await ltm["db"].put("memories", { ...rowEx, weight: 0.01 } as any);
    await ltm.forget();
    const after = (await ltm.all()).find((m) => m.id === belief.id)!;
    expect(after.origin).toBeNull();
    expect(after.context).toBe("Is the sky blue?");
  });

  it("using a memory strengthens the memories linked to it a little", async () => {
    const ltm = await brainMemory();
    const ex = await ltm.said("Recall", "Reply", "Q?", "gist", "s1");
    const belief = (await ltm.store("Recall", "believe", "A belief.", { weight: 0.5, origin: ex.id }))!;
    await ltm.judge(ex.id, "related");
    expect((await ltm.all()).find((m) => m.id === belief.id)!.weight).toBeCloseTo(0.5 + NEIGHBOUR);
    await ltm.judge(ex.id, "reminds"); // only a real use spreads
    expect((await ltm.all()).find((m) => m.id === belief.id)!.weight).toBeCloseTo(0.5 + NEIGHBOUR);
  });
});
