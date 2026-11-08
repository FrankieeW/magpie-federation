// What the console answers for one observed session: the remote's latest
// route, projected from an allow list, and its usage rows once it is done.

export interface Attempt { model: string; done: boolean; fail?: string; status?: number; ms?: number }
export interface Classified { by: string; intents: string[]; [key: string]: unknown }
export interface RuleHit { n: number; turn: number; tokens: number; classified?: Classified; [key: string]: unknown }
export interface Nested { group: string; name?: string; rule?: RuleHit | null }

export interface Route {
  id: number;
  time: string;
  asked: string;
  done: boolean;
  tries: Attempt[];
  /** A side call's kind (a title, a subagent…); absent for the turn itself. */
  kind?: string;
  group?: string;
  model?: string;
  served?: string;
  error?: string;
  status?: number;
  ms?: number;
  ttft_ms?: number;
  rule?: RuleHit | null;
  nested?: Nested[];
}

export type Cost =
  | { state: "unknown" }
  | { state: "known-zero"; usd: 0; source: string }
  | { state: "estimated"; usd: number; source: string };

export interface UsageRow {
  time: string;
  provider: string;
  model: string;
  status: number;
  cost: Cost;
  routeId: number;
  served?: string;
  handedOn?: boolean;
  accountAlias?: string;
  keyAlias?: string;
  input?: number;
  output?: number;
}

export interface Usage { state: string; rows: UsageRow[]; message?: string; observedAt?: string }

export interface Observation {
  remote: string;
  session: string;
  seq: number;
  route: Route | null;
  observedAt: string;
  usage: Usage;
}
