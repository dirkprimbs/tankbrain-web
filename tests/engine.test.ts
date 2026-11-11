import { describe, expect, it } from "vitest";
import { Agent } from "../src/engine/agent";
import { Brain, NO_ANSWER } from "../src/engine/brain";
import { Bus } from "../src/engine/bus";
import * as config from "../src/engine/config";
import { Energy } from "../src/engine/energy";
import { EventLog } from "../src/engine/events";
import { FakeLLM } from "../src/engine/llm";
import { applyEdits, Draft, isPlaceholder, wordDiff } from "../src/engine/memory/draft";
import { MemoryPermissionError, WorkingMemory } from "../src/engine/memory/working";
import { schedule } from "../src/engine/scheduler";
import { fresh, scripted, who } from "./helpers";

const ctx = (question: string, inbox: any[]) => ({ question, workingMemory: "(empty)", draft: "(no draft yet)", inbox, instruction: "" });

describe("configuration", () => {
  it("loads, and profiles override", async () => {
    const { cfg, db } = await fresh();
    expect(cfg.agents.get("Drafter")!.model).toBe("fake");
    const diverse = await config.load("diverse", db);
    expect(diverse.agents.get("Drafter")!.model).toBe("qwen/qwen3-30b-a3b");
    expect(diverse.agents.get("Associator")!.options.temperature).toBe(1.0);
    const fast = await config.load("fast", db);
    expect(new Set([...fast.agents.values()].map((a) => a.model))).toEqual(new Set(["google/gemini-2.5-flash-lite"]));
    expect(fast.agents.get("Associator")!.options.temperature).toBe(1.0);
    expect(fast.agents.get("Logician")!.think).toBe(false);
  });

  it("saves a profile in the browser: disabled voices, persona, model, validation", async () => {
    const { db } = await fresh();
    const cfg = await config.saveProfile(db, "mine", {
      Critic: { model: "google/gemma-4-26b-a4b-it", temperature: 0.2, think: false },
      Associator: { enabled: false },
      Curator: { persona: "You only like ideas about cats." },
    });
    expect(cfg.agents.get("Critic")!.model).toBe("google/gemma-4-26b-a4b-it");
    expect(cfg.agents.get("Critic")!.options.temperature).toBe(0.2);
    expect(cfg.agents.has("Associator")).toBe(false);
    expect(cfg.disabled.has("Associator")).toBe(true);
    expect(cfg.agents.get("Curator")!.contacts).not.toContain("Associator");
    expect(cfg.agents.get("Curator")!.persona.startsWith("You only like ideas about cats.")).toBe(true);
    expect(cfg.agents.get("Logician")!.think).toBe(true); // unchanged voices keep agents.yaml
    expect(await config.listProfiles(db)).toContain("mine");
    const again = await config.load("mine", db); // survives a reload
    expect(again.disabled.has("Associator")).toBe(true);
    for (const bad of ["diverse", "Bad Name", "../x"]) await expect(config.saveProfile(db, bad, {})).rejects.toThrow();
    await expect(config.saveProfile(db, "mine2", { Nobody: {} })).rejects.toThrow();
  });

  it("inherits hidden options (max tokens) from the profile it is based on", async () => {
    const { db } = await fresh();
    const cfg = await config.saveProfile(db, "copy", { Drafter: { model: "google/gemini-2.5-flash" } }, "", "diverse");
    expect(cfg.agents.get("Drafter")!.options.num_predict).toBe(1200);
  });
});

describe("voices", () => {
  it("prompts never mention a brain", async () => {
    const { cfg } = await fresh();
    for (const spec of cfg.agents.values()) {
      const text = new Agent(spec, cfg).systemPrompt().toLowerCase();
      expect(text).not.toContain("brain");
      expect(text).not.toContain("neuron");
      expect(text).not.toContain(spec.region.toLowerCase());
    }
  });

  it("sees only what it is allowed to see", async () => {
    const { cfg } = await fresh();
    const bus = new Bus();
    bus.add(0, "inspiration", "input", "secret question", { topic: "inspiration" });
    bus.add(1, "Associator", "post", "ASSOC-ONLY", { topic: "associations" });
    bus.add(1, "Logician", "dm", "DM-FOR-DRAFTER", { to: "Drafter" });
    bus.add(1, "Critic", "post", "CRITIQUE-NOTE", { topic: "critique" });
    const critic = new Agent(cfg.agents.get("Critic")!, cfg);
    const prompt = critic.userPrompt(ctx("secret question", bus.unread("Critic", critic.subs, 0)));
    expect(prompt).not.toContain("ASSOC-ONLY");
    expect(prompt).not.toContain("DM-FOR-DRAFTER");
    expect(prompt).not.toContain("CRITIQUE-NOTE"); // own posts are not echoed back as news
    const drafter = new Agent(cfg.agents.get("Drafter")!, cfg);
    const inbox = bus.unread("Drafter", drafter.subs, 0);
    expect(inbox.some((m) => m.text === "DM-FOR-DRAFTER")).toBe(true);
    expect(inbox.some((m) => m.text === "ASSOC-ONLY")).toBe(false);
  });

  it("output is clamped to permissions", async () => {
    const { cfg } = await fresh();
    const out = new Agent(cfg.agents.get("Critic")!, cfg).normalise({
      thought: "x", posts: [{ topic: "plan", text: "hijack" }, { topic: "critique", text: "ok" }],
      messages: [{ to: "Voice", text: "say this" }], draft: "overwrite" });
    expect(out.posts).toEqual([{ topic: "critique", text: "ok" }]);
    expect(out.messages).toEqual([]);
    expect("draft" in out).toBe(false);
  });
});

describe("memory, echo, energy, attention", () => {
  it("has one writer per memory", () => {
    const wm = new WorkingMemory("Coordinator");
    wm.apply("Coordinator", "add_task", "check maths");
    expect(() => wm.apply("Drafter", "add_task", "sneaky")).toThrow(MemoryPermissionError);
    expect(wm.apply("Coordinator", "add_task", "check maths")).toBeNull(); // dedupe
    wm.apply("Coordinator", "close", "", 1);
    expect(wm.items[0].status).toBe("done");
    const d = new Draft("Drafter");
    expect(d.write("Drafter", "v1")).toBe(1);
    expect(d.write("Drafter", "v1")).toBeNull();
    expect(() => d.write("Critic", "mine now")).toThrow(MemoryPermissionError);
  });

  it("suppresses echoes", () => {
    const bus = new Bus();
    bus.add(1, "A", "post", "The answer is probably 51.", { topic: "logic" });
    expect(bus.isEcho("the answer is probably 51")).toBe(true);
    expect(bus.isEcho("Something entirely different about cats.")).toBe(false);
  });

  it("energy runs out", () => {
    const e = new Energy();
    let cycles = 0;
    while (!e.exhausted) {
      e.tick(0);
      cycles++;
    }
    expect(cycles).toBeLessThan(20);
    const e2 = new Energy();
    e2.reportInterest(0);
    expect(e2.level).toBe(0.5);
  });

  it("schedules by salience, grouped by model", () => {
    const c: [string, number, string][] = [["a", 5, "m1"], ["b", 4, "m2"], ["c", 3, "m1"], ["d", 1, "m2"], ["e", 0.5, "m3"]];
    expect(schedule(c, "m2", 4)).toEqual(["b", "d", "a", "c"]);
    expect(schedule(c, null, 2)).toEqual(["a", "b"]);
  });
});

describe("edit-based drafting", () => {
  it("applies exact, case/whitespace and fuzzy edits; reports failures", () => {
    const text = "The ball costs five cents.\nThe bat costs one dollar and five cents.";
    const [out, applied, failed] = applyEdits(text, [
      { find: "five cents.", replace: "$0.05." },
      { find: "the BAT costs  one dollar", replace: "The bat costs $1" },
      { find: "The bal costs", replace: "The ball costs" },
      { find: "a sentence that isn't there at all", replace: "x" },
    ]);
    expect(out).toContain("$0.05.");
    expect(out).toContain("The bat costs $1 and five cents.");
    expect(applied.length).toBe(3);
    expect(failed.length).toBe(1);
  });

  it("records versions, mode and diff", () => {
    const d = new Draft("Drafter");
    expect(d.edit("Drafter", [{ find: "x", replace: "y" }])[0]).toBeNull();
    d.write("Drafter", "It is 51.");
    const [v, failed] = d.edit("Drafter", [{ find: "51", replace: "fifty-one" }]);
    expect(v).toBe(2);
    expect(failed).toEqual([]);
    expect(d.current).toBe("It is fifty-one.");
    const last = d.last();
    expect(last.mode).toBe("edit");
    expect(last.diff).toContainEqual(["-", "51."]);
    expect(last.diff).toContainEqual(["+", "fifty-one."]);
    expect(() => d.edit("Critic", [{ find: "It", replace: "That" }])).toThrow(MemoryPermissionError);
    expect(wordDiff("a b", "a b")).toEqual([["=", "a b"]]);
  });

  it("does not take a placeholder as a version", () => {
    const d = new Draft("Drafter");
    expect(d.write("Drafter", "It takes 5 minutes.")).toBe(1);
    for (const junk of ["[empty],collected insights from note and update", "<answer here>", "[...]", "...", "{TODO}"]) {
      expect(isPlaceholder(junk)).toBe(true);
      expect(d.write("Drafter", junk)).toBeNull();
    }
    expect(d.current).toBe("It takes 5 minutes.");
    for (const fine of ["It takes 5 minutes.", "The list [1, 2, 3] sums to 6.", "Wait... what?"]) expect(isPlaceholder(fine)).toBe(false);
  });

  it("rejects replacements abbreviated with '...'", () => {
    const text = "Sunlight travels as white light. It scatters.";
    const [out, applied, failed] = applyEdits(text, [{ find: "Sunlight travels as white light.", replace: "Sunlight travels..." }]);
    expect(out).toBe(text);
    expect(applied).toEqual([]);
    expect(failed[0].why!.startsWith("replacement abbreviated")).toBe(true);
    const [out2, applied2] = applyEdits("Wait... what?", [{ find: "Wait... what?", replace: "Wait... really?" }]);
    expect(out2).toBe("Wait... really?");
    expect(applied2.length).toBe(1);
  });
});

describe("whole sessions", () => {
  it("runs a full session, stores it in the browser and recalls it next time", async () => {
    const { cfg, log, ltm } = await fresh();
    const llm = new FakeLLM(scripted);
    const res = await new Brain(cfg, llm, log, ltm).run("What is 17 times 3?");
    expect(res.answer).toBe("It's 51.");
    const ev = await log.events(res.session);
    const kinds = ev.map((e) => e.kind);
    for (const k of ["session_start", "input", "post", "dm", "draft", "memory", "interest", "verdict", "output", "session_end"]) {
      expect(kinds).toContain(k);
    }
    // the reply, word for word, plus the one suggestion two voices agreed on
    const mems = (await ltm.all()).filter((m) => !m.pinned); // besides the core beliefs
    expect(mems.length).toBe(2);
    expect(mems.find((m) => m.verbatim)!.text).toBe("It's 51.");
    const kept = mems.find((m) => m.kind === "interesting")!;
    expect(kept.from.sort()).toEqual(["Associator", "Curator"]);
    expect(kept.weight).toBeCloseTo(0.55);
    expect((await log.sessions())[0].status).toBe("done");
    // the speaker and gate never ran during thinking
    expect(ev.filter((e) => e.kind === "turn_start" && ["Voice", "Inhibitor"].includes(e.agent!)).every((e) => e.data.forced)).toBe(true);

    // a follow-up: the Listener hears first, recognises it, and the earlier reply reaches the Drafter
    const res2 = await new Brain(cfg, llm, log, ltm).run("And times 4?");
    const ev2 = await log.events(res2.session);
    expect(ev2.find((e) => e.kind === "comes_to_mind")!.data.items[0].text).toContain("51");
    expect(ev2.find((e) => e.kind === "recognised")!.data.items[0].judgement).toBe("related");
    const firstTurns = ev2.filter((e) => e.kind === "turn_start");
    expect(firstTurns[0].agent).toBe("Listener");
    expect(firstTurns[0].data.cycle).toBe(0);
    const prompts = llm.calls.filter((c) => c.system.includes("Your name is Drafter."));
    expect(prompts.slice(-6).map((c) => c.user).join("")).toContain('Earlier I was asked "What is 17 times 3?" and replied: It\'s 51.');
    // the first reply has faded to its gist; the new one is word for word
    const after = (await ltm.all()).filter((m) => !m.pinned);
    expect(after.filter((m) => m.verbatim).length).toBe(1);
    expect(after.some((m) => !m.verbatim && m.kind === "said" && m.text.startsWith("Asked what 17 times 3"))).toBe(true);
    // the same suggestion again strengthened the memory instead of adding one
    expect(after.filter((m) => m.kind === "interesting").length).toBe(1);
    expect(ev2.find((e) => e.kind === "memory_stored")!.data.reinforced.length).toBe(1);
    // the two exchanges form a thread; the faded one still knows what was asked
    const first = after.find((m) => m.kind === "said" && !m.verbatim)!;
    const second = after.find((m) => m.verbatim)!;
    expect(first.question).toBe("What is 17 times 3?");
    expect(second.question).toBe("And times 4?");
    expect(second.follows).toBe(first.id);
    // the interesting memory points to the exchange it came from
    expect(after.find((m) => m.kind === "interesting")!.context).toBe("What is 17 times 3?");

    // a follow-up of the follow-up pulls in the start of the conversation
    await new Brain(cfg, llm, log, ltm).run("And times 5?");
    const latest = llm.calls.filter((c) => c.system.includes("Your name is Drafter.")).slice(-6).map((c) => c.user).join("");
    expect(latest).toContain("This continues a conversation.");
    expect(latest).toContain('"What is 17 times 3?"');
    expect(latest).toContain('"And times 4?"');
  });

  it("drafts by edits, with sources", async () => {
    const { cfg, log, ltm } = await fresh();
    const res = await new Brain(cfg, new FakeLLM(scripted), log, ltm).run("What is 17 times 3?");
    const drafts = (await log.events(res.session)).filter((e) => e.kind === "draft").map((e) => e.data);
    expect(drafts[0].mode).toBe("initial");
    const edit = drafts.find((d) => d.mode === "edit");
    expect(edit.text).toBe("17 times 3 is 51, because 17 * 3 = 51.");
    expect(edit.sources.some((s: any) => s.from === "Critic" && s.text.includes("working"))).toBe(true);
  });

  const gatedScript = (system: string, user: string) => {
    const name = who(system);
    const out = scripted(system, user);
    if (name === "Drafter") {
      delete out.edits;
      out.ready = false;
      if (user.includes("(no draft yet)")) out.draft = "Two reasons: 2. Path length.";
      else if (user.includes("[private from Inhibitor]")) {
        out.edits = [{ find: "Two reasons: 2. Path length.", replace: "Two reasons: 1. Scattering. 2. Path length." }];
        out.ready = true;
      } else if (user.includes("Time is nearly up")) out.ready = true;
    } else if (name === "Inhibitor") {
      const ok = user.includes("1. Scattering");
      Object.assign(out, { verdict: ok ? "approve" : "reject", reason: ok ? "Fine." : "The list starts at 2; point 1 is missing." });
    } else if (name === "Voice") out.reply = "SPOKEN";
    return out;
  };

  it("wraps up in normal cycles; a rejection goes back to the Drafter", async () => {
    const { cfg, log, ltm } = await fresh();
    const brain = new Brain(cfg, new FakeLLM(gatedScript), log, ltm);
    const res = await brain.run("Why are sunsets red?");
    const ev = await log.events(res.session);
    const kinds = ev.map((e) => e.kind);
    // "time is nearly up" goes to the writer only; the others have had their say
    const signal = ev.find((e) => e.kind === "signal")!;
    expect(signal.data.to).toEqual(["Drafter"]);
    const wrapStart = ev.indexOf(signal);
    const woken = new Set(ev.slice(wrapStart).filter((e) => e.kind === "turn_start" && !e.data.forced).map((e) => e.agent));
    expect([...woken].every((a) => a === "Drafter")).toBe(true);
    expect(ev.filter((e) => e.kind === "verdict").map((e) => e.data.verdict)).toEqual(["reject", "approve"]);
    const rej = kinds.indexOf("verdict");
    expect(ev.slice(rej).some((e) => e.kind === "dm" && e.agent === "Inhibitor" && e.data.to === "Drafter")).toBe(true);
    const fix = ev.slice(rej).filter((e) => e.kind === "turn_start" && e.agent === "Drafter");
    expect(fix.length).toBeGreaterThan(0);
    expect(fix[0].data.forced).toBe(false);
    expect(brain.draft.current).toBe("Two reasons: 1. Scattering. 2. Path length.");
    expect(ev.find((e) => e.kind === "phase" && e.data.phase === "speak")!.data.reason).toBe("approved");
    expect(res.answer).toBe("SPOKEN");
  });

  it("wrap-up is bounded when the gate never approves", async () => {
    const { cfg, log, ltm } = await fresh();
    const stubborn = (s: string, u: string) => {
      const out = gatedScript(s, u);
      if (who(s) === "Inhibitor") Object.assign(out, { verdict: "reject", reason: "Still not right." });
      return out;
    };
    const res = await new Brain(cfg, new FakeLLM(stubborn), log, ltm).run("Why are sunsets red?");
    const ev = await log.events(res.session);
    expect(["rejections exhausted", "wrap-up limit"]).toContain(ev.find((e) => e.kind === "phase" && e.data.phase === "speak")!.data.reason);
    expect(res.answer).toBe("SPOKEN");
    expect(ev.filter((e) => e.kind === "verdict").length).toBeLessThanOrEqual(cfg.cycle.max_rejections + 2);
  });

  it("a draft the gate never approved is spoken with a caveat", async () => {
    const { cfg, log, ltm } = await fresh();
    const stubborn = (s: string, u: string) => {
      const out = gatedScript(s, u);
      if (who(s) === "Inhibitor") Object.assign(out, { verdict: "reject", reason: "Still not right." });
      if (who(s) === "Voice") out.reply = u.includes("not certain") ? "UNSURE" : "SURE";
      return out;
    };
    const res = await new Brain(cfg, new FakeLLM(stubborn), log, ltm).run("Why are sunsets red?");
    expect(res.answer).toBe("UNSURE");
  });

  it("with no draft at all, says so instead of letting the Voice improvise", async () => {
    const { cfg, log, ltm } = await fresh();
    const silent = (s: string, u: string) => {
      const out = gatedScript(s, u);
      if (who(s) === "Drafter") delete out.draft;
      if (who(s) === "Voice") out.reply = "Say the answer now, based on the current draft.";
      return out;
    };
    const res = await new Brain(cfg, new FakeLLM(silent), log, ltm).run("Why are sunsets red?");
    const ev = await log.events(res.session);
    expect(res.answer).toBe(NO_ANSWER);
    expect(ev.find((e) => e.kind === "phase" && e.data.phase === "speak")!.data.reason).toBe("no draft");
    expect(ev.some((e) => e.kind === "turn_start" && e.agent === "Voice")).toBe(false);
    expect(ev.some((e) => e.kind === "verdict")).toBe(false);
    expect((await ltm.all()).filter((m) => !m.pinned).length).toBe(0); // nothing worth remembering
  });

  it("stopping cancels the session and its running calls", async () => {
    const { cfg, log, ltm } = await fresh();
    const brain = new Brain(cfg, new FakeLLM(scripted, 30), log, ltm);
    const run = brain.run("What is 17 times 3?");
    await new Promise((r) => setTimeout(r, 45));
    brain.stop();
    const res = await run;
    expect(res.answer).toBeNull();
    const ev = await log.events(res.session);
    expect(ev[ev.length - 1].kind).toBe("session_end");
    expect(ev[ev.length - 1].data.cancelled).toBe(true);
    expect((await log.sessions())[0].status).toBe("cancelled");
  });

  it("marks sessions cut off by closing the page as interrupted", async () => {
    const { db, log } = await fresh();
    log.startSession("a", "q", "fast");
    log.startSession("b", "q", "fast");
    log.endSession("b", "answer");
    await log.flush();
    expect(await new EventLog(db).markInterrupted(-1)).toBe(1);
    const status = Object.fromEntries((await log.sessions()).map((s) => [s.id, s.status]));
    expect(status).toEqual({ a: "interrupted", b: "done" });
  });

  it("cloud voices think side by side, up to the parallelism setting", async () => {
    const { cfg, log, ltm } = await fresh();
    let running = 0, peak = 0;
    const llm = new FakeLLM(scripted);
    const chat = llm.chat.bind(llm);
    llm.chat = async (...a: Parameters<typeof chat>) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      try {
        return await chat(...a);
      } finally {
        running--;
      }
    };
    await new Brain(cfg, llm, log, ltm, 3).run("What is 17 times 3?");
    expect(peak).toBe(3);
    peak = 0;
    await new Brain(cfg, llm, log, ltm, 1).run("What is 17 times 3?");
    expect(peak).toBe(1);
  });
});

describe("placeholder drafts", () => {
  it("are not accepted as versions", () => {
    const d = new Draft("Drafter");
    expect(d.write("Drafter", "...")).toBeNull();
    expect(d.write("Drafter", "[]")).toBeNull();
    expect(d.write("Drafter", "It takes 5 minutes.")).toBe(1);
    expect(d.write("Drafter", "…")).toBeNull();
    expect(d.current).toBe("It takes 5 minutes.");
  });
});

describe("a session running in another tab", () => {
  it("is not marked interrupted while it is alive", async () => {
    const { db, log } = await fresh();
    log.startSession("live", "q", "fast");
    log.heartbeat("live");
    await log.flush();
    expect(await new EventLog(db).markInterrupted()).toBe(0); // alive just now
    const row = (await db.get("sessions", "live"))!;
    await db.put("sessions", { ...row, alive: Date.now() / 1000 - 120 });
    expect(await new EventLog(db).markInterrupted()).toBe(1); // silent for two minutes
  });
});

describe("a rejection travels with the latest critique", () => {
  it("so the Drafter sees both in the gate's message", async () => {
    const { cfg, log, ltm } = await fresh();
    let rejected = false;
    const script = (system: string, user: string) => {
      const out = scripted(system, user);
      const name = who(system);
      if (name === "Critic") out.posts = [{ topic: "critique", text: "Explain why people guess 10 cents." }];
      if (name === "Inhibitor" && !rejected) {
        rejected = true;
        Object.assign(out, { verdict: "reject", reason: "Remove the repeated sentence." });
      }
      return out;
    };
    const res = await new Brain(cfg, new FakeLLM(script), log, ltm).run("What is 17 times 3?");
    const dm = (await log.events(res.session)).find((e) => e.kind === "dm" && e.agent === "Inhibitor")!;
    expect(dm.data.text).toContain("Remove the repeated sentence.");
    expect(dm.data.text).toContain("Explain why people guess 10 cents.");
    expect(dm.data.text).toContain("Weigh these together");
  });
});
