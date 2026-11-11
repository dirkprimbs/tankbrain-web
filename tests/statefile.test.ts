import { describe, expect, it } from "vitest";
import { Brain } from "../src/engine/brain";
import { FakeLLM } from "../src/engine/llm";
import { exportState, importState } from "../src/engine/statefile";
import { wavBlob } from "../src/speech/text";
import { fresh, scripted } from "./helpers";

describe("the whole state as one file", () => {
  it("round-trips sessions, events, audio, memories and profiles, replacing what was there", async () => {
    const a = await fresh();
    const res = await new Brain(a.cfg, new FakeLLM(scripted), a.log, a.ltm).run("What is 17 times 3?");
    await a.log.flush();
    await a.db.put("audio", { key: `${res.session}/x.wav`, session: res.session, wav: wavBlob(new Float32Array(10), 24000) });
    await a.db.put("profiles", { name: "mine", yaml: "default: {}\n", saved: 1 });
    const file = JSON.parse(JSON.stringify(await exportState(a.db, { "tankbrain.speed": "1.2" })));
    expect(file.settings).toEqual({ "tankbrain.speed": "1.2" });

    const b = await fresh();
    await new Brain(b.cfg, new FakeLLM(scripted), b.log, b.ltm).run("Something else entirely?"); // replaced by the import
    await b.log.flush();
    const n = await importState(b.db, file);
    expect(n).toEqual({ sessions: 1, memories: (await a.ltm.count()), profiles: 1 });
    expect((await b.log.sessions()).map((s) => s.id)).toEqual([res.session]);
    expect((await b.log.events(res.session)).length).toBe((await a.log.events(res.session)).length);
    expect((await b.db.get("audio", `${res.session}/x.wav`))!.wav.size).toBe(44 + 20);
    const ma = (await a.ltm.all()).map((m) => [m.kind, m.text, m.weight, m.verbatim]);
    expect((await b.ltm.all()).map((m) => [m.kind, m.text, m.weight, m.verbatim])).toEqual(ma);
    await expect(importState(b.db, { format: "tankbrain-session" } as any)).rejects.toThrow("not a Tankbrain state file");
  });
});
