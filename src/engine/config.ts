// Agent definitions and model profiles. agents.yaml and the built-in profiles
// ship with the page; profiles saved from the UI live in this browser.

import YAML from "yaml";
import agentsYaml from "../config/agents.yaml?raw";
import diverseYaml from "../config/profiles/diverse.yaml?raw";
import fakeYaml from "../config/profiles/fake.yaml?raw";
import fastYaml from "../config/profiles/fast.yaml?raw";
import dirksDefaultYaml from "../config/profiles/dirksdefault.yaml?raw";
import type { Store } from "./store";

export const ABILITIES = new Set(["write_memory", "write_draft", "interest", "verdict", "speak", "remember", "recognise", "size"]);
export const GRANTS = new Set(["question", "working_memory", "draft", "self"]);
export const PHASES = new Set(["think", "gate", "speak", "after"]);
export const PROFILE_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

const BUILTIN: Record<string, string> = { diverse: diverseYaml, dirksdefault: dirksDefaultYaml, fast: fastYaml, fake: fakeYaml };

export interface AgentSpec {
  name: string;
  public: string;
  persona: string;
  model: string;
  region: string;
  group: string;
  color: string;
  pos: number[];
  phase: string;
  subscriptions: string[];
  posts_to: string[];
  contacts: string[];
  grants: string[];
  abilities: string[];
  cooldown: number;
  max_posts: number;
  nudge: string;            // what "do your job now" means for this voice
  home_model: string;       // the model agents.yaml designs this voice for
  home_think: boolean | null;
  options: Record<string, any>;
  think: boolean | null;
}

/** What the observer UI gets (never sent to agents). */
export function publicView(a: AgentSpec) {
  return {
    name: a.name, public: a.public, model: a.model, region: a.region, group: a.group, color: a.color,
    pos: a.pos, phase: a.phase, subscriptions: a.subscriptions, posts_to: a.posts_to, contacts: a.contacts,
    persona: a.persona, options: a.options, think: a.think, abilities: a.abilities,
    home_model: a.home_model || a.model, home_think: a.home_think,
  };
}

export interface BrainConfig {
  agents: Map<string, AgentSpec>;
  disabled: Map<string, AgentSpec>;
  topics: Record<string, string>;
  self: string[]; // the core beliefs a fresh brain starts with
  cycle: Record<string, number>;
  energy: Record<string, number>;
  profile: string;
  embed_model: string;
  input_pos: number[];
}

export function owner(cfg: BrainConfig, ability: string): string | null {
  for (const a of cfg.agents.values()) if (a.abilities.includes(ability)) return a.name;
  return null;
}

export function validate(cfg: BrainConfig): void {
  const names = new Set(cfg.agents.keys());
  const diff = (xs: string[], ok: (x: string) => boolean) => xs.filter((x) => !ok(x));
  for (const a of cfg.agents.values()) {
    if (!PHASES.has(a.phase)) throw new Error(`${a.name}: unknown phase ${a.phase}`);
    let bad = diff(a.abilities, (x) => ABILITIES.has(x));
    if (bad.length) throw new Error(`${a.name}: unknown abilities ${bad}`);
    bad = diff(a.grants, (x) => GRANTS.has(x));
    if (bad.length) throw new Error(`${a.name}: unknown grants ${bad}`);
    bad = diff(a.contacts, (x) => names.has(x));
    if (bad.length) throw new Error(`${a.name}: unknown contacts ${bad}`);
    bad = diff([...a.posts_to, ...a.subscriptions], (x) => x in cfg.topics);
    if (bad.length) throw new Error(`${a.name}: unknown topics ${bad}`);
  }
  for (const ability of ["write_memory", "write_draft", "speak", "verdict", "remember", "recognise", "size"]) {
    const owners = [...cfg.agents.values()].filter((a) => a.abilities.includes(ability)).map((a) => a.name);
    if (owners.length > 1) throw new Error(`ability ${ability} must have one owner, got ${owners}`);
  }
}

export const baseConfig = (): any => YAML.parse(agentsYaml);
export const builtinProfiles = (): string[] => Object.keys(BUILTIN).sort();

/** Models agents.yaml designs the voices for. */
export function homeModels(): string[] {
  return [...new Set<string>(baseConfig().agents.map((a: any) => a.model).filter(Boolean))].sort();
}

export async function listProfiles(db: Store): Promise<string[]> {
  const user = (await db.getAllKeys("profiles")) as string[];
  return [...new Set([...builtinProfiles(), ...user])].sort();
}

async function profileText(name: string, db: Store | null): Promise<string> {
  if (name in BUILTIN) return BUILTIN[name];
  const row = db ? await db.get("profiles", name) : undefined;
  if (!row) throw new Error(`unknown profile ${name}`);
  return row.yaml;
}

function spec(raw: any): AgentSpec {
  return {
    name: raw.name, public: raw.public ?? "", persona: raw.persona ?? "", model: raw.model ?? "",
    region: raw.region ?? "", group: raw.group ?? "", color: raw.color ?? "#00e5ff", pos: raw.pos ?? [0, 0, 0],
    phase: raw.phase ?? "think", subscriptions: raw.subscriptions ?? [], posts_to: raw.posts_to ?? [],
    contacts: raw.contacts ?? [], grants: raw.grants ?? [], abilities: raw.abilities ?? [],
    cooldown: raw.cooldown ?? 0, max_posts: raw.max_posts ?? 2, nudge: raw.nudge ?? "",
    home_model: raw.home_model ?? "", home_think: raw.home_think ?? null, options: raw.options ?? {},
    think: raw.think ?? null,
  };
}

export async function load(profile = "diverse", db: Store | null = null, text?: string): Promise<BrainConfig> {
  if (!PROFILE_NAME.test(profile)) throw new Error(`bad profile name ${JSON.stringify(profile)}`);
  const base = baseConfig();
  const prof = YAML.parse(text ?? (await profileText(profile, db))) ?? {};
  const def = prof.default ?? {};
  const overrides = prof.agents ?? {};
  const agents = new Map<string, AgentSpec>();
  const disabled = new Map<string, AgentSpec>();
  for (const orig of base.agents) {
    const own = overrides[orig.name] ?? {};
    const enabled = (own.enabled ?? orig.enabled ?? true) !== false;
    const raw: any = { ...orig };
    delete raw.enabled;
    raw.home_model = orig.model ?? "";
    raw.home_think = orig.think ?? null;
    // model: profile agent override > profile default > agents.yaml
    // options/think: profile agent override > agents.yaml (personality) > profile default
    raw.model = own.model || def.model || orig.model;
    raw.options = { ...(def.options ?? {}), ...(orig.options ?? {}), ...(own.options ?? {}) };
    if ("think" in own) raw.think = own.think;
    else if (!("think" in orig) && "think" in def) raw.think = def.think;
    if (own.persona) raw.persona = own.persona;
    (enabled ? agents : disabled).set(raw.name, spec(raw));
  }
  // a switched-off voice simply isn't there: nobody can reach it
  for (const a of agents.values()) a.contacts = a.contacts.filter((c) => agents.has(c));
  const cfg: BrainConfig = {
    agents, disabled, topics: base.topics, self: (base.self ?? []).map(String),
    cycle: { ...(base.cycle ?? {}), ...(prof.cycle ?? {}) },
    energy: { ...(base.energy ?? {}), ...(prof.energy ?? {}) },
    profile, embed_model: prof.embed_model ?? base.embed_model ?? "",
    input_pos: base.input_pos ?? [0, -0.1, 0],
  };
  validate(cfg);
  return cfg;
}

export interface VoiceSettings {
  model?: string;
  temperature?: number | null;
  think?: boolean | null;
  enabled?: boolean;
  persona?: string;
}

/** Where a profile's hidden model options (e.g. max tokens) come from: a
 * profile in this browser, or the text of an imported profile file. */
export type ProfileParent = string | { yaml: string } | null;

/** The YAML of a custom profile from per-voice settings (from the UI).
 * Model options the UI doesn't show (e.g. max tokens) are inherited from
 * `basedOn`. Every voice's model is written out, so the file stands on its own;
 * other values only where they differ from agents.yaml. Throws for invalid configs. */
export async function profileYaml(db: Store, voices: Record<string, VoiceSettings>,
                                  note = "", basedOn: ProfileParent = null): Promise<string> {
  const base = new Map<string, any>(baseConfig().agents.map((a: any) => [a.name, a]));
  const parent = typeof basedOn === "object" && basedOn ? await load("imported", db, basedOn.yaml)
    : basedOn && (await listProfiles(db)).includes(basedOn) ? await load(basedOn, db) : null;
  const agents: Record<string, any> = {};
  for (const [vname, v] of Object.entries(voices)) {
    const b = base.get(vname);
    if (!b) throw new Error(`unknown voice ${vname}`);
    const entry: Record<string, any> = { model: String(v.model || b.model) };
    const inherited = parent ? parent.agents.get(vname) ?? parent.disabled.get(vname) : undefined;
    const opts: Record<string, any> = { ...(inherited ? inherited.options : b.options ?? {}) };
    if (v.temperature !== undefined && v.temperature !== null) {
      const t = Number(v.temperature);
      if (!(t >= 0 && t <= 2)) throw new Error(`${vname}: temperature must be 0..2`);
      opts.temperature = t;
    }
    if (JSON.stringify(opts) !== JSON.stringify(b.options ?? {})) entry.options = opts;
    if (v.think !== undefined && v.think !== null && v.think !== (b.think ?? null)) entry.think = !!v.think;
    if (v.enabled === false) entry.enabled = false;
    const persona = (v.persona ?? "").trim();
    if (persona && persona !== (b.persona ?? "").trim()) entry.persona = persona + "\n";
    agents[vname] = entry;
  }
  const header = `# Custom profile saved from the UI. ${note}`.trimEnd() + "\n";
  const yaml = header + YAML.stringify({ default: {}, agents });
  await load("custom", db, yaml); // validate
  return yaml;
}

/** Save a custom profile from per-voice settings in this browser (see profileYaml).
 * Throws for bad names, built-in profiles or invalid configs. */
export async function saveProfile(db: Store, name: string, voices: Record<string, VoiceSettings>,
                                  note = "", basedOn: ProfileParent = null): Promise<BrainConfig> {
  if (!PROFILE_NAME.test(name)) throw new Error("profile name: lowercase letters, digits, - and _ only");
  if (builtinProfiles().includes(name)) throw new Error(`'${name}' is built in; save under another name`);
  const yaml = await profileYaml(db, voices, note, basedOn);
  const cfg = await load(name, db, yaml);
  await db.put("profiles", { name, yaml, saved: Date.now() / 1000 });
  return cfg;
}

/** Read a profile file (exported from this or another browser). Throws if it
 * isn't a voice profile or doesn't fit this version's voices. */
export async function readProfileFile(text: string, db: Store | null = null): Promise<BrainConfig> {
  let raw: any;
  try {
    raw = YAML.parse(text);
  } catch {
    throw new Error("that file isn't YAML");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || typeof raw.agents !== "object" || !raw.agents) {
    throw new Error("that file isn't a voice profile (it needs an agents: section)");
  }
  const known = new Set(baseConfig().agents.map((a: any) => a.name));
  const unknown = Object.keys(raw.agents).filter((n) => !known.has(n));
  if (unknown.length) throw new Error(`unknown voices in the file: ${unknown.join(", ")}`);
  return load("imported", db, text);
}

/** A profile name from an exported file's name ("norbert-voices-cheap.yaml" → "cheap"). */
export function profileNameFromFile(file: string): string {
  let name = file.replace(/\.(ya?ml|txt)$/i, "").replace(/^norbert-voices-/i, "").toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-").replace(/^[-_]+|-+$/g, "").slice(0, 24) || "imported";
  if (builtinProfiles().includes(name)) name = `${name}-copy`;
  return name;
}
