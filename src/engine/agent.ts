// One voice: builds its (deliberately narrow) context, its response schema,
// and normalises what the model says into actions.
//
// Nothing in here tells an agent that it is part of a brain. It knows its
// persona, the notes it follows, its private messages, the memory views it is
// granted, and the names + one-line descriptions of whom it can reach.

import { INPUT_TOPIC, type Message } from "./bus";
import type { AgentSpec, BrainConfig } from "./config";

export const MAX_NOTE_CHARS = 700;

export interface AgentState {
  lastSeen: number;   // bus message index the agent has read up to
  lastCycle: number;  // last cycle the agent took a turn
  turns: number;
  ownNotes: string[];
  private: string[];  // e.g. recalled memories
  comesToMind: string[]; // for a voice that recognises: memories that came up, numbered from 1
}

export interface TurnContext {
  question: string;
  workingMemory: string;
  draft: string;
  inbox: Message[];
  instruction: string;
  self?: string[]; // the brain's core beliefs, for voices granted "self"
  size?: string;   // how long the reply should be, once the Listener has judged it
  lengthNotes?: string; // for the Listener: how long the last reply was, how it went down, what it has learned
}

export const SIZES = ["a sentence", "a few sentences", "a paragraph", "long"] as const;
export type Size = (typeof SIZES)[number];
/** About how many words each size allows. */
export const SIZE_WORDS: Record<Size, number> = { "a sentence": 30, "a few sentences": 80, "a paragraph": 160, long: 400 };
export const LENGTH_FEEDBACK = ["too long", "too short", "fine", "no idea"] as const;
export type LengthFeedback = (typeof LENGTH_FEEDBACK)[number];
const ENERGY = ["low", "medium", "high"] as const;
const PACE = ["slow", "steady", "brisk"] as const;
export interface Mood { feeling: string; energy: string; pace: string; timing: string }

/** The Voice's mood as delivery instructions: "Amused, with high energy, at a brisk pace. Pause before the twist." */
export function moodText(m: Mood): string {
  const feeling = m.feeling.replace(/[.\s]+$/, "");
  if (!feeling && !m.timing) return "";
  const parts = [feeling ? feeling[0].toUpperCase() + feeling.slice(1) : "Natural"];
  if (m.energy) parts.push(`with ${m.energy} energy`);
  if (m.pace) parts.push(`at a ${m.pace} pace`);
  const timing = m.timing.replace(/[.\s]+$/, "");
  return `${parts.join(", ")}.${timing ? ` ${timing[0].toUpperCase()}${timing.slice(1)}.` : ""}`;
}

export interface Output {
  thought: string;
  posts: { topic: string; text: string }[];
  messages: { to: string; text: string }[];
  notebook?: Record<string, any>[];
  draft?: string;
  edits?: { find: string; replace: string }[];
  note?: string;
  ready?: boolean;
  interest?: number | null;
  verdict?: "approve" | "reject";
  reason?: string;
  reply?: string;
  delivery?: string;      // the Voice's stage direction for saying the reply aloud
  mood?: Mood;
  size?: Size | null;
  lengthFeedback?: LengthFeedback | null;
  remember?: string[];
  verdictGiven?: boolean; // the model actually said approve or reject (not a default)
  recall?: { ref: number; judgement: "unrelated" | "reminds" | "related" }[];
  suggestion?: { kind: "believe" | "interesting"; text: string } | null;
  keep?: { ref: number; reason: string; replaces: number | null }[];
  gist?: string;
}

/** Voices that think along may suggest one thing to remember; the gate, the
 * speaker and memory itself don't. */
const SUGGESTS = (a: AgentSpec) => a.phase === "think" && !a.abilities.some((x) => ["verdict", "speak", "remember"].includes(x));

// like Python's str(x or ""): missing, empty, false and 0 all become ""
const str = (x: unknown) => (x ? String(x) : "");

export class Agent {
  state: AgentState = { lastSeen: 0, lastCycle: -99, turns: 0, ownNotes: [], private: [], comesToMind: [] };
  subs: Set<string>;

  constructor(public spec: AgentSpec, private cfg: BrainConfig) {
    this.subs = new Set(spec.subscriptions);
  }

  get name(): string {
    return this.spec.name;
  }

  can(ability: string): boolean {
    return this.spec.abilities.includes(ability);
  }

  // --- prompt ---------------------------------------------------------
  systemPrompt(): string {
    const s = this.spec;
    const lines = [`Your name is ${s.name}.`, s.persona.trim(), "", "How you work:"];
    const follows = s.subscriptions.filter((t) => t !== INPUT_TOPIC);
    if (s.subscriptions.includes(INPUT_TOPIC)) {
      lines.push("- Sometimes a question or idea comes up; you will see it as 'the matter at hand'.");
    }
    if (follows.length) {
      lines.push("- You follow these notice boards: " + follows.map((t) => `#${t} (${this.cfg.topics[t]})`).join(", ") + ".");
    }
    if (s.posts_to.length) {
      lines.push("- You may pin short notes on: " + s.posts_to.map((t) => `#${t} (${this.cfg.topics[t]})`).join(", ") + ".");
    }
    if (s.contacts.length) {
      lines.push("- You can send private messages to:");
      for (const c of s.contacts) lines.push(`  - ${c}: ${this.cfg.agents.get(c)!.public}`);
    }
    lines.push(
      "- Silence is fine and often best. Only write when you add something new; never repeat what is already said.",
      "- To stay silent, return empty lists. Never send a note or message just to say you are staying silent.",
      "- Keep notes short and concrete (1-4 sentences) unless your job clearly needs more.",
      "- 'thought' is your private reflection; nobody else ever sees it. Keep it to 1-3 sentences.",
      "Respond only with JSON in the requested format.",
    );
    if (this.can("write_memory")) {
      lines.push("- You keep the shared notebook. Use 'notebook' operations: add_task, add_decision, add_question, close (with ref = item number).");
    }
    if (this.can("write_draft")) {
      lines.push("- You hold the draft. If there is no draft yet, write the first version in 'draft'. " +
        "Once a draft exists, improve it with 'edits' instead of rewriting it: each edit copies an exact " +
        "passage from the current draft into 'find' and gives its new wording in 'replace'. Exactly the " +
        "text in 'find' is replaced and everything else stays as it is, so to rewrite a sentence or " +
        "section, 'find' must contain all of it. Empty 'replace' deletes; to add something, put the " +
        "sentence it should follow in 'find' and that sentence plus the addition in 'replace'. " +
        "Change only what the notes call for and leave 'draft' empty. " +
        "Only rewrite the whole draft in 'draft' if it is fundamentally wrong.");
      lines.push("- The draft contains only the clean answer, never your working-out or doubts. Put one sentence " +
        "in 'note' saying what you changed and why; others will see it. Leave 'edits', 'draft' and " +
        "'note' empty if the draft needs no change.");
      lines.push("- Set 'ready' to true only when you consider the draft finished: complete, in order, and " +
        "nothing left you want to change.");
    }
    if (this.can("interest")) {
      lines.push("- Report 'interest' from 0 to 10: how much you want the work to keep going. High only while real " +
        "open problems remain AND progress is being made. A settled, good answer means LOW interest: " +
        "there is nothing left to discover. Going in circles also means low interest.");
    }
    if (this.can("verdict")) lines.push("- Give a 'verdict' (approve or reject) and a short 'reason'.");
    if (this.can("speak")) {
      lines.push("- First decide how you feel about this answer, then put exactly what you say in 'reply'.");
      lines.push("- Your usual manner is already in your voice; don't describe it. Describe what is particular about " +
        "this reply: 'feeling' (one or two words, e.g. delighted, amused, proud, relieved, wistful, puzzled, sheepish, " +
        "earnest, gentle, excited, unsure, mischievous, sombre), 'energy' and 'pace', and in 'timing' anything about " +
        "timing, such as a pause before a punchline (or leave it empty). Take the feeling from the answer itself " +
        "(a triumph, an admission, a sad subject, a joke), from the tone of whoever asked (worried, playful, " +
        "challenging, curious) and from how it went. Different replies should sound different.");
      lines.push("- In 'thought', say in one sentence how you feel about this answer and why, not how you will word it.");
    }
    if (this.can("size")) {
      lines.push("- Judge in 'size' how long the reply should be: " + SIZES.map((x) => `'${x}'`).join(", ") + ". Go by " +
        "what the person seems to want, not by how much could be said: a short or casual question gets a short " +
        "reply; 'explain', 'tell me a story' or 'in detail' ask for more; a follow-up in a conversation usually needs " +
        "less than a fresh question, because much is already shared. The reply is spoken aloud, and the person can " +
        "always ask for more. What you have learned about this person counts.");
      lines.push("- If you are told about your previous reply, judge in 'length_feedback' what the new message " +
        "suggests about its length: 'too long' (e.g. 'in short', 'shorter', 'tl;dr', impatience), 'too short' " +
        "('tell me more', 'why?', 'go on', 'more detail'), 'fine', or 'no idea' (a new topic, or no sign either way).");
    }
    if (this.can("recognise")) {
      lines.push("- Sometimes things come to mind, listed under 'Things that come to mind'. Judge each in 'recall' " +
        "by its number: 'unrelated'; 'reminds' (it only reminds you of the matter); or 'related' (the matter " +
        "follows up on or refers back to it, e.g. 'the third one', 'shorter', 'why?'). If something reminds you, " +
        "mention it briefly in your note. If the matter follows up on something said before, restate the " +
        "question so that it is clear what it refers to.");
    }
    if (SUGGESTS(this.spec)) {
      lines.push("- If you come across something worth remembering beyond this matter, you may put it in " +
        "'suggest_memory' (at most one, one short sentence): kind 'believe' (something you now hold true) or " +
        "'interesting' (something you find interesting, and why). Usually leave it out.");
    }
    if (this.can("remember")) {
      lines.push("- When asked, decide what is kept in long-term memory: pick in 'keep' the few suggestions " +
        "worth keeping (by number, with a short reason; 'replaces' names an existing memory it corrects), " +
        "and write in 'gist' the reply that was given, in one short sentence.");
    }
    return lines.join("\n");
  }

  userPrompt(ctx: TurnContext): string {
    const s = this.spec;
    const parts: string[] = [];
    if (s.grants.includes("self") && ctx.self?.length) {
      parts.push("## Who is being asked\nThe matter is put to one person, who holds these beliefs about themself. " +
        "When the answer speaks about itself, it is this person speaking (I, my); it doesn't have to be about them. " +
        "A story, explanation or list is told in whatever form suits it, in their manner:\n" + ctx.self.map((b) => `- ${b}`).join("\n"));
    }
    if (s.grants.includes("question") || this.subs.has(INPUT_TOPIC)) parts.push(`## The matter at hand\n${ctx.question}`);
    if (this.can("size") && ctx.lengthNotes) parts.push(`## How your replies go down\n${ctx.lengthNotes}`);
    if (s.grants.includes("draft") && ctx.size) parts.push(`## Reply size\n${ctx.size}`);
    if (this.state.comesToMind.length) {
      parts.push("## Things that come to mind\n" + this.state.comesToMind.map((p, i) => `[${i + 1}] ${p}`).join("\n"));
    }
    if (this.state.private.length) {
      parts.push("## Things you remember from before\n" + this.state.private.map((p) => `- ${p}`).join("\n"));
    }
    if (s.grants.includes("working_memory")) parts.push(`## Shared notebook\n${ctx.workingMemory}`);
    if (s.grants.includes("draft")) parts.push(`## Current draft\n${ctx.draft}`);
    if (this.state.ownNotes.length) {
      parts.push("## What you said earlier\n" + this.state.ownNotes.slice(-4).map((n) => `- ${n}`).join("\n"));
    }
    const news = ctx.inbox.filter((m) => m.kind !== "input").map((m) => Agent.render(m));
    if (news.length) parts.push("## New since you last looked\n" + news.slice(-25).join("\n"));
    if (ctx.instruction) parts.push(`## Right now\n${ctx.instruction}`);
    else if (s.nudge) parts.push(`## Right now\n${s.nudge.trim()}`);
    else parts.push("## Right now\nDo your job: write only if you add something, otherwise stay silent (empty lists).");
    return parts.join("\n\n");
  }

  static render(m: Message): string {
    const text = m.text.length <= MAX_NOTE_CHARS ? m.text : m.text.slice(0, MAX_NOTE_CHARS) + " …";
    if (m.kind === "dm") return `[private from ${m.sender}] ${text}`;
    if (m.kind === "signal") return `[note] ${text}`;
    return `[#${m.topic}] ${m.sender}: ${text}`;
  }

  // --- schema ---------------------------------------------------------
  schema(): Record<string, any> {
    const s = this.spec;
    const props: Record<string, any> = { thought: { type: "string" } };
    const required = ["thought"];
    if (this.can("write_draft")) {
      // edit fields first: small models fill fields in order
      props.edits = { type: "array", items: {
        type: "object", properties: { find: { type: "string" }, replace: { type: "string" } },
        required: ["find", "replace"] } };
      props.draft = { type: "string" };
      props.note = { type: "string" };
      props.ready = { type: "boolean" };
      required.push("edits", "draft", "note", "ready");
    }
    if (s.posts_to.length) {
      props.posts = { type: "array", items: {
        type: "object", properties: { topic: { type: "string", enum: s.posts_to }, text: { type: "string" } },
        required: ["topic", "text"] } };
      required.push("posts");
    }
    if (s.contacts.length) {
      props.messages = { type: "array", items: {
        type: "object", properties: { to: { type: "string", enum: s.contacts }, text: { type: "string" } },
        required: ["to", "text"] } };
      required.push("messages");
    }
    if (this.can("write_memory")) {
      props.notebook = { type: "array", items: {
        type: "object", properties: {
          op: { type: "string", enum: ["add_task", "add_decision", "add_question", "close"] },
          text: { type: "string" }, ref: { type: "integer" } },
        required: ["op"] } };
      required.push("notebook");
    }
    if (this.can("interest")) {
      props.interest = { type: "integer", minimum: 0, maximum: 10 };
      required.push("interest");
    }
    if (this.can("verdict")) {
      props.verdict = { type: "string", enum: ["approve", "reject"] };
      props.reason = { type: "string" };
      required.push("verdict", "reason");
    }
    if (this.can("speak")) {
      // the feeling first: small models fill fields in order, and it may colour the wording
      props.feeling = { type: "string" };
      props.energy = { type: "string", enum: [...ENERGY] };
      props.pace = { type: "string", enum: [...PACE] };
      props.timing = { type: "string" };
      props.reply = { type: "string" };
      required.push("feeling", "energy", "pace", "timing", "reply");
    }
    if (this.can("size")) {
      props.size = { type: "string", enum: [...SIZES] };
      props.length_feedback = { type: "string", enum: [...LENGTH_FEEDBACK] };
      required.push("size", "length_feedback");
    }
    if (this.can("recognise")) {
      props.recall = { type: "array", items: {
        type: "object", properties: { ref: { type: "integer" }, judgement: { type: "string", enum: ["unrelated", "reminds", "related"] } },
        required: ["ref", "judgement"] } };
      required.push("recall");
    }
    if (SUGGESTS(this.spec)) {
      // optional: most turns have nothing worth remembering
      props.suggest_memory = { type: "object", properties: {
        kind: { type: "string", enum: ["believe", "interesting"] }, text: { type: "string" } }, required: ["kind", "text"] };
    }
    if (this.can("remember")) {
      props.keep = { type: "array", items: {
        type: "object", properties: { ref: { type: "integer" }, reason: { type: "string" }, replaces: { type: "integer" } },
        required: ["ref", "reason"] } };
      props.gist = { type: "string" };
      required.push("keep", "gist");
    }
    return { type: "object", properties: props, required };
  }

  // --- output ---------------------------------------------------------
  /** Clamp the model's answer to what this agent is allowed to do. */
  normalise(data: Record<string, any>): Output {
    const s = this.spec;
    const isObj = (x: unknown): x is Record<string, any> => !!x && typeof x === "object" && !Array.isArray(x);
    const list = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
    const out: Output = { thought: str(data.thought).trim(), posts: [], messages: [] };

    for (const p of list(data.posts)) {
      if (isObj(p) && s.posts_to.includes(p.topic) && str(p.text).trim()) out.posts.push({ topic: p.topic, text: str(p.text).trim() });
    }
    out.posts = out.posts.slice(0, s.max_posts);
    for (const m of list(data.messages)) {
      if (isObj(m) && s.contacts.includes(m.to) && m.to !== s.name && str(m.text).trim()) out.messages.push({ to: m.to, text: str(m.text).trim() });
    }
    out.messages = out.messages.slice(0, s.max_posts);

    if (this.can("write_memory")) out.notebook = list(data.notebook).filter(isObj).slice(0, 5);
    if (this.can("write_draft")) {
      out.draft = unquote(str(data.draft));
      out.edits = list(data.edits).filter((e): e is Record<string, any> => isObj(e) && !!str(e.find).trim())
        .map((e) => ({ find: str(e.find), replace: str(e.replace) })).slice(0, 8);
      out.note = str(data.note).trim().slice(0, 400);
      out.ready = data.ready === true;
    }
    if (this.can("interest")) {
      const n = typeof data.interest === "number" ? data.interest
        : typeof data.interest === "string" && /^\s*-?\d+\s*$/.test(data.interest) ? Number(data.interest) : NaN;
      out.interest = Number.isFinite(n) ? Math.max(0, Math.min(10, Math.trunc(n))) : null;
    }
    if (this.can("verdict")) {
      const v = str(data.verdict).toLowerCase();
      out.verdictGiven = v === "approve" || v === "reject";
      out.verdict = out.verdictGiven ? (v as "approve" | "reject") : "approve";
      out.reason = str(data.reason).trim();
    }
    if (this.can("speak")) {
      out.reply = unquote(str(data.reply));
      const one = (x: unknown, n: number) => str(x).replace(/\s+/g, " ").trim().slice(0, n);
      const pick = <T extends readonly string[]>(x: unknown, ok: T) => (ok as readonly string[]).includes(str(x).toLowerCase()) ? str(x).toLowerCase() : "";
      out.mood = { feeling: one(data.feeling, 40), energy: pick(data.energy, ENERGY), pace: pick(data.pace, PACE), timing: one(data.timing, 120) };
      out.delivery = moodText(out.mood);
    }
    if (this.can("size")) {
      const sz = str(data.size).toLowerCase(), fb = str(data.length_feedback).toLowerCase();
      out.size = (SIZES as readonly string[]).includes(sz) ? (sz as Size) : null;
      out.lengthFeedback = (LENGTH_FEEDBACK as readonly string[]).includes(fb) ? (fb as LengthFeedback) : null;
    }
    const int = (x: unknown) => (typeof x === "number" && Number.isInteger(x) ? x
      : typeof x === "string" && /^\s*\d+\s*$/.test(x) ? Number(x) : null);
    if (this.can("recognise")) {
      out.recall = [];
      for (const r of list(data.recall)) {
        const ref = isObj(r) ? int(r.ref) : null;
        const j = isObj(r) ? str(r.judgement).toLowerCase() : "";
        if (ref !== null && ref >= 1 && ref <= this.state.comesToMind.length && ["unrelated", "reminds", "related"].includes(j)
            && !out.recall.some((x) => x.ref === ref)) out.recall.push({ ref, judgement: j as "unrelated" });
      }
    }
    if (SUGGESTS(this.spec)) {
      const m = data.suggest_memory;
      const kind = isObj(m) ? str(m.kind).toLowerCase() : "";
      const text = isObj(m) ? str(m.text).trim() : "";
      out.suggestion = (kind === "believe" || kind === "interesting") && text ? { kind, text: text.slice(0, 300) } : null;
    }
    if (this.can("remember")) {
      out.keep = [];
      for (const k of list(data.keep)) {
        if (!isObj(k)) continue;
        const ref = int(k.ref);
        if (ref !== null && ref >= 1 && !out.keep.some((x) => x.ref === ref)) {
          out.keep.push({ ref, reason: str(k.reason).trim().slice(0, 200), replaces: int(k.replaces) });
        }
      }
      out.gist = str(data.gist).trim().slice(0, 300);
    }
    return out;
  }
}

/** Strip wrapping quotes small models like to add around long text. */
export function unquote(text: string): string {
  const t = text.trim();
  for (const q of ['"""', "'''", '"']) {
    if (t.startsWith(q) && t.endsWith(q) && t.length > 2 * q.length) return t.slice(q.length, -q.length).trim();
  }
  return t;
}

