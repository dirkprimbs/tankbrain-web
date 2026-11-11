// Message board (topics) and private mailboxes (DMs).
//
// Visibility rules are the core of the information hiding: an agent only ever
// sees board posts on topics it subscribes to, DMs addressed to it, signals
// addressed to it, and the raw input if it subscribes to the input topic.

import { SequenceMatcher } from "./difflib";

export const INPUT_TOPIC = "inspiration";

export type Kind = "input" | "post" | "dm" | "signal";

export interface Message {
  id: number;
  cycle: number;
  sender: string;
  kind: Kind;
  text: string;
  topic: string | null;
  to: string | null;
}

export class Bus {
  messages: Message[] = [];
  constructor(public dedupeThreshold = 0.85, public dedupeWindow = 40) {}

  add(cycle: number, sender: string, kind: Kind, text: string,
      opts: { topic?: string | null; to?: string | null } = {}): Message {
    const msg: Message = { id: this.messages.length + 1, cycle, sender, kind, text: text.trim(),
                           topic: opts.topic ?? null, to: opts.to ?? null };
    this.messages.push(msg);
    return msg;
  }

  /** True if text nearly repeats a recent board post (loop/echo control). */
  isEcho(text: string): boolean {
    const t = text.trim().toLowerCase();
    if (!t) return true;
    const recent = this.messages.filter((m) => m.kind === "post").slice(-this.dedupeWindow);
    for (const m of recent) {
      const sm = new SequenceMatcher(t, m.text.toLowerCase());
      if (sm.realQuickRatio() >= this.dedupeThreshold && sm.ratio() >= this.dedupeThreshold) return true;
    }
    return false;
  }

  static visible(msg: Message, agent: string, subscriptions: Set<string>): boolean {
    if (msg.kind === "input") return subscriptions.has(INPUT_TOPIC);
    if (msg.kind === "post") return msg.sender !== agent && msg.topic !== null && subscriptions.has(msg.topic);
    if (msg.kind === "dm" || msg.kind === "signal") return msg.to === agent;
    return false;
  }

  unread(agent: string, subscriptions: Set<string>, afterId: number): Message[] {
    return this.messages.slice(afterId).filter((m) => Bus.visible(m, agent, subscriptions));
  }

  /** Who will receive a message (used by the observer UI for pulses). */
  recipients(msg: Message, agents: Map<string, Set<string>>): string[] {
    return [...agents].filter(([a, subs]) => Bus.visible(msg, a, subs)).map(([a]) => a);
  }
}
