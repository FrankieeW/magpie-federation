// This computer's recent routes, from its own gateway's `/v1/magpie/trace`.
// Only the fields a session list and a correlation need are kept. Prompt
// text, account order and anything else in the trace are dropped here.

import { InspectorError, isObject } from "./errors.ts";
import { readCapped } from "./http.ts";
import type { HopRef } from "./correlate.ts";

export interface LocalHop extends HopRef {
  readonly session?: string;
  readonly agent?: string;
}

export interface SessionBrief {
  readonly id: string;
  readonly agent?: string;
  readonly time: string;
  readonly model?: string;
  readonly provider?: string;
  readonly routeId: number;
}

const MAX_BODY = 8 * 1024 * 1024;

function text(value: unknown, max = 200): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  return cleaned ? cleaned.slice(0, max) : undefined;
}

function sessionId(value: unknown): string | undefined {
  const id = text(value, 200);
  if (!id || new TextEncoder().encode(id).length > 128) return undefined;
  return id;
}

function duration(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 86_400_000) return undefined;
  return value;
}

export function parseTrace(body: unknown): { hops: LocalHop[]; sessions: SessionBrief[] } {
  if (!isObject(body) || !Array.isArray(body.routes)) throw new InspectorError("incompatible", "本机路由格式不兼容", 502);
  const hops: LocalHop[] = [];
  for (const item of body.routes) {
    if (!isObject(item) || !Number.isSafeInteger(item.id) || (item.id as number) <= 0 || typeof item.time !== "string") continue;
    const time = text(item.time, 40);
    if (!time) continue;
    const tries = Array.isArray(item.tries)
      ? item.tries.flatMap((attempt) => {
          if (!isObject(attempt)) return [];
          const id = text(attempt.id, 200);
          const model = text(attempt.model, 200);
          return id && model ? [{ id, model }] : [];
        })
      : [];
    const session = sessionId(item.session);
    const responseId = text(item.responseId ?? item.response_id, 128);
    const provider = text(item.provider);
    const model = text(item.model);
    const agent = text(item.agent, 80);
    const ms = duration(item.ms);
    hops.push({
      routeId: item.id as number,
      time,
      tries,
      ...(session ? { session } : {}),
      ...(responseId ? { responseId } : {}),
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
      ...(agent ? { agent } : {}),
      ...(ms !== undefined ? { ms } : {}),
    });
  }
  const newest = new Map<string, LocalHop>();
  for (const hop of hops) {
    if (!hop.session) continue;
    const previous = newest.get(hop.session);
    if (!previous || Date.parse(hop.time) >= Date.parse(previous.time)) newest.set(hop.session, hop);
  }
  const sessions = [...newest.values()]
    .sort((a, b) => Date.parse(b.time) - Date.parse(a.time))
    .slice(0, 30)
    .map((hop): SessionBrief => ({
      id: hop.session as string,
      time: hop.time,
      routeId: hop.routeId,
      ...(hop.agent ? { agent: hop.agent } : {}),
      ...(hop.model ? { model: hop.model } : {}),
      ...(hop.provider ? { provider: hop.provider } : {}),
    }));
  return { hops, sessions };
}

function loopback(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

/** Read the local trace. The loopback token is sent only to a loopback gateway. */
export async function fetchTrace(base: string): Promise<unknown> {
  let url: URL;
  try {
    url = new URL("/v1/magpie/trace", base.endsWith("/") ? base : `${base}/`);
  } catch {
    throw new InspectorError("offline", "本机网关地址无效", 502);
  }
  const headers: Record<string, string> = { accept: "application/json" };
  if (loopback(url.hostname)) headers.authorization = "Bearer magpie";
  let response: Response;
  try {
    response = await fetch(url, { headers, redirect: "manual", signal: AbortSignal.timeout(3000) });
  } catch {
    throw new InspectorError("offline", "无法连接本机 Magpie 网关", 502);
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    if (response.status >= 300 && response.status < 400) throw new InspectorError("incompatible", "本机网关返回重定向", 502);
    if (response.status === 401 || response.status === 403) throw new InspectorError("forbidden", "本机网关拒绝读取路由", 403);
    throw new InspectorError("offline", `本机路由不可读（HTTP ${response.status}）`, 502);
  }
  const raw = await readCapped(response, MAX_BODY, () => new InspectorError("incompatible", "本机路由过大", 502));
  try {
    return JSON.parse(raw);
  } catch {
    throw new InspectorError("incompatible", "本机路由不是有效 JSON", 502);
  }
}
