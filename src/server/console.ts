// The page's service on this computer: loopback only, an unguessable token
// per process for every API call, and the Host checked against DNS
// rebinding. It serves the page, route observations, and every machine's
// pools — this one's directly, the others' through their peer API.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseMembers, parseOp, parsePoolId } from "../shared/parse.ts";
import type { PoolService } from "../machine/pools.ts";
import { loadConfig, type ConfigOptions } from "./config.ts";
import { InspectorError, isObject } from "./errors.ts";
import { errorResponse, jsonResponse, readJson } from "./http.ts";
import { health, listen } from "./listen.ts";
import { observe } from "./observe.ts";
import { cachedSameUser, sameUserCheck, type SameUser } from "./owner.ts";
import { poolsApi } from "./pools-api.ts";
import { uiBundle } from "./ui-bundle.ts";

const PUBLIC = fileURLToPath(new URL("../../public/", import.meta.url));
const CAPABILITIES = { mode: "session-latest", crossMachineCorrelation: false, historyComplete: false, pools: true };
// What a reverse proxy or tunnel adds. Magpie's own page-service proxy
// (magpie web) strips these, so a request carrying one came through
// something else in front of this loopback service, and is refused.
const FORWARD_HEADERS = ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-real-ip", "cf-connecting-ip", "true-client-ip", "tailscale-user-login"];

export interface ConsoleOptions extends ConfigOptions {
  readonly port?: unknown;
  readonly pools: PoolService;
  /** Extra origins allowed to frame the page, beyond Magpie's window and 'self'. */
  readonly frameAncestors?: readonly string[];
  /** Who may use the console; undefined is this platform's check, null none. */
  readonly sameUser?: SameUser | null;
}

// Who may frame the page: Magpie's own window (wails://localhost on macOS and
// Linux, http://wails.localhost on Windows, as Magpie's window tests name
// them) and, through magpie web's proxy, 'self' — the policy Magpie gives its
// own plugin pages. Any other site framing it to steer a click is refused.
const FRAME_ANCESTORS = ["'self'", "wails:", "http://wails.localhost"];
const ANCESTOR = /^(?:[a-z][a-z0-9+.-]*:|https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?)$/;

export function frameAncestorsOf(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 16 || !value.every((item) => typeof item === "string" && ANCESTOR.test(item))) {
    throw new Error("frameAncestors 必须是来源列表，例如 [\"https://magpie.example.com\"]");
  }
  return value as string[];
}

export interface RunningConsole {
  readonly port: number;
  readonly url: string;
  /** Another copy of this same build serves the port; this one takes it when that copy lets go. */
  readonly reused: boolean;
  stop(): void;
}

function tokenMatches(actual: string | null, expected: string): boolean {
  if (typeof actual !== "string") return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function securityHeaders(request: Request, port: number, ancestors: string): Headers {
  const own = `http://127.0.0.1:${port} http://localhost:${port}`;
  const headers = new Headers({
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "content-security-policy": `default-src 'none'; script-src 'self' ${own}; style-src 'self' ${own}; connect-src 'self' ${own}; img-src 'self' data: ${own}; base-uri 'none'; form-action 'none'; frame-ancestors ${ancestors}`,
  });
  // A sandboxed Magpie page has an opaque origin. The token is still
  // required for every API call; no other origin is ever granted.
  if (request.headers.get("origin") === "null") {
    headers.set("access-control-allow-origin", "null");
    headers.set("vary", "Origin");
  }
  return headers;
}

function routeArguments(url: URL): { remote: string; session: string; after: number; wait: number } {
  const remote = url.searchParams.get("remote") || "";
  const session = (url.searchParams.get("session") || "").trim();
  if (!remote || !session) throw new InspectorError("error", "需要远端和会话 ID", 400);
  if (new TextEncoder().encode(session).length > 128) throw new InspectorError("error", "会话 ID 超过 128 字节", 400);
  const afterText = url.searchParams.get("after") ?? "0";
  if (!/^\d+$/.test(afterText) || !Number.isSafeInteger(Number(afterText))) throw new InspectorError("error", "after 必须是非负安全整数", 400);
  const waitText = url.searchParams.get("wait") ?? "0";
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(waitText) || Number(waitText) > 25) throw new InspectorError("error", "wait 必须在 0 到 25 秒之间", 400);
  return { remote, session, after: Number(afterText), wait: Number(waitText) };
}

function machineOf(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) throw new InspectorError("error", "machine 无效", 400);
  return value;
}

async function objectBody(request: Request): Promise<Record<string, unknown>> {
  const value = await readJson(request);
  if (!isObject(value)) throw new InspectorError("error", "请求体必须是对象", 400);
  return value;
}

export async function startConsole(options: ConsoleOptions): Promise<RunningConsole> {
  const port = options.port === undefined || options.port === null || options.port === "" ? 3487 : Number(options.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("port must be an integer between 0 and 65535");
  const token = randomBytes(32).toString("hex");
  const ancestors = [...FRAME_ANCESTORS, ...frameAncestorsOf(options.frameAncestors)].join(" ");
  const check = options.sameUser === undefined ? sameUserCheck() : options.sameUser;
  const sameUser = check ? cachedSameUser(check) : null;
  const shutdown = new AbortController();
  const pools = poolsApi(options.pools, async () => (await loadConfig(options)).remotes);
  let boundPort = port;

  const api = async (request: Request, url: URL): Promise<Response> => {
    const route = `${request.method} ${url.pathname}`;
    if (route === "GET /api/remotes") {
      const { remotes } = await loadConfig(options);
      return jsonResponse({ remotes: remotes.map(({ id, name, peer }) => ({ id, name, peer: Boolean(peer) })), capabilities: CAPABILITIES });
    }
    if (route === "GET /api/route") {
      const args = routeArguments(url);
      const remote = (await loadConfig(options)).remotes.find((item) => item.id === args.remote);
      if (!remote) throw new InspectorError("error", "未找到配置的远端", 404);
      return jsonResponse(await observe(remote, args.session, args.after, args.wait, [request.signal, shutdown.signal]));
    }
    if (route === "GET /api/pools") return jsonResponse({ machines: await pools.machines() });
    if (route === "POST /api/pools/preview") {
      const body = await objectBody(request);
      const machine = machineOf(body.machine);
      return jsonResponse({ machine, ...(await pools.preview(machine, parsePoolId(body.pool), parseOp(body.op))) });
    }
    if (route === "POST /api/pools/apply") {
      const body = await objectBody(request);
      return jsonResponse(await pools.apply(machineOf(body.machine), parsePoolId(body.pool), parseOp(body.op), parseMembers(body.expected, "expected")));
    }
    if (route === "POST /api/pools/undo") {
      const body = await objectBody(request);
      if (typeof body.change !== "string" || !/^[\w.-]{1,128}$/.test(body.change)) throw new InspectorError("error", "change 无效", 400);
      return jsonResponse(await pools.undo(machineOf(body.machine), body.change));
    }
    throw new InspectorError("error", "接口不存在", 404);
  };

  const page = async (request: Request, url: URL, headers: Headers): Promise<Response> => {
    if (url.pathname === "/" || url.pathname === "/index.html") {
      if (request.headers.get("sec-fetch-site") === "cross-site" && !["document", "iframe"].includes(request.headers.get("sec-fetch-dest") ?? "")) {
        return new Response("Forbidden", { status: 403, headers });
      }
      const template = await readFile(`${PUBLIC}index.html`, "utf8");
      if (!template.includes("__INSPECTOR_API_TOKEN__")) throw new Error("missing token placeholder");
      const theme = ["dark", "light"].includes(url.searchParams.get("theme") ?? "") ? (url.searchParams.get("theme") as string) : "";
      headers.set("content-type", "text/html; charset=utf-8");
      return new Response(template.replaceAll("__INSPECTOR_API_TOKEN__", token).replaceAll("__INSPECTOR_THEME__", theme), { headers });
    }
    if (url.pathname === "/app.js") {
      headers.set("content-type", "text/javascript; charset=utf-8");
      return new Response(await uiBundle(), { headers });
    }
    if (url.pathname === "/style.css") {
      headers.set("content-type", "text/css; charset=utf-8");
      return new Response(await readFile(`${PUBLIC}style.css`), { headers });
    }
    return new Response("Not found", { status: 404, headers });
  };

  const handler = async (request: Request, server?: { requestIP(r: Request): { port: number } | null }): Promise<Response> => {
    const headers = securityHeaders(request, boundPort, ancestors);
    const host = request.headers.get("host")?.toLowerCase();
    if (host !== `127.0.0.1:${boundPort}` && host !== `localhost:${boundPort}`) return new Response("Forbidden Host", { status: 403, headers });
    if (FORWARD_HEADERS.some((name) => request.headers.has(name))) return new Response("不接受经由反向代理转发的访问", { status: 403, headers });
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") {
      return jsonResponse(health(), 200, headers);
    }
    if (sameUser) {
      const client = server?.requestIP(request);
      if (!client || !(await sameUser(client.port, boundPort))) {
        return new Response("只接受运行 Magpie 的系统用户访问", { status: 403, headers });
      }
    }
    if (url.pathname.startsWith("/api/")) {
      if (request.method === "OPTIONS" && request.headers.get("origin") === "null") {
        headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
        headers.set("access-control-allow-headers", "X-Inspector-Token, Content-Type");
        headers.set("access-control-max-age", "600");
        return new Response(null, { status: 204, headers });
      }
      const origin = request.headers.get("origin");
      if (request.method === "POST" && origin !== null && origin !== "null" && origin !== `http://127.0.0.1:${boundPort}` && origin !== `http://localhost:${boundPort}`) {
        return jsonResponse({ error: { state: "forbidden", message: "不接受来自其他来源的修改请求" } }, 403, headers);
      }
      if (!tokenMatches(request.headers.get("x-inspector-token"), token)) {
        return jsonResponse({ error: { state: "forbidden", message: "缺少有效的服务访问令牌" } }, 403, headers);
      }
      try {
        const response = await api(request, url);
        headers.forEach((value, key) => response.headers.set(key, value));
        return response;
      } catch (error) {
        return errorResponse(error, headers);
      }
    }
    if (request.method !== "GET") return jsonResponse({ error: { state: "error", message: "不支持的请求方法" } }, 405, headers);
    try {
      return await page(request, url, headers);
    } catch {
      return new Response("页面资源不可用", { status: 500, headers });
    }
  };

  const listening = await listen(
    () => Bun.serve({ hostname: "127.0.0.1", port, idleTimeout: 60, fetch: handler }),
    port,
    `http://127.0.0.1:${port}/healthz`,
    (late) => {
      boundPort = late.port ?? port;
    },
  );
  boundPort = listening.server?.port ?? port;
  return {
    port: boundPort,
    url: `http://127.0.0.1:${boundPort}/`,
    reused: listening.standby,
    stop() {
      shutdown.abort();
      listening.stop();
    },
  };
}
