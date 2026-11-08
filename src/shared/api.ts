// Shapes exchanged between the plugin's services (the console on this
// computer, the peer on a remote one) and its page. Everything arriving from
// another process is validated where it is parsed; these types describe the
// validated result.

/** What a pool member is, as the machine that owns the pool sees it. */
export type MemberKind = "model" | "pool" | "remote-model" | "remote-pool" | "pattern";

/** A model or pool a machine can put in one of its pools. */
export interface Candidate {
  /** As the owning machine names it: `p/m`, `group/x`, `r/p/m`, `r/group/x`. */
  readonly id: string;
  readonly label: string;
  readonly kind: MemberKind;
  /** The Remote magpie provider id, for remote kinds. */
  readonly via?: string;
}

export interface Pool {
  readonly id: string;
  readonly name: string;
  readonly routing: string;
  readonly members: readonly string[];
}

export type PoolOp =
  | { readonly type: "add"; readonly member: string; readonly index?: number }
  | { readonly type: "remove"; readonly member: string }
  | { readonly type: "move"; readonly member: string; readonly to: number };

export interface Preview {
  readonly machine: string;
  readonly pool: string;
  readonly op: PoolOp;
  readonly before: readonly string[];
  readonly after: readonly string[];
  /** The magpie CLI arguments the change runs, shown before it is applied. */
  readonly command: readonly string[];
}

export interface ChangeRecord {
  readonly id: string;
  readonly at: string;
  readonly pool: string;
  readonly op: PoolOp;
  readonly before: readonly string[];
  readonly after: readonly string[];
  /** `local`, or the gateway key name that asked through the peer API. */
  readonly by: string;
  /** The change this one undid. */
  readonly undoOf?: string;
}

export type MachineState = "ready" | "unconfigured" | "forbidden" | "offline" | "incompatible" | "error";

export interface MachineView {
  /** `local`, or the id of a remote in the console's configuration. */
  readonly id: string;
  readonly name: string;
  readonly state: MachineState;
  readonly message?: string;
  readonly writable: boolean;
  readonly pools: readonly Pool[];
  readonly candidates: readonly Candidate[];
  readonly changes: readonly ChangeRecord[];
  readonly magpieVersion?: string;
}

export interface PoolsResponse {
  readonly machines: readonly MachineView[];
}

/** What the peer API tells a caller about itself and about the caller. */
export interface PeerHello {
  readonly api: 1;
  readonly name: "magpie-route-inspector";
  readonly version: string;
  readonly magpieVersion: string;
  readonly caller: { readonly key: string; readonly readOnly: boolean; readonly canWrite: boolean };
}

export interface ApiErrorBody {
  readonly error: { readonly state: MachineState | "conflict"; readonly message: string };
}
