export interface AgentInfo {
  name: string;
  public: string;
  model: string;
  region: string;
  group: string;
  color: string;
  pos: number[];
  phase: string;
  subscriptions: string[];
  posts_to: string[];
  contacts: string[];
  persona: string;
  options: Record<string, any>;
  think: boolean | null;
  abilities: string[];
  home_model: string;
  home_think: boolean | null;
}

export interface DraftVersion {
  version: number;
  text: string;
  mode: "initial" | "edit" | "rewrite";
  diff: [string, string][];
  applied: { find: string; replace: string }[];
  failed: { find: string; replace: string }[];
  sources: { from: string; kind: string; topic: string | null; text: string }[];
  note: string;
}

export interface TankEvent {
  session: string;
  seq: number;
  ts: number;
  kind: string;
  agent: string | null;
  data: any;
}

export interface SessionInfo {
  id: string;
  started: number;
  question: string;
  profile: string;
  answer: string | null;
  status: string;
  ended: number | null;
}

export interface ConfigInfo {
  profile: string;
  profiles: string[];
  agents: AgentInfo[];
  topics: Record<string, string>;
  input_pos: number[];
  running: string | null;
  memories: number;
  disabled: AgentInfo[];
  builtin: string[];
  cycle: Record<string, number>;
  energy: Record<string, number>;
}

export const GROUP_LABELS: Record<string, string> = {
  language: "LANGUAGE",
  creative: "CREATIVE",
  analytical: "ANALYTIC",
  executive: "EXECUTIVE",
  memory: "MEMORY",
  drive: "DRIVE",
};
