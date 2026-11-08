// Validation of what crosses a process boundary: request bodies the console
// and the peer accept, and the answers the console reads back from a peer.
// Each parser returns a fresh value of the declared type or throws.

import type { Candidate, ChangeRecord, MemberKind, Pool, PoolOp } from "./api.ts";
import { isPoolId } from "./members.ts";

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParseError";
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function text(value: unknown, what: string, max = 512): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ParseError(`${what} 必须是 1–${max} 个字符的文本`);
  }
  return value;
}

function index(value: unknown, what: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 10_000) throw new ParseError(`${what} 必须是非负整数`);
  return value as number;
}

export function parsePoolId(value: unknown): string {
  if (typeof value !== "string" || !isPoolId(value)) throw new ParseError("池子 ID 无效");
  return value;
}

export function parseMembers(value: unknown, what = "成员列表"): string[] {
  if (!Array.isArray(value) || value.length > 1000) throw new ParseError(`${what} 必须是最多 1000 项的列表`);
  return value.map((item, i) => text(item, `${what}[${i}]`));
}

export function parseOp(value: unknown): PoolOp {
  if (!isObject(value)) throw new ParseError("op 必须是对象");
  const member = text(value.member, "op.member");
  switch (value.type) {
    case "add":
      return value.index === undefined ? { type: "add", member } : { type: "add", member, index: index(value.index, "op.index") };
    case "remove":
      return { type: "remove", member };
    case "move":
      return { type: "move", member, to: index(value.to, "op.to") };
    default:
      throw new ParseError("op.type 必须是 add、remove 或 move");
  }
}

const KINDS: readonly MemberKind[] = ["model", "pool", "remote-model", "remote-pool", "pattern"];

export function parsePool(value: unknown): Pool {
  if (!isObject(value)) throw new ParseError("池子格式无效");
  return {
    id: parsePoolId(value.id),
    name: text(value.name, "池子名称", 200),
    routing: text(value.routing, "池子路由方式", 64),
    members: parseMembers(value.members),
  };
}

export function parseCandidate(value: unknown): Candidate {
  if (!isObject(value) || !KINDS.includes(value.kind as MemberKind)) throw new ParseError("候选格式无效");
  const base = { id: text(value.id, "候选 ID"), label: text(value.label, "候选名称", 200), kind: value.kind as MemberKind };
  return typeof value.via === "string" ? { ...base, via: text(value.via, "候选来源", 128) } : base;
}

export function parseChange(value: unknown): ChangeRecord {
  if (!isObject(value)) throw new ParseError("变更记录格式无效");
  const base = {
    id: text(value.id, "变更 ID", 128),
    at: text(value.at, "变更时间", 64),
    pool: parsePoolId(value.pool),
    op: parseOp(value.op),
    before: parseMembers(value.before, "before"),
    after: parseMembers(value.after, "after"),
    by: text(value.by, "变更来源", 128),
  };
  return typeof value.undoOf === "string" ? { ...base, undoOf: text(value.undoOf, "undoOf", 128) } : base;
}

export function parseList<T>(value: unknown, item: (v: unknown) => T, what: string, max = 5000): T[] {
  if (!Array.isArray(value) || value.length > max) throw new ParseError(`${what} 必须是列表`);
  return value.map(item);
}

/**
 * The valid items of a list, the others left out: one odd pool or label
 * from another machine never hides the rest of what it said.
 */
export function parseSome<T>(value: unknown, item: (v: unknown) => T, what: string, max = 5000): T[] {
  if (!Array.isArray(value) || value.length > max) throw new ParseError(`${what} 必须是列表`);
  return value.flatMap((entry) => {
    try {
      return [item(entry)];
    } catch {
      return [];
    }
  });
}
