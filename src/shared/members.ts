// Pool membership as pure functions, shared by the console, the peer and the
// page. Nothing here touches Magpie: it decides what a change is, and which
// `magpie group set` arguments carry it out.

import type { Candidate, MemberKind, PoolOp } from "./api.ts";

export class MemberError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemberError";
  }
}

// A segment of a model id as Magpie lists them: provider ids, vendor model
// ids (`claude-opus-5.5`, `qwen3-coder:480b`), and `:effort` / `:fast`
// suffixes. No glob, regexp, list separator or assignment can pass.
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._~:@+-]{0,127}$/;
const MAX_MEMBER = 512;
const MAX_SEGMENTS = 8;
const POOL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** A member that may be added: one exact model or pool id, never a pattern. */
export function validateMember(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_MEMBER) {
    throw new MemberError("成员必须是 1–512 字符的模型或池子 ID");
  }
  if (value.startsWith("re:") || /[*?\s,=]/.test(value)) {
    throw new MemberError("这里只接受一个确切的模型或池子 ID，不接受通配符、正则或列表");
  }
  const segments = value.split("/");
  if (segments.length < 2 || segments.length > MAX_SEGMENTS || !segments.every((s) => SEGMENT.test(s))) {
    throw new MemberError("成员 ID 应为 provider/model、group/<池子> 或 <远端>/… 的形式");
  }
  return value;
}

export function isPoolId(value: string): boolean {
  return typeof value === "string" && POOL_ID.test(value);
}

/** Whether a stored member is a pattern Magpie expands, not one id. */
export function isPattern(member: string): boolean {
  return member.startsWith("re:") || member.includes("*");
}

function checkIndex(index: number, max: number): number {
  if (!Number.isSafeInteger(index) || index < 0 || index > max) {
    throw new MemberError(`位置必须是 0 到 ${max} 之间的整数`);
  }
  return index;
}

export interface ApplyOptions {
  /**
   * The member comes back from the pool's own recorded past (an undo), so
   * whatever Magpie accepted then — a pattern, a bare id — is accepted again.
   */
  readonly trusted?: boolean;
}

/** The members after `op`; `before` is never changed. */
export function applyOp(pool: string, before: readonly string[], op: PoolOp, options: ApplyOptions = {}): string[] {
  switch (op.type) {
    case "add": {
      const member = options.trusted ? op.member : validateMember(op.member);
      if (member === `group/${pool}`) throw new MemberError("不能把池子放进它自己");
      if (before.includes(member)) throw new MemberError(`${member} 已在池子中`);
      const index = op.index === undefined ? before.length : checkIndex(op.index, before.length);
      return [...before.slice(0, index), member, ...before.slice(index)];
    }
    case "remove": {
      if (!before.includes(op.member)) throw new MemberError(`${op.member} 不在池子中`);
      return before.filter((member) => member !== op.member);
    }
    case "move": {
      const from = before.indexOf(op.member);
      if (from < 0) throw new MemberError(`${op.member} 不在池子中`);
      const to = checkIndex(op.to, before.length - 1);
      if (to === from) throw new MemberError("位置没有变化");
      const rest = before.filter((_, i) => i !== from);
      return [...rest.slice(0, to), op.member, ...rest.slice(to)];
    }
  }
}

/** The operation that turns `applyOp(pool, before, op)` back into `before`. */
export function inverseOp(op: PoolOp, before: readonly string[]): PoolOp {
  switch (op.type) {
    case "add":
      return { type: "remove", member: op.member };
    case "remove":
      return { type: "add", member: op.member, index: before.indexOf(op.member) };
    case "move":
      return { type: "move", member: op.member, to: before.indexOf(op.member) };
  }
}

/**
 * The `magpie group set` arguments that carry out `op`. An append or a drop
 * names only its member, so a pattern among the others is left as it is; a
 * reorder or an insert rewrites the whole list, which a member holding a
 * comma can't survive.
 */
export function commandFor(pool: string, op: PoolOp, before: readonly string[], after: readonly string[]): string[] {
  if (!isPoolId(pool)) throw new MemberError("池子 ID 无效");
  if (op.type === "add" && after[after.length - 1] === op.member && after.length === before.length + 1) {
    return ["group", "set", pool, `models+=${op.member}`];
  }
  if (op.type === "remove" && !op.member.includes(",")) {
    return ["group", "set", pool, `models-=${op.member}`];
  }
  if (after.some((member) => member.includes(","))) {
    throw new MemberError("池子里有含逗号的成员（如正则），不能整体改写顺序；请在 Magpie 的 Routing 页面调整");
  }
  return ["group", "set", pool, `models=${after.join(",")}`];
}

interface ListedModel {
  readonly id: string;
  readonly label: string;
}

function listed(value: unknown): ListedModel | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  if (typeof entry.id !== "string") return null;
  try {
    validateMember(entry.id);
  } catch {
    return null;
  }
  const label = typeof entry.magpie_label === "string" && entry.magpie_label.trim()
    ? entry.magpie_label
    : typeof entry.display_name === "string" && entry.display_name.trim() ? entry.display_name : entry.id;
  return { id: entry.id, label: label.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 200) || entry.id };
}

/**
 * The candidates in a machine's `/v1/models` list. Only a Magpie offers
 * `group/…` models, so a provider listing `<r>/group/…` is a Remote magpie
 * and every `<r>/…` id is that remote's. Magpie already leaves out what
 * would route back to the asking machine, so nothing here can make a loop
 * across machines.
 */
export function candidatesFrom(models: readonly unknown[]): Candidate[] {
  const entries = models.map(listed).filter((entry): entry is ListedModel => entry !== null);
  const remotes = new Set(
    entries.map((entry) => entry.id.split("/")).filter((parts) => parts.length >= 3 && parts[1] === "group").map((parts) => parts[0] as string),
  );
  return entries.map((entry): Candidate => {
    const parts = entry.id.split("/");
    const head = parts[0] as string;
    if (head === "group") return { id: entry.id, label: entry.label, kind: "pool" };
    if (remotes.has(head)) {
      const kind: MemberKind = parts[1] === "group" ? "remote-pool" : "remote-model";
      return { id: entry.id, label: entry.label, kind, via: head };
    }
    return { id: entry.id, label: entry.label, kind: "model" };
  });
}
