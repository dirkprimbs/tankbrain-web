// The version number and "what's new": CHANGELOG.md is bundled with the page.
// A returning visitor sees the entries they haven't seen yet, once; clicking
// the version next to the title shows the whole changelog.

import changelogText from "../CHANGELOG.md?raw";

export const VERSION = __APP_VERSION__;
export const SEEN = "tankbrain.seenVersion"; // localStorage: the newest version this browser has shown
/** Visitors from before versions existed have seen at least this one. */
const BEFORE_VERSIONS = "0.1.0";

export interface Entry { version: string; date: string; title: string; items: string[] }

/** Entries from "## 1.0.0 · 2026-11-11 · Title" headings and their "- " items, newest first. */
export function parseChangelog(md: string): Entry[] {
  const out: Entry[] = [];
  for (const line of md.split("\n")) {
    const head = line.match(/^##\s+(\d+\.\d+\.\d+)\s*(?:·\s*([^·]+?))?\s*(?:·\s*(.+?))?\s*$/);
    if (head) out.push({ version: head[1], date: head[2] ?? "", title: head[3] ?? "", items: [] });
    else if (/^-\s+/.test(line) && out.length) out[out.length - 1].items.push(line.replace(/^-\s+/, ""));
    else if (/^\s+\S/.test(line) && out.length && out[out.length - 1].items.length) {
      const items = out[out.length - 1].items; // a wrapped item continues
      items[items.length - 1] += " " + line.trim();
    }
  }
  return out;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/** What to show on this page load: nothing for a first visit, otherwise every
 * entry newer than the version this browser saw last (up to the current one). */
export function whatsNew(entries: Entry[], seen: string | null, returning: boolean, current = VERSION): Entry[] {
  const since = seen ?? (returning ? BEFORE_VERSIONS : null);
  if (!since) return [];
  return entries.filter((e) => compareVersions(e.version, since) > 0 && compareVersions(e.version, current) <= 0);
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const inline = (s: string) => esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");

function render(entries: Entry[]): string {
  return entries.map((e) => `<h3>v${esc(e.version)}${e.title ? ` · ${esc(e.title)}` : ""}${e.date ? ` <small>${esc(e.date)}</small>` : ""}</h3>
    <ul>${e.items.map((i) => `<li>${inline(i)}</li>`).join("")}</ul>`).join("");
}

export const changelog = () => parseChangelog(changelogText);

/** The changelog dialog: "what's new" for a returning visitor, or all of it. */
export function showChangelog(entries: Entry[], heading: string) {
  const back = document.createElement("div");
  back.className = "editor-backdrop show";
  const box = document.createElement("div");
  box.className = "editor settings about changelog";
  box.innerHTML = `<div class="editor-head"><h2>${esc(heading)}</h2><button class="ghost" title="Close">×</button></div>
    <div class="settings-body about-body">${render(entries)}
    <div class="row"><button class="primary" data-a="ok">GOT IT</button></div></div>`;
  back.append(box);
  document.body.append(back);
  const close = () => { back.remove(); document.removeEventListener("keydown", esc_); };
  const esc_ = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", esc_);
  box.querySelector(".editor-head button")!.addEventListener("click", close);
  box.querySelector('[data-a="ok"]')!.addEventListener("click", close);
  back.addEventListener("mousedown", (e) => { if (e.target === back) close(); });
}
