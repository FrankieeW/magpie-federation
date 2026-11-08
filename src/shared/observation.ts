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
  /** The response id, when the route names one. Used only to match a local hop. */
  responseId?: string;
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

/** Whether this remote route is the same call as one local hop. Never a guess. */
export interface Link {
  readonly state: "matched" | "ambiguous" | "unmatched" | "unavailable";
  readonly by?: "response-id" | "time-and-model";
  readonly localRouteId?: number;
  readonly note: string;
}

/**
 * A sum across usage rows. `withheld` means there is no honest total.
 * `deduped` counts only the remote's known rows for a matched call.
 */
export interface CostRollup {
  readonly state: "withheld" | "deduped" | "partial";
  readonly usd?: number;
  readonly note: string;
}

/** What one read of a remote session returns, before it is compared with this computer. */
export interface RemoteObservation {
  remote: string;
  session: string;
  seq: number;
  route: Route | null;
  observedAt: string;
  usage: Usage;
}

/** The console's answer: the remote read, plus how it relates to this computer. */
export interface Observation extends RemoteObservation {
  link: Link;
  rollup: CostRollup;
  /** Routes this plugin has already seen for the session, newest first, excluding the current one. */
  earlier: Route[];
  /** Set when the route was shown but could not be written to the local record. */
  historyWarning?: string;
}
