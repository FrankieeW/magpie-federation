// The peer API: this machine's pools, offered to the console on another
// computer. It listens where the configuration says (loopback behind the
// machine's own HTTPS reverse proxy, or a private address), takes server
// calls alone — a browser's request is refused before anything else — and
// answers only callers holding one of this Magpie's gateway keys.

import type { PeerHello } from "../shared/api.ts";
import { parseMembers, parseOp, parsePoolId } from "../shared/parse.ts";
import { InspectorError, isObject } from "../server/errors.ts";
import { errorResponse, jsonResponse, readJson } from "../server/http.ts";
import { health, listen } from "../server/listen.ts";
import type { PoolService } from "../machine/pools.ts";
import type { Caller, Verifier } from "./auth.ts";

export interface PeerServerOptions {
  readonly host: string;
  readonly port: number;
  /** A prefix a reverse proxy may keep, such as `/inspector`. */
  readonly basePath: string;
  readonly version: string;
  readonly service: PoolService;
  readonly verify: Verifier;
}

export interface RunningPeer {
  readonly port: number;
  /** Another copy of this same build serves the port; this one takes it when that copy lets go. */
  readonly standby: boolean;
  stop(): void;
}

interface RequestIP {
  requestIP(request: Request): { address: string } | null;
}

const FORWARD_HEADERS = ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-real-ip", "cf-connecting-ip", "true-client-ip", "tailscale-user-login"];
const LOOPBACK = /^(?:127\.|::1$|::ffff:127\.)/;

const BROWSER_HEADERS = ["origin", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest"];

function requireWrite(caller: Caller): void {
  if (!caller.canWrite) {
    const why = caller.readOnly ? "这是只读密钥" : "这把密钥不在 peer.writers 中，或受预算限制";
    throw new InspectorError("forbidden", `不能修改池子：${why}`, 403);
  }
}

function routePath(url: URL, basePath: string): string {
  const path = url.pathname;
  if (basePath && (path === basePath || path.startsWith(`${basePath}/`))) return path.slice(basePath.length) || "/";
  return path;
}

async function body(request: Request): Promise<Record<string, unknown>> {
  const value = await readJson(request);
  if (!isObject(value)) throw new InspectorError("error", "请求体必须是对象", 400);
  return value;
}

export function peerHandler(options: PeerServerOptions): (request: Request, server?: RequestIP) => Promise<Response> {
  const { service, verify } = options;
  return async (request, server) => {
    try {
      // The health probe answers this machine's own direct calls alone (a
      // restarting copy of the plugin asking who holds the port); through
      // the reverse proxy it doesn't exist.
      if (request.method === "GET" && new URL(request.url).pathname === "/healthz") {
        const from = server?.requestIP(request)?.address ?? "";
        const direct = !FORWARD_HEADERS.some((name) => request.headers.has(name)) && (LOOPBACK.test(from) || from === options.host);
        if (direct) return jsonResponse(health());
        throw new InspectorError("error", "接口不存在", 404);
      }
      if (BROWSER_HEADERS.some((name) => request.headers.has(name))) {
        throw new InspectorError("forbidden", "peer 接口只接受服务端调用", 403);
      }
      const caller = await verify(request.headers.get("authorization"));
      const route = `${request.method} ${routePath(new URL(request.url), options.basePath)}`;
      switch (route) {
        case "GET /v1/peer": {
          const hello: PeerHello = {
            api: 1,
            name: "magpie-route-inspector",
            version: options.version,
            magpieVersion: caller.magpieVersion,
            caller: { key: caller.key, readOnly: caller.readOnly, canWrite: caller.canWrite },
          };
          return jsonResponse(hello);
        }
        case "GET /v1/pools":
          return jsonResponse(await service.snapshot());
        case "POST /v1/preview": {
          const input = await body(request);
          return jsonResponse(await service.preview(parsePoolId(input.pool), parseOp(input.op)));
        }
        case "POST /v1/apply": {
          requireWrite(caller);
          const input = await body(request);
          const applied = await service.apply(parsePoolId(input.pool), parseOp(input.op), parseMembers(input.expected, "expected"), `key:${caller.key}`);
          return jsonResponse(applied);
        }
        case "POST /v1/undo": {
          requireWrite(caller);
          const input = await body(request);
          if (typeof input.change !== "string" || !/^[\w.-]{1,128}$/.test(input.change)) throw new InspectorError("error", "change 无效", 400);
          return jsonResponse(await service.undo(input.change, `key:${caller.key}`));
        }
        default:
          throw new InspectorError("error", "接口不存在", 404);
      }
    } catch (error) {
      return errorResponse(error);
    }
  };
}

export async function startPeer(options: PeerServerOptions): Promise<RunningPeer> {
  const handler = peerHandler(options);
  const host = options.host.includes(":") ? `[${options.host}]` : options.host;
  let port = options.port;
  const listening = await listen(
    () => Bun.serve({ hostname: options.host, port: options.port, idleTimeout: 30, fetch: handler }),
    options.port,
    `http://${host}:${options.port}/healthz`,
    (late) => {
      port = late.port ?? port;
    },
  );
  port = listening.server?.port ?? port;
  return {
    get port() {
      return port;
    },
    standby: listening.standby,
    stop: () => listening.stop(),
  };
}
