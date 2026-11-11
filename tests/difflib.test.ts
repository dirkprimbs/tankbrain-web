import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SequenceMatcher } from "../src/engine/difflib";

const cases = JSON.parse(readFileSync(new URL("./difflib.fixture.json", import.meta.url), "utf8"));

describe("difflib port matches Python's difflib exactly", () => {
  it.each(cases.map((c: any, i: number) => [i, c]))("case %i", (_i, c: any) => {
    const sm = new SequenceMatcher(c.a, c.b);
    expect(sm.ratio()).toBeCloseTo(c.ratio, 12);
    expect(sm.quickRatio()).toBeCloseTo(c.quick, 12);
    expect(sm.realQuickRatio()).toBeCloseTo(c.real, 12);
    expect(sm.getOpcodes()).toEqual(c.ops);
    const ta = c.a.match(/\s+|\S+/g) ?? [], tb = c.b.match(/\s+|\S+/g) ?? [];
    expect(new SequenceMatcher(ta, tb, false).getOpcodes()).toEqual(c.word_ops);
  });
});
