import { createHash, timingSafeEqual } from "node:crypto";
import { isRecord, loadFederation, type FederationConfig, type ServerConfig } from "./config.ts";
import { boundedJson, boundedText, remoteRequest } from "./catalog.ts";

export interface McpDescriptor {
  server: string;
  namespace?: string;
  name: string;
}

export function mcpName(server: string, namespace?: string): string {
  const hash = createHash("sha256").update(JSON.stringify([server, namespace ?? null])).digest("hex").slice(0, 8);
  const label = `mf-${server}-mcp${namespace ? `-${namespace}` : ""}`.slice(0, 54);
  return `${label}-${hash}`;
}

export function mcpUrl(config: FederationConfig, item: McpDescriptor): string {
  const parts = [config.token, item.server, ...(item.namespace ? [item.namespace] : [])].map(encodeURIComponent);
  return `http://127.0.0.1:${config.port}/mcp/${parts.join("/")}`;
}

async function rpcJson(response: Response): Promise<unknown> {
  if (!response.headers.get("content-type")?.includes("text/event-stream")) return boundedJson(response);
  // Magpie's discovery replies contain one JSON-RPC result, sometimes in SSE.
  const text = await boundedText(response);
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (!data) continue;
    const value: unknown = JSON.parse(data);
    if (isRecord(value) && ("result" in value || "error" in value)) return value;
  }
  throw new Error("MCP 返回了不兼容的事件流");
}

export async function mcpRequest(server: ServerConfig, body: unknown, signal?: AbortSignal, incoming?: Headers): Promise<Response> {
  const headers = new Headers({
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "x-magpie-router": "magpie-federation",
  });
  for (const name of ["mcp-session-id", "mcp-protocol-version"]) {
    const value = incoming?.get(name);
    if (value) headers.set(name, value);
  }
  return remoteRequest(server, "/mcp/magpie/hub", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
}

export async function discoverMcp(server: ServerConfig): Promise<McpDescriptor[]> {
  if (server.mcp === false) return [];
  const info = await remoteRequest(server, "/v1");
  if (info.status === 404 || info.status === 405) {
    await info.body?.cancel();
    return [];
  }
  if (!info.ok) {
    await info.body?.cancel();
    throw new Error(`${server.id} 的 MCP 能力发现失败（HTTP ${info.status}）`);
  }
  const capabilities = await boundedJson(info);
  if (!isRecord(capabilities) || capabilities.mcp_hub !== true) return [];
  if (server.mcp === "hub") return [{ server: server.id, name: mcpName(server.id) }];
  const response = await mcpRequest(server, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`${server.id} 的 MCP 工具发现失败（HTTP ${response.status}）`);
  }
  const value = await rpcJson(response);
  if (!isRecord(value) || !isRecord(value.result) || !Array.isArray(value.result.tools)) throw new Error(`${server.id} 没有返回 MCP 工具目录`);
  const namespaces = new Set<string>();
  for (const tool of value.result.tools) {
    if (!isRecord(tool) || typeof tool.name !== "string") continue;
    const delimiter = tool.name.indexOf("__");
    if (delimiter > 0) namespaces.add(tool.name.slice(0, delimiter));
  }
  return [...namespaces].sort().map((namespace) => ({ server: server.id, namespace, name: mcpName(server.id, namespace) }));
}

function rpcError(id: unknown, message: string, status = 400): Response {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code: -32602, message } }, { status });
}

function validToken(received: string, token: string): boolean {
  return token.length === 64 && received.length === token.length && timingSafeEqual(Buffer.from(received), Buffer.from(token));
}

export function mcpHandler(path: string, port: number) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(request.headers.get("host") ?? "") ||
      request.headers.has("origin") || [...request.headers.keys()].some((name) => name.startsWith("sec-fetch-") || name.startsWith("x-forwarded-") || name === "forwarded")) {
      return new Response("Forbidden", { status: 403 });
    }
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const match = /^\/mcp\/([a-f0-9]{64})\/([A-Za-z0-9_-]+)(?:\/([A-Za-z0-9_-]+))?$/.exec(url.pathname);
    if (!match) return new Response("Not found", { status: 404 });
    try {
      const config = await loadFederation(path);
      if (!validToken(match[1]!, config.token)) return new Response("Forbidden", { status: 403 });
      const server = config.servers.find((item) => item.id === match[2]);
      if (!server || server.mcp === false) return new Response("Not found", { status: 404 });
      const namespace = match[3];
      if ((server.mcp === "hub") !== (namespace === undefined)) return new Response("Not found", { status: 404 });
      const body = await boundedJson(new Response(request.body), 4 * 1024 * 1024);
      if (!isRecord(body) || body.jsonrpc !== "2.0" || typeof body.method !== "string") return rpcError(null, "Invalid JSON-RPC request");
      if (!["initialize", "ping", "notifications/initialized", "tools/list", "tools/call"].includes(body.method)) return rpcError(body.id, "Unsupported MCP method");
      if (namespace && body.method === "tools/call") {
        const name = isRecord(body.params) ? body.params.name : undefined;
        if (typeof name !== "string" || !name.startsWith(`${namespace}__`)) return rpcError(body.id, "Tool does not belong to this remote MCP server");
      }
      const response = await mcpRequest(server, body, request.signal, request.headers);
      if (!response.ok || !["initialize", "tools/list"].includes(body.method)) return response;
      const value = await rpcJson(response);
      if (!isRecord(value) || !isRecord(value.result)) return Response.json(value);
      if (body.method === "tools/list" && namespace && Array.isArray(value.result.tools)) {
        value.result.tools = value.result.tools.filter((tool) => isRecord(tool) && typeof tool.name === "string" && tool.name.startsWith(`${namespace}__`));
      }
      if (body.method === "initialize") {
        const origin = `${server.name}${namespace ? ` / ${namespace}` : " / MCP"}`;
        value.result.serverInfo = { ...(isRecord(value.result.serverInfo) ? value.result.serverInfo : {}), name: mcpName(server.id, namespace), title: origin };
        value.result.instructions = namespace
          ? `Tools from ${namespace} on remote Magpie ${server.name} (${server.id}).`
          : `Remote Magpie ${server.name} (${server.id}). ${typeof value.result.instructions === "string" ? value.result.instructions : ""}`;
      }
      const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
      const session = response.headers.get("mcp-session-id");
      if (session) headers.set("mcp-session-id", session);
      return new Response(JSON.stringify(value), { headers });
    } catch {
      return rpcError(null, "Remote MCP unavailable. Check the server and Federation configuration.", 502);
    }
  };
}

const running = new Map<string, { stop(): void }>();

export async function startFederation(path: string): Promise<{ stop(): void } | undefined> {
  const existing = running.get(path);
  if (existing) return existing;
  const config = await loadFederation(path);
  if (!config.servers.some((server) => server.mcp !== false)) return undefined;
  if (!config.token) throw new Error("请先运行 magpie-federation sync 生成 MCP 连接令牌");
  let server: ReturnType<typeof Bun.serve> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listen = () => {
    try {
      server = Bun.serve({ hostname: "127.0.0.1", port: config.port, fetch: mcpHandler(path, config.port) });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      // A CLI host and the serving host can overlap during plugin reload.
      timer = setTimeout(listen, 250);
      timer.unref();
    }
  };
  listen();
  const service = {
    stop() {
      if (timer) clearTimeout(timer);
      server?.stop(true);
      running.delete(path);
    },
  };
  running.set(path, service);
  return service;
}
