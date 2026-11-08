// A remote session's latest route (`/v1/magpie/route`) and, once it is done,
// its usage rows (`/v1/magpie/usage/requests`). Every field is copied from an
// allow list and its text redacted; anything missing stays missing.

import type { RemoteConfig } from "./config.ts";
import { InspectorError, isObject } from "./errors.ts";
import { redact } from "./redact.ts";

import type { Attempt, Cost, RemoteObservation, Route, RuleHit, Usage, UsageRow } from "../shared/observation.ts";

export type { RemoteObservation } from "../shared/observation.ts";

type Text = Record<string, unknown>;

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const incompatible = (what: string) => new InspectorError("incompatible", `远端${what}格式不兼容`, 502);

function copyText(out: Text, source: Record<string, unknown>, key: string, remote: RemoteConfig, max?: number): void {
  const value = redact(source[key], remote, max);
  if (value !== undefined) out[key] = value;
}

function copyNumber(out: Text, source: Record<string, unknown>, key: string): void {
  if (finite(source[key])) out[key] = source[key];
}

function copyStrings(out: Text, source: Record<string, unknown>, key: string, remote: RemoteConfig): void {
  const value = source[key];
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) out[key] = value.map((item) => redact(item, remote));
}

function ruleOf(value: unknown, remote: RemoteConfig): RuleHit | null | undefined {
  if (value === null) return null;
  if (!isObject(value) || !integer(value.n) || !integer(value.turn) || !integer(value.tokens)) return undefined;
  const rule: Text = { n: value.n, turn: value.turn, tokens: value.tokens };
  for (const key of ["use", "pick", "wanted", "instead", "useEffort", "effort"]) copyText(rule, value, key, remote);
  for (const key of ["when", "more", "then", "small"]) copyStrings(rule, value, key, remote);
  for (const key of ["unready", "held", "waits", "grown", "compact", "bare", "images"]) {
    if (typeof value[key] === "boolean") rule[key] = value[key];
  }
  const c = value.classified;
  // Magpie's own Routing page treats `by` and `intents` as optional (an effort-only classifier has no intents).
  if (isObject(c) && (c.by === undefined || typeof c.by === "string") && (c.intents === undefined || (Array.isArray(c.intents) && c.intents.every((i) => typeof i === "string")))) {
    const decision: Text = { by: redact(c.by ?? "", remote) ?? "", intents: Array.isArray(c.intents) ? c.intents.map((i) => redact(i, remote)) : [] };
    for (const key of ["intent", "said", "after", "effort", "error", "above", "fallback", "afterEffort"]) copyText(decision, c, key, remote);
    for (const key of ["score", "sure", "ms"]) copyNumber(decision, c, key);
    if (typeof c.cached === "boolean") decision.cached = c.cached;
    rule.classified = decision;
  }
  return rule as unknown as RuleHit;
}

function routeOf(value: unknown, remote: RemoteConfig): Route | null {
  if (value === null) return null;
  if (!isObject(value) || !integer(value.id) || value.id === 0 || typeof value.time !== "string" || typeof value.asked !== "string" || typeof value.done !== "boolean" || !Array.isArray(value.tries)) {
    throw incompatible("路由响应");
  }
  const route: Text = { id: value.id, time: redact(value.time, remote), asked: redact(value.asked, remote), tries: [], done: value.done };
  for (const key of ["kind", "group", "model", "served"]) copyText(route, value, key, remote);
  const responseId = value.responseId ?? value.response_id;
  if (typeof responseId === "string") {
    const id = redact(responseId, remote, 128);
    if (id) route.responseId = id;
  }
  copyText(route, value, "error", remote, 2048);
  for (const key of ["status", "ms", "ttft_ms"]) copyNumber(route, value, key);
  if (Object.hasOwn(value, "rule")) {
    const rule = ruleOf(value.rule, remote);
    if (rule !== undefined) route.rule = rule;
  }
  if (Array.isArray(value.nested)) {
    route.nested = value.nested.filter((item) => isObject(item) && typeof item.group === "string").map((item) => {
      const entry = item as Record<string, unknown>;
      const nested: Text = { group: redact(entry.group, remote) };
      copyText(nested, entry, "name", remote);
      if (Object.hasOwn(entry, "rule")) {
        const rule = ruleOf(entry.rule, remote);
        if (rule !== undefined) nested.rule = rule;
      }
      return nested;
    });
  }
  route.tries = value.tries.map((item) => {
    if (!isObject(item) || typeof item.model !== "string" || typeof item.done !== "boolean") throw incompatible("路由尝试");
    const attempt: Text = { model: redact(item.model, remote), done: item.done };
    copyText(attempt, item, "fail", remote, 2048);
    for (const key of ["status", "ms"]) copyNumber(attempt, item, key);
    return attempt;
  });
  return route as unknown as Route;
}

function usageRow(row: unknown, routeId: number, session: string, remote: RemoteConfig): UsageRow | null {
  if (!isObject(row) || !integer(row.route_id) || row.route_id !== routeId || (row.session !== undefined && row.session !== session)) return null;
  if (typeof row.t !== "string" || typeof row.provider !== "string" || typeof row.model !== "string" || !finite(row.status)) return null;
  let cost: Cost = { state: "unknown" };
  if (row.priced === true && finite(row.cost)) {
    // Row.cost shadows Record.cost in Go JSON; even source=reported does not
    // say whether the client supplied a cost, so attribution cannot be recovered.
    cost = row.cost === 0 ? { state: "known-zero", usd: 0, source: "Magpie usage" } : { state: "estimated", usd: row.cost, source: "Magpie usage" };
  }
  const out: Text = { time: redact(row.t, remote), provider: redact(row.provider, remote), model: redact(row.model, remote), status: row.status, cost, routeId };
  if (typeof row.served === "string" && row.served) out.served = redact(row.served, remote);
  if (typeof row.handed_on === "boolean") out.handedOn = row.handed_on;
  if (typeof row.providerAccount === "string" && row.providerAccount) out.accountAlias = redact(remote.accountAliases[row.providerAccount] || "未配置别名", remote, 120);
  if (typeof row.providerKeyName === "string" && row.providerKeyName) out.keyAlias = redact(row.providerKeyName, remote, 120);
  if (finite(row.in)) out.input = row.in;
  if (finite(row.out)) out.output = row.out;
  return out as unknown as UsageRow;
}

function statusError(status: number): InspectorError {
  if (status === 401 || status === 403) return new InspectorError("forbidden", "远端拒绝访问，请检查共享设置和网关密钥", 403);
  if (status === 404 || status === 405 || status === 501 || (status >= 300 && status < 400)) return new InspectorError("incompatible", "远端不支持此接口或返回重定向", 502);
  if (status >= 500) return new InspectorError("offline", "远端服务暂时不可用", 502);
  return new InspectorError("error", `远端请求失败（HTTP ${status}）`, 502);
}

async function fetchJSON(remote: RemoteConfig, endpoint: string, query: Record<string, string>, signals: (AbortSignal | undefined)[], timeoutMs: number): Promise<unknown> {
  const url = new URL(endpoint, remote.url);
  url.search = new URLSearchParams(query).toString();
  const timeout = AbortSignal.timeout(timeoutMs);
  const live = signals.filter((s): s is AbortSignal => Boolean(s));
  const signal = AbortSignal.any([...live, timeout]);
  try {
    const response = await fetch(url, {
      method: "GET", redirect: "manual", credentials: "omit", signal,
      headers: { accept: "application/json", ...(remote.key ? { authorization: `Bearer ${remote.key}` } : {}) },
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw statusError(response.status);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new InspectorError("incompatible", "远端返回空响应", 502);
    const decoder = new TextDecoder();
    let body = "";
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8 * 1024 * 1024) {
        await reader.cancel();
        throw new InspectorError("incompatible", "远端响应过大", 502);
      }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    try {
      return JSON.parse(body);
    } catch {
      throw new InspectorError("incompatible", "远端返回的不是有效 JSON", 502);
    }
  } catch (error) {
    if (error instanceof InspectorError) throw error;
    if (live.some((s) => s.aborted)) throw new InspectorError("offline", "请求已取消", 499);
    if (timeout.aborted) throw new InspectorError("offline", "远端请求超时", 504);
    throw new InspectorError("offline", "无法连接远端服务", 502);
  }
}

export async function observe(remote: RemoteConfig, session: string, after: number, wait: number, signals: (AbortSignal | undefined)[] = []): Promise<RemoteObservation> {
  const data = await fetchJSON(remote, "magpie/route", { session, after: String(after), wait: String(wait) }, signals, (wait + 10) * 1000);
  if (!isObject(data) || data.session !== session || !integer(data.seq) || !Object.hasOwn(data, "route")) throw incompatible("路由响应");
  const route = routeOf(data.route, remote);
  const observedAt = new Date().toISOString();
  // A route still under way has no usage row yet: asking would only cost a query.
  let usage: Usage = { state: "pending", rows: [] };
  if (route?.done) {
    try {
      const ledger = await fetchJSON(remote, "magpie/usage/requests", { period: "30d", route: String(route.id), limit: "500" }, signals, 10_000);
      if (!isObject(ledger) || !Array.isArray(ledger.rows)) throw incompatible("用量响应");
      const rows = ledger.rows.map((row) => usageRow(row, route.id, session, remote)).filter((row): row is UsageRow => row !== null);
      usage = { state: "ready", rows, observedAt: new Date().toISOString() };
    } catch (error) {
      if (signals.some((signal) => signal?.aborted)) throw error;
      const failure = error instanceof InspectorError ? error : new InspectorError("error", "读取远端用量失败");
      usage = { state: failure.state, rows: [], message: failure.message };
    }
  }
  return { remote: remote.id, session, seq: data.seq, route, observedAt, usage };
}
