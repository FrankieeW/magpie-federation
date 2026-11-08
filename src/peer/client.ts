// The console's side of the peer API: asks the plugin on another computer
// about its pools with that computer's gateway key, never follows a
// redirect, and validates every answer before it reaches the page.

import type { PeerHello, PoolOp } from "../shared/api.ts";
import { ParseError, parseCandidate, parseChange, parseMembers, parseOp, parsePool, parsePoolId, parseSome } from "../shared/parse.ts";
import { InspectorError, isObject } from "../server/errors.ts";
import { readCapped } from "../server/http.ts";
import type { Applied, PlannedChange, Snapshot } from "../machine/pools.ts";

export interface PeerClient {
  hello(): Promise<PeerHello>;
  snapshot(): Promise<Snapshot>;
  preview(pool: string, op: PoolOp): Promise<PlannedChange>;
  apply(pool: string, op: PoolOp, expected: readonly string[]): Promise<Applied>;
  undo(change: string): Promise<Applied>;
}

const MAX_BODY = 8 * 1024 * 1024;
// A write waits for the remote CLI (30 s at most) and the check after it.
const WRITE_TIMEOUT = 75_000;

function failure(status: number, body: unknown): InspectorError {
  const said = isObject(body) && isObject(body.error) && typeof body.error.message === "string" ? body.error.message.slice(0, 300) : "";
  if (status === 401 || status === 403 || status === 429) return new InspectorError("forbidden", said || "远端插件拒绝了这把密钥", 403);
  if (status === 404) return new InspectorError("incompatible", said || "远端没有启用插件的 peer 接口，或地址不对", 502);
  if (status === 409) return new InspectorError("conflict", said || "池子已被改过", 409);
  if (status >= 300 && status < 400) return new InspectorError("incompatible", "远端返回了重定向，已拒绝跟随", 502);
  if (status >= 500) return new InspectorError("offline", said || "远端插件暂时不可用", 502);
  return new InspectorError("error", said || `远端插件拒绝了请求（HTTP ${status}）`, status >= 400 && status < 500 ? status : 502);
}

function planned(value: unknown): PlannedChange {
  if (!isObject(value)) throw new ParseError("预览格式无效");
  return {
    pool: parsePoolId(value.pool),
    op: parseOp(value.op),
    before: parseMembers(value.before, "before"),
    after: parseMembers(value.after, "after"),
    command: parseMembers(value.command, "command"),
  };
}

function applied(value: unknown): Applied {
  if (!isObject(value) || typeof value.matched !== "boolean") throw new ParseError("修改结果格式无效");
  const base = { change: parseChange(value.change), matched: value.matched };
  return typeof value.warning === "string" ? { ...base, warning: value.warning.slice(0, 300) } : base;
}

function snapshot(value: unknown): Snapshot {
  if (!isObject(value)) throw new ParseError("池子列表格式无效");
  return {
    pools: parseSome(value.pools, parsePool, "pools", 1000),
    candidates: parseSome(value.candidates, parseCandidate, "candidates"),
    changes: parseSome(value.changes, parseChange, "changes", 1000),
  };
}

function hello(value: unknown): PeerHello {
  if (!isObject(value) || value.api !== 1 || value.name !== "magpie-route-inspector" || !isObject(value.caller)) {
    throw new ParseError("对方不是兼容版本的 magpie-route-inspector");
  }
  const caller = value.caller;
  if (typeof caller.key !== "string" || typeof caller.readOnly !== "boolean" || typeof caller.canWrite !== "boolean") {
    throw new ParseError("对方的身份信息格式无效");
  }
  return {
    api: 1,
    name: "magpie-route-inspector",
    version: typeof value.version === "string" ? value.version.slice(0, 64) : "",
    magpieVersion: typeof value.magpieVersion === "string" ? value.magpieVersion.slice(0, 64) : "",
    caller: { key: caller.key.slice(0, 128), readOnly: caller.readOnly, canWrite: caller.canWrite },
  };
}

export function peerClient(base: string, key: string | undefined, timeoutMs = 15_000): PeerClient {
  const call = async <T>(method: "GET" | "POST", path: string, parse: (v: unknown) => T, payload?: unknown, timeout = timeoutMs): Promise<T> => {
    const headers: Record<string, string> = { accept: "application/json" };
    if (key) headers.authorization = `Bearer ${key}`;
    if (payload !== undefined) headers["content-type"] = "application/json";
    let response: Response;
    try {
      response = await fetch(new URL(path, base), {
        method,
        headers,
        body: payload === undefined ? undefined : JSON.stringify(payload),
        redirect: "manual",
        signal: AbortSignal.timeout(timeout),
      });
    } catch (error) {
      const timedOut = (error as Error)?.name === "TimeoutError";
      throw new InspectorError("offline", timedOut && method === "POST" ? "远端插件没有及时回答：修改结果未知，请刷新后检查池子" : "无法连接远端插件", 502);
    }
    const raw = await readCapped(response, MAX_BODY, () => new InspectorError("incompatible", "远端插件的回答过大", 502)).catch((error: unknown) => {
      if (error instanceof InspectorError) throw error;
      return "";
    });
    let body: unknown = null;
    try {
      body = JSON.parse(raw);
    } catch {
      // the status still says what happened
    }
    if (response.status !== 200) throw failure(response.status, body);
    try {
      return parse(body);
    } catch (error) {
      if (error instanceof ParseError) throw new InspectorError("incompatible", `远端插件的回答不兼容：${error.message}`, 502);
      throw error;
    }
  };
  return {
    hello: () => call("GET", "v1/peer", hello),
    snapshot: () => call("GET", "v1/pools", snapshot),
    preview: (pool, op) => call("POST", "v1/preview", planned, { pool, op }),
    apply: (pool, op, expected) => call("POST", "v1/apply", applied, { pool, op, expected }, WRITE_TIMEOUT),
    undo: (change) => call("POST", "v1/undo", applied, { change }, WRITE_TIMEOUT),
  };
}
