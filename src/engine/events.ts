// Event log: everything that happens inside the tank, persisted (IndexedDB)
// and streamed to whoever watches (the UI). The event log is the *observer's*
// view. Agents never read it.

import type { EventRow, SessionRow, Store } from "./store";

export type Listener = (e: EventRow) => void;

export class EventLog {
  private seq = new Map<string, number>();
  private listeners = new Set<Listener>();
  private writes: Promise<unknown> = Promise.resolve();

  constructor(private db: Store) {}

  /** Writes are queued so they land in order; await this before reading back. */
  flush(): Promise<unknown> {
    return this.writes;
  }

  private queue(fn: () => Promise<unknown>) {
    this.writes = this.writes.then(fn).catch((e) => console.error("event log write failed", e));
  }

  // --- sessions -------------------------------------------------------
  startSession(session: string, question: string, profile: string): void {
    this.seq.set(session, 0);
    const row: SessionRow = { id: session, started: Date.now() / 1000, question, profile,
                              answer: null, status: "running", ended: null };
    this.queue(() => this.db.put("sessions", row));
  }

  endSession(session: string, answer: string | null, status = "done"): void {
    this.queue(async () => {
      const row = await this.db.get("sessions", session);
      if (row) await this.db.put("sessions", { ...row, answer, status, ended: Date.now() / 1000 });
    });
  }

  /** A running session says it is alive now and then, so another tab of the app
   * doesn't take it for one that was cut off. */
  heartbeat(session: string): void {
    this.queue(async () => {
      const row = await this.db.get("sessions", session);
      if (row && row.status === "running") await this.db.put("sessions", { ...row, alive: Date.now() / 1000 });
    });
  }

  /** Sessions still 'running' but silent for a minute were cut off (tab closed or reloaded);
   * one that is still alive in another tab is left alone. */
  async markInterrupted(staleAfter = 60): Promise<number> {
    const now = Date.now() / 1000;
    const rows = (await this.db.getAll("sessions"))
      .filter((s) => s.status === "running" && now - (s.alive ?? s.started) > staleAfter);
    for (const r of rows) await this.db.put("sessions", { ...r, status: "interrupted" });
    return rows.length;
  }

  async sessions(limit = 50): Promise<SessionRow[]> {
    await this.flush();
    const rows = await this.db.getAllFromIndex("sessions", "started");
    return rows.reverse().slice(0, limit);
  }

  async session(id: string): Promise<SessionRow | undefined> {
    await this.flush();
    return this.db.get("sessions", id);
  }

  async events(session: string): Promise<EventRow[]> {
    await this.flush();
    const rows = await this.db.getAllFromIndex("events", "session", session);
    return rows.sort((a, b) => a.seq - b.seq);
  }

  async deleteSession(session: string): Promise<void> {
    await this.flush();
    const tx = this.db.transaction(["sessions", "events", "audio"], "readwrite");
    await tx.objectStore("sessions").delete(session);
    for (const k of await tx.objectStore("events").index("session").getAllKeys(session)) await tx.objectStore("events").delete(k);
    for (const k of await tx.objectStore("audio").index("session").getAllKeys(session)) await tx.objectStore("audio").delete(k);
    await tx.done;
  }

  // --- events ---------------------------------------------------------
  emit(session: string, kind: string, agent: string | null = null, data: Record<string, any> = {}): EventRow {
    const seq = (this.seq.get(session) ?? 0) + 1;
    this.seq.set(session, seq);
    // a JSON round trip keeps exactly what the sqlite version kept (no live references)
    const event: EventRow = { session, seq, ts: Date.now() / 1000, kind, agent, data: JSON.parse(JSON.stringify(data)) };
    this.queue(() => this.db.put("events", event));
    for (const fn of [...this.listeners]) {
      try {
        fn(event);
      } catch (e) {
        console.error(e);
      }
    }
    return event;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
