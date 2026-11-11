import * as config from "../src/engine/config";
import { EventLog } from "../src/engine/events";
import { LongTermMemory } from "../src/engine/memory/longterm";
import { openStore } from "../src/engine/store";

export function who(system: string): string {
  return /Your name is (\w+)\./.exec(system)![1];
}

/** Same script as the Python tests: a whole session about 17 * 3. */
export function scripted(system: string, user: string): Record<string, any> {
  const name = who(system);
  const base: Record<string, any> = { thought: `${name} thinking`, posts: [], messages: [] };
  if (name === "Listener") base.posts = [{ topic: "focus", text: "They want 17 * 3." }];
  else if (name === "Associator") base.posts = [{ topic: "associations", text: "multiplication; tables; prime 17" }];
  else if (name === "Curator") base.posts = [{ topic: "ideas", text: "17 is prime: irrelevant but fun." }];
  else if (name === "Logician") {
    base.posts = [{ topic: "logic", text: "17 * 3 = 51." }];
    base.messages = [{ to: "Drafter", text: "The result is 51." }];
  } else if (name === "Coordinator") base.notebook = [{ op: "add_decision", text: "Answer is 51" }];
  else if (name === "Drafter") {
    if (user.includes("(no draft yet)")) base.draft = "17 times 3 is 51.";
    else if (user.includes("Show the working") && !user.includes("because")) {
      base.edits = [{ find: "is 51.", replace: "is 51, because 17 * 3 = 51." }];
    }
  } else if (name === "Critic") base.posts = [{ topic: "critique", text: "Show the working." }];
  else if (name === "Motivator") base.interest = 1;
  else if (name === "Inhibitor") Object.assign(base, { verdict: "approve", reason: "Correct." });
  else if (name === "Voice") base.reply = "It's 51.";
  else if (name === "Recall") base.remember = ["Asked what 17 times 3 is: it equals 51"];
  return base;
}

let n = 0;
/** A fresh, empty browser database per test. */
export async function fresh() {
  const db = await openStore(`test-${Date.now()}-${n++}`);
  const log = new EventLog(db);
  const ltm = new LongTermMemory(db, null, "Recall");
  const cfg = await config.load("fake", db);
  return { db, log, ltm, cfg };
}
