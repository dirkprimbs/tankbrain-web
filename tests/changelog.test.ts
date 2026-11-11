import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseChangelog, compareVersions, whatsNew } from "../src/changelog";

const md = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

describe("changelog", () => {
  const entries = parseChangelog(md);

  it("has an entry for the current version, newest first", () => {
    expect(entries[0].version).toBe(pkg.version);
    expect(entries[0].items.length).toBeGreaterThan(0);
    for (let i = 1; i < entries.length; i++) expect(compareVersions(entries[i - 1].version, entries[i].version)).toBeGreaterThan(0);
  });

  it("parses headings and wrapped items", () => {
    const e = parseChangelog("## 2.1.0 · 2026-12-01 · Big\n\n- one\n  more\n- two\n## 2.0.0\n- old");
    expect(e).toEqual([
      { version: "2.1.0", date: "2026-12-01", title: "Big", items: ["one more", "two"] },
      { version: "2.0.0", date: "", title: "", items: ["old"] },
    ]);
  });

  it("compares versions numerically", () => {
    expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });

  it("shows nothing on a first visit, the unseen entries to a returning one", () => {
    const e = parseChangelog("## 1.2.0\n- c\n## 1.1.0\n- b\n## 1.0.0\n- a\n## 0.1.0\n- first");
    expect(whatsNew(e, null, false, "1.2.0")).toEqual([]);
    expect(whatsNew(e, "1.2.0", true, "1.2.0")).toEqual([]);
    expect(whatsNew(e, "1.0.0", true, "1.2.0").map((x) => x.version)).toEqual(["1.2.0", "1.1.0"]);
    expect(whatsNew(e, null, true, "1.2.0").map((x) => x.version)).toEqual(["1.2.0", "1.1.0", "1.0.0"]);
    expect(whatsNew(e, "1.0.0", true, "1.1.0").map((x) => x.version)).toEqual(["1.1.0"]);
  });
});
