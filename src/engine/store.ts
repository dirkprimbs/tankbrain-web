// Everything the app keeps lives in this browser's IndexedDB: sessions and
// their events (for replay), long-term memories (Recall), saved voice
// profiles and the spoken audio. Nothing is sent anywhere else.

import { openDB, type DBSchema, type IDBPDatabase } from "idb";

export interface SessionRow {
  id: string;
  started: number;
  question: string;
  profile: string;
  answer: string | null;
  status: string;
  ended: number | null;
  alive?: number; // last sign of life while running (another tab may be running it)
  stopped?: { heard: number; of: number }; // the person stopped the spoken reply after `heard` of `of` parts
}

export interface EventRow {
  session: string;
  seq: number;
  ts: number;
  kind: string;
  agent: string | null;
  data: any;
}

export interface MemoryRow {
  id?: number;
  session: string | null;
  created: number;
  text: string;
  embedding: number[] | null;
  // added with weighted memory (older rows lack them; see memory/longterm.ts normalise)
  kind?: string;
  weight?: number;
  age?: number;
  uses?: number;
  used?: number | null;
  from?: string[];
  verbatim?: boolean;
  question?: string;
  gist?: string;
  follows?: number | null; // "said": the exchange this one followed up on
  origin?: number | null;  // "believe"/"interesting": the exchange it came from
  context?: string;        // ...and what was asked there (kept if that exchange is forgotten)
  pinned?: boolean;        // a core belief: never fades or is forgotten, changes only after reconsidering
  seeded?: string;         // a core belief's starting text, from the config's self list
  doubts?: Doubt[];        // for a core belief: the times it was questioned
  seen?: string[];         // sessions it was laid down or confirmed in
  considered?: number;     // "self": how many sessions it had when last weighed for becoming core
  promoted?: number | null; // "self" that became a core belief: when
}

export interface Doubt {
  text: string;     // what was proposed instead
  question: string; // what was asked when it came up
  session: string | null;
  ts: number;
}

export interface ProfileRow {
  name: string;
  yaml: string; // same format as the built-in profiles
  saved: number;
}

interface TankDB extends DBSchema {
  sessions: { key: string; value: SessionRow; indexes: { started: number } };
  events: { key: [string, number]; value: EventRow; indexes: { session: string } };
  memories: { key: number; value: MemoryRow };
  profiles: { key: string; value: ProfileRow };
  audio: { key: string; value: { key: string; session: string; wav: Blob }; indexes: { session: string } };
}

export type Store = IDBPDatabase<TankDB>;
export const DB_NAME = "tankbrain";

const opened = new Map<string, Promise<Store>>();

export function openStore(name = DB_NAME): Promise<Store> {
  let p = opened.get(name);
  if (!p) {
    p = openDB<TankDB>(name, 1, {
      upgrade(db) {
        db.createObjectStore("sessions", { keyPath: "id" }).createIndex("started", "started");
        db.createObjectStore("events", { keyPath: ["session", "seq"] }).createIndex("session", "session");
        db.createObjectStore("memories", { keyPath: "id", autoIncrement: true });
        db.createObjectStore("profiles", { keyPath: "name" });
        db.createObjectStore("audio", { keyPath: "key" }).createIndex("session", "session");
      },
    });
    opened.set(name, p);
  }
  return p;
}

/** Wipe everything this app stored in this browser. */
export async function forgetEverything(name = DB_NAME): Promise<void> {
  const db = await openStore(name);
  const tx = db.transaction(["sessions", "events", "memories", "profiles", "audio"], "readwrite");
  await Promise.all([tx.objectStore("sessions").clear(), tx.objectStore("events").clear(),
    tx.objectStore("memories").clear(), tx.objectStore("profiles").clear(), tx.objectStore("audio").clear(), tx.done]);
}
