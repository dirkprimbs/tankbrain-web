// The brain in the tank: wires voices, board, memory, attention and drive
// into one session that runs from an inspiration to a spoken reply.

import { Agent, type Output } from "./agent";
import { Bus, INPUT_TOPIC, type Message } from "./bus";
import { owner, publicView, type BrainConfig } from "./config";
import { Energy } from "./energy";
import type { EventLog } from "./events";
import type { LLM } from "./llm";
import { Draft } from "./memory/draft";
import type { LongTermMemory } from "./memory/longterm";
import { MemoryPermissionError, WorkingMemory } from "./memory/working";
import { salience, schedule } from "./scheduler";

export const WRAP_SIGNAL = "Time is nearly up. Only say what helps finish the answer now; otherwise stay silent.";
export const GATE =
  "Check the current draft against the matter at hand, reading it exactly as the listener will hear it. " +
  "Approve if it answers it well. Reject only for a real problem: it misses the question, contains a clear " +
  "error, makes unsupported claims, is badly overconfident, or doesn't read as one coherent answer (parts " +
  "repeated, missing or out of order). If you reject, say exactly what must change.";
export const SPEAK =
  "Say the answer now, based on the current draft. Speak directly and naturally to whoever raised the matter. " +
  "Don't mention drafts, notes, a team or anyone else. Keep every number, formula, name and fact exactly as written. " +
  "If the draft already reads well, say it almost word for word; only smooth what is awkward.";
export const REMEMBER = (answer: string) =>
  "The matter has been settled. This is the answer that was given:\n\n" + answer + "\n\n" +
  "List in 'remember' up to 3 short things worth keeping in mind for the future " +
  "(the question and the gist of the answer, a useful insight). Leave out trivia.";

/** Optional spoken output channel (Kokoro in the browser). */
export interface AudioChannel {
  deliver(text: string, session: string, emit: (kind: string, data: Record<string, any>) => void,
          cancelled: () => boolean): Promise<unknown>;
}

export class Cancelled extends Error {
  constructor() {
    super("cancelled");
  }
}

/** At most n tasks at a time (how many cloud voices may think side by side). */
class Semaphore {
  private waiting: (() => void)[] = [];
  constructor(private free: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.free > 0) this.free--;
    else await new Promise<void>((r) => this.waiting.push(r));
    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.free++;
    }
  }
}

const isAbort = (e: unknown) => e instanceof Cancelled || (e instanceof DOMException && e.name === "AbortError");

export class Brain {
  cancelled = false;
  session = "";
  question = "";
  agents = new Map<string, Agent>();
  bus = new Bus();
  wm!: WorkingMemory;
  draft!: Draft;
  energy!: Energy;
  cycle = 0;
  drafterReady = false;
  private loadedModel: string | null = null;
  private sem!: Semaphore;
  private abort = new AbortController();
  private cloudConcurrency: number;

  constructor(public cfg: BrainConfig, private llm: LLM, private log: EventLog,
              private ltm: LongTermMemory | null = null, cloudConcurrency = 4,
              private audio: AudioChannel | null = null) {
    this.cloudConcurrency = Math.max(1, Math.trunc(cloudConcurrency));
  }

  /** Stop the session: running model calls are aborted. */
  stop(): void {
    this.cancelled = true;
    this.abort.abort();
  }

  // --- helpers ----------------------------------------------------------
  emit(kind: string, agent: string | null = null, data: Record<string, any> = {}): void {
    this.log.emit(this.session, kind, agent, data);
  }

  private subs(): Map<string, Set<string>> {
    return new Map([...this.agents].map(([n, a]) => [n, a.subs]));
  }

  /** Voices with something new to read. During wrap-up only what is addressed to a
   * voice (a private message or a signal) wakes it: board posts no longer do, so
   * only voices with something to finish take a turn. */
  private ready(cycle: number, wrap = false): [[Agent, number, string][], number] {
    const ready: [Agent, number, string][] = [];
    let pending = 0;
    for (const a of this.agents.values()) {
      if (a.spec.phase !== "think") continue;
      let unread = this.bus.unread(a.name, a.subs, a.state.lastSeen);
      if (wrap) unread = unread.filter((m) => m.kind === "dm" || m.kind === "signal");
      if (!unread.length) continue;
      pending++;
      if (cycle - a.state.lastCycle > a.spec.cooldown) ready.push([a, salience(unread), a.spec.model]);
    }
    return [ready, pending];
  }

  // --- one turn -----------------------------------------------------------
  async turn(agent: Agent, cycle: number, instruction = ""): Promise<[number, Output]> {
    if (this.cancelled) throw new Cancelled();
    const inbox = this.bus.unread(agent.name, agent.subs, agent.state.lastSeen);
    const ctx = { question: this.question, workingMemory: this.wm.render(), draft: this.draft.render(), inbox, instruction };
    agent.state.lastSeen = this.bus.messages.length;
    agent.state.lastCycle = cycle;
    agent.state.turns++;

    this.emit("turn_start", agent.name, { model: agent.spec.model, cycle, inbox: inbox.length, forced: !!instruction });
    let res;
    try {
      res = await this.llm.chat(agent.spec.model, agent.systemPrompt(), agent.userPrompt(ctx), agent.schema(),
                                agent.spec.options, agent.spec.think, this.abort.signal);
    } catch (e) {
      if (this.cancelled || isAbort(e)) throw e;
      // one voice's failure (e.g. a timeout) costs that voice its turn, not the session
      res = { data: {}, thinking: "", seconds: 0, loadSeconds: 0, tokens: 0, raw: "", error: String(e) };
    }
    if (this.cancelled) throw new Cancelled();
    if (res.error) this.emit("error", agent.name, { error: res.error });
    const out = agent.normalise(res.data);
    this.emit("turn_end", agent.name, { seconds: round(res.seconds, 2), load_seconds: round(res.loadSeconds, 2), tokens: res.tokens });
    if (out.thought || res.thinking) this.emit("thought", agent.name, { text: out.thought, reasoning: res.thinking.slice(0, 4000) });

    let fresh = 0;
    for (const p of out.posts) {
      if (this.bus.isEcho(p.text)) {
        this.emit("suppressed", agent.name, { topic: p.topic, text: p.text });
        continue;
      }
      const msg = this.bus.add(cycle, agent.name, "post", p.text, { topic: p.topic });
      agent.state.ownNotes.push(p.text.slice(0, 300));
      this.emit("post", agent.name, { topic: p.topic, text: p.text, id: msg.id, recipients: this.bus.recipients(msg, this.subs()) });
      fresh++;
    }
    for (const m of out.messages) {
      const msg = this.bus.add(cycle, agent.name, "dm", m.text, { to: m.to });
      agent.state.ownNotes.push(`(to ${m.to}) ${m.text.slice(0, 280)}`);
      this.emit("dm", agent.name, { to: m.to, text: m.text, id: msg.id });
    }

    if (agent.can("write_memory") && out.notebook?.length) {
      let changed = false;
      for (const op of out.notebook) {
        try {
          const ref = typeof op.ref === "number" ? Math.trunc(op.ref) : null;
          const item = this.wm.apply(agent.name, String(op.op ?? ""), String(op.text || ""), ref);
          changed = changed || item !== null;
        } catch (e) {
          if (!(e instanceof MemoryPermissionError)) throw e;
        }
      }
      if (changed) this.emit("memory", agent.name, { items: this.wm.snapshot() });
    }

    if (agent.can("write_draft")) {
      this.updateDraft(agent, cycle, out, inbox, instruction);
      if (out.ready) {
        this.drafterReady = true;
        this.emit("ready", agent.name, { version: this.draft.version });
      }
    }

    if (agent.can("interest") && out.interest !== null && out.interest !== undefined) {
      const level = this.energy.reportInterest(out.interest);
      this.emit("interest", agent.name, { value: out.interest, level: round(level, 3) });
    }
    return [fresh, out];
  }

  /** Edits once a draft exists; a full text only for the first version (or,
   * recorded as such, a rewrite). Failed edits go back to the Drafter. */
  private updateDraft(agent: Agent, cycle: number, out: Output, inbox: Message[], instruction: string): void {
    let v: number | null = null;
    let failed: { find: string; replace: string; why?: string }[] = [];
    if (this.draft.version && out.edits?.length) [v, failed] = this.draft.edit(agent.name, out.edits);
    else if (out.draft) v = this.draft.write(agent.name, out.draft);
    if (failed.length) {
      const listing = failed.map((f) => `"${f.find.slice(0, 120)}" (${f.why ?? "passage not found"})`).join("; ");
      const msg = this.bus.add(cycle, "draft", "signal",
        `These edits were not made: ${listing}. Copy 'find' passages exactly from the current ` +
        "draft and write replacements out in full, never abbreviated with '...'.", { to: agent.name });
      this.emit("edit_failed", agent.name, { failed, id: msg.id });
    }
    if (!v) return;
    // what this version is a response to: everything the Drafter read this turn
    const sources = inbox.filter((m) => m.kind !== "input")
      .map((m) => ({ from: m.sender, kind: m.kind, topic: m.topic, text: m.text.slice(0, 400) }));
    if (instruction) sources.push({ from: "time", kind: "signal", topic: null, text: instruction.slice(0, 200) });
    this.emit("draft", agent.name, { sources, note: out.note ?? "", ...this.draft.last() });
    if ("draft" in this.cfg.topics) {
      const mode = this.draft.history[this.draft.history.length - 1].mode;
      const what = { initial: "First draft written", edit: "Draft edited", rewrite: "Draft rewritten" }[mode];
      const note = out.note ? ` ${out.note}` : "";
      const msg = this.bus.add(cycle, agent.name, "post", `${what} (version ${v}).${note}`, { topic: "draft" });
      this.emit("post", agent.name, { topic: "draft", text: msg.text, id: msg.id, system: true,
                                      recipients: this.bus.recipients(msg, this.subs()) });
    }
  }

  // --- a whole session ----------------------------------------------------
  async run(text: string, session?: string): Promise<{ session: string; answer: string | null }> {
    const cfg = this.cfg;
    this.session = session ?? newSessionId();
    this.question = String(text).trim(); // the inspiration channel: a question or idea popping up
    this.agents = new Map([...cfg.agents].map(([n, s]) => [n, new Agent(s, cfg)]));
    this.bus = new Bus();
    this.wm = new WorkingMemory(owner(cfg, "write_memory") ?? "");
    this.draft = new Draft(owner(cfg, "write_draft") ?? "");
    this.energy = new Energy(cfg.energy);
    this.cycle = 0;
    this.drafterReady = false;
    this.sem = new Semaphore(this.cloudConcurrency);
    const t0 = performance.now();
    const elapsed = () => round((performance.now() - t0) / 1000, 1);

    this.log.startSession(this.session, this.question, cfg.profile);
    this.emit("session_start", null, { question: this.question, profile: cfg.profile,
      agents: [...cfg.agents.values()].map(publicView), topics: cfg.topics, input_pos: cfg.input_pos });
    try {
      const msg = this.bus.add(0, "inspiration", "input", this.question, { topic: INPUT_TOPIC });
      this.emit("input", null, { channel: "inspiration", text: this.question, recipients: this.bus.recipients(msg, this.subs()) });

      const recall = owner(cfg, "remember");
      if (recall && this.ltm) {
        const hits = await this.ltm.search(this.question);
        const a = this.agents.get(recall)!;
        a.state.private = hits.map(([, h]) => h);
        if (!hits.length) a.state.lastSeen = this.bus.messages.length; // nothing comes to mind: stay quiet
        this.emit("recall_search", recall, { hits: hits.map(([s, h]) => ({ score: round(s, 3), text: h })) });
      }

      this.emit("energy", null, { level: this.energy.level });
      const reason = await this.think(t0);
      if (this.cancelled) throw new Cancelled();
      this.emit("phase", null, { phase: "wrapup", reason });
      const answer = await this.wrapup();
      if (this.cancelled) throw new Cancelled();
      this.emit("session_end", null, { answer, seconds: elapsed() });
      this.log.endSession(this.session, answer, "done");
      return { session: this.session, answer };
    } catch (e) {
      if (isAbort(e) || this.cancelled) {
        this.emit("session_end", null, { answer: null, cancelled: true, seconds: elapsed() });
        this.log.endSession(this.session, null, "cancelled");
        return { session: this.session, answer: null };
      }
      this.emit("error", null, { error: String(e) });
      this.emit("session_end", null, { answer: null, seconds: elapsed() });
      this.log.endSession(this.session, null, "error");
      throw e;
    }
  }

  /** A rejection travels with the latest critique, so the writer weighs both
   * instead of simply obeying the gate (they may pull in different directions). */
  private sendBack(reason: string): string {
    const critique = this.bus.messages.filter((m) => m.kind === "post" && m.topic === "critique").slice(-2);
    if (!critique.length) return reason;
    return reason + "\n\nAlso on the table from #critique:\n" + critique.map((m) => `- ${m.sender}: ${m.text.slice(0, 300)}`).join("\n") +
      "\nWeigh these together: fix what is really wrong without losing what makes the answer good.";
  }

  private async gate(gate: string, attempt: number): Promise<Output> {
    const [, out] = await this.turn(this.agents.get(gate)!, this.cycle, GATE);
    this.emit("verdict", gate, { verdict: out.verdict, reason: out.reason, version: this.draft.version, attempt: attempt + 1 });
    return out;
  }

  private async think(t0: number): Promise<string> {
    const c = this.cfg.cycle;
    const maxCycles = c.max_cycles ?? 12, minCycles = c.min_cycles ?? 2;
    const maxTurns = c.max_turns ?? 4, maxSeconds = c.max_seconds ?? 360;
    this.emit("phase", null, { phase: "think" });
    for (let cycle = 1; cycle <= maxCycles; cycle++) {
      this.cycle = cycle;
      if (this.cancelled) return "cancelled";
      const [ready, pending] = this.ready(cycle);
      if (!pending) return "quiet";
      this.emit("cycle", null, { n: cycle, ready: ready.map(([a]) => a.name) });
      const order = schedule(ready, this.loadedModel, maxTurns);
      const results = await Promise.all(order.map((a) => this.sem.run(async () => (await this.turn(a, cycle))[0])));
      const level = this.energy.tick(results.reduce((s, x) => s + x, 0));
      this.emit("energy", null, { level: round(level, 3), cycle });
      if (this.energy.exhausted && cycle >= minCycles) return "interest faded";
      if ((performance.now() - t0) / 1000 > maxSeconds) return "time";
    }
    return "cycle limit";
  }

  /** Time is nearly up: everyone still thinking hears it and the normal cycles
   * go on. The gate looks when the writer says the draft is ready (or nobody
   * has anything left to say); a rejection goes back to the writer and the
   * cycles continue. Bounded by wrap_cycles/max_rejections. */
  private async wrapup(): Promise<string> {
    const cfg = this.cfg, c = cfg.cycle;
    const [drafter, gate, speaker, recall] = ["write_draft", "verdict", "speak", "remember"].map((x) => owner(cfg, x));
    const wrapCycles = c.wrap_cycles ?? 4, maxRejections = c.max_rejections ?? 2;
    // "time is nearly up" goes to the writer; everyone else has had their say and stays quiet
    const finishers = drafter ? [drafter] : [];
    for (const name of finishers) this.bus.add(this.cycle, "time", "signal", WRAP_SIGNAL, { to: name });
    this.emit("signal", null, { text: WRAP_SIGNAL, to: finishers });
    this.drafterReady = false;
    let rejections = 0, outcome = "wrap-up limit";
    let gatedVersion: number | null = null;

    for (let i = 0; i < wrapCycles; i++) {
      if (this.cancelled) break;
      this.cycle++;
      const cycle = this.cycle;
      const [ready] = this.ready(cycle, true);
      if (ready.length) {
        this.emit("cycle", null, { n: cycle, ready: ready.map(([a]) => a.name), wrap: true });
        const order = schedule(ready, this.loadedModel, c.max_turns ?? 4);
        await Promise.all(order.map((a) => this.sem.run(() => this.turn(a, cycle))));
      }
      if (!gate || !drafter) {
        outcome = "no gate";
        break;
      }
      const quiet = !this.ready(this.cycle + 1, true)[1];
      if (!(this.drafterReady || quiet) || !this.draft.version) continue;
      const verdict = await this.gate(gate, rejections);
      gatedVersion = this.draft.version;
      if (verdict.verdict === "approve") {
        outcome = "approved";
        break;
      }
      rejections++;
      if (rejections > maxRejections) {
        outcome = "rejections exhausted";
        break;
      }
      const msg = this.bus.add(this.cycle, gate, "dm", this.sendBack(verdict.reason || "Not good enough yet."), { to: drafter });
      this.emit("dm", gate, { to: drafter, text: msg.text, id: msg.id });
      this.drafterReady = false;
    }
    if (this.cancelled) throw new Cancelled();

    // the gate always gets a look at the version that will be spoken
    if (gate && this.draft.version && gatedVersion !== this.draft.version && outcome !== "approved") {
      const verdict = await this.gate(gate, rejections);
      if (verdict.verdict === "approve") outcome = "approved";
    }
    this.emit("phase", null, { phase: "speak", reason: outcome });

    let answer = this.draft.current;
    if (speaker) {
      const [, out] = await this.turn(this.agents.get(speaker)!, this.cycle, SPEAK);
      answer = out.reply || answer;
    }
    this.emit("output", speaker, { channel: "speech", text: answer }); // the speech (text) output channel

    const speakAloud = async () => {
      if (this.audio && answer) {
        await this.audio.deliver(answer, this.session, (kind, d) => this.emit(kind, speaker, d), () => this.cancelled);
      }
    };
    const remember = async () => {
      if (recall && this.ltm && answer) {
        const [, out] = await this.turn(this.agents.get(recall)!, this.cycle, REMEMBER(answer.slice(0, 1500)));
        for (const item of out.remember ?? []) await this.ltm.store(recall, item, this.session);
        if (out.remember?.length) this.emit("remember", recall, { items: out.remember });
      }
    };
    // the voice is heard while the memory is being laid down
    await Promise.all([speakAloud(), remember()]);
    return answer;
  }
}

export function newSessionId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 10);
}

function round(x: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}
