import { timingSafeEqual } from "node:crypto";
import { boundedJson, remoteRequest } from "./catalog.ts";
import { isRecord, loadFederation, type FederationConfig } from "./config.ts";

export function providerUrl(config: FederationConfig, server: string, source: string): string {
  return `http://127.0.0.1:${config.port}/provider/${encodeURIComponent(server)}/${encodeURIComponent(source)}`;
}

export function localRequest(request: Request, port: number): boolean {
  return [`127.0.0.1:${port}`, `localhost:${port}`].includes(request.headers.get("host") ?? "") &&
    !request.headers.has("origin") &&
    ![...request.headers.keys()].some((name) => name.startsWith("sec-fetch-") || name.startsWith("x-forwarded-") || name === "forwarded");
}

function authorized(request: Request, token: string): boolean {
  const supplied = request.headers.get("x-api-key") || request.headers.get("authorization")?.replace(/^Bearer /i, "") || "";
  return token.length === 64 && Buffer.byteLength(supplied) === Buffer.byteLength(token) &&
    timingSafeEqual(Buffer.from(supplied), Buffer.from(token));
}

function forwarded(response: Response): Response {
  const headers = new Headers(response.headers);
  // Fetch decodes compressed bodies. The returned stream has its own framing.
  for (const name of ["content-length", "content-encoding", "transfer-encoding", "connection", "set-cookie"]) headers.delete(name);
  headers.set("cache-control", "no-store");
  return new Response(response.body, { status: response.status, headers });
}

const reads = new Set([
  "/v1", "/v1/models", "/v1/magpie/quotas", "/v1/magpie/quotas/cards",
  "/v1/magpie/quotas/history", "/v1/magpie/limit", "/v1/magpie/concurrency",
  "/v1/magpie/usage/requests", "/v1/magpie/route", "/v1/magpie/trace",
]);
const writes = new Set([
  "/v1/chat/completions", "/v1/responses", "/v1/messages", "/v1/messages/count_tokens",
  "/v1/systemone", "/v1/embeddings", "/v1/rerank", "/v1/decisions",
  "/v1/audio/transcriptions", "/v1/audio/translations", "/v1/audio/speech",
  "/v1/images/generations", "/v1/images/edits", "/v1/videos",
  "/v1/magpie/quotas/refresh",
]);

/** A native Remote magpie connection whose catalog belongs to one supplier. */
export function providerHandler(configPath: string, port: number) {
  return async (request: Request): Promise<Response> => {
    if (!localRequest(request, port)) return new Response("Forbidden", { status: 403 });
    const url = new URL(request.url);
    const match = /^\/provider\/([^/]+)\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (!match) return new Response("Not found", { status: 404 });
    try {
      const config = await loadFederation(configPath);
      if (!config.enabled || config.mode !== "full") return new Response("Full integration is disabled", { status: 403 });
      if (!authorized(request, config.token)) return new Response("Unauthorized", { status: 401 });
      const serverId = decodeURIComponent(match[1]!);
      const source = decodeURIComponent(match[2]!);
      if (!source || source === "." || source === ".." || /[/\x00-\x20\x7f]/.test(source)) return new Response("Not found", { status: 404 });
      const server = config.servers.find((item) => item.id === serverId);
      if (!server || (server.providers && !server.providers.includes(source))) return new Response("Not found", { status: 404 });
      const path = match[3] === undefined || match[3] === "/" ? "/v1" : match[3]!.replace(/\/$/, "");
      const singleModel = path.startsWith("/v1/models/");
      const video = /^\/v1\/videos\/[A-Za-z0-9_.:-]+(?:\/content)?$/.test(path);
      const responseById = /^\/v1\/responses\/[A-Za-z0-9_.:-]+$/.test(path);
      const gemini = /^\/v1beta\/models\/[^/]+:(?:generateContent|streamGenerateContent|countTokens)$/.test(path);
      if (request.method === "GET" ? !reads.has(path) && !singleModel && !video && !responseById
        : request.method === "POST" ? !writes.has(path) && !gemini : true) {
        return new Response("Unsupported federation API", { status: 405 });
      }
      if (singleModel && !decodeURIComponent(path.slice("/v1/models/".length)).startsWith(`${source}/`)) return new Response("Not found", { status: 404 });
      const headers = new Headers(request.headers);
      for (const name of ["host", "content-length", "connection", "cookie", "accept-encoding"]) headers.delete(name);
      const query = new URLSearchParams(url.search);
      let body: RequestInit["body"];
      if (request.method === "POST") {
        if (path === "/v1/magpie/quotas/refresh") {
          query.set("provider", source);
        } else if (request.headers.get("content-type")?.includes("multipart/form-data")) {
          const bytes = await request.arrayBuffer();
          const form = await new Response(bytes, { headers: request.headers }).formData();
          const model = form.get("model");
          if (typeof model !== "string" || !model.startsWith(`${source}/`)) return new Response("Wrong remote provider", { status: 400 });
          body = bytes;
        } else {
          const value = await boundedJson(new Response(request.body), 64 * 1024 * 1024);
          if (!isRecord(value)) return new Response("Invalid request", { status: 400 });
          if (!gemini && (typeof value.model !== "string" || !value.model.startsWith(`${source}/`))) {
            return new Response("Wrong remote provider", { status: 400 });
          }
          body = JSON.stringify(value);
        }
      }
      if (path === "/v1/magpie/usage/requests") query.set("provider", source);
      const target = `${path}${query.size ? `?${query}` : ""}`;
      const response = await remoteRequest(server, target, {
        method: request.method, headers, ...(body === undefined ? {} : { body }), signal: request.signal,
      });
      if (!response.ok) return forwarded(response);
      const catalog = path === "/v1/models";
      const cards = path === "/v1/magpie/quotas" || path === "/v1/magpie/quotas/cards" || path === "/v1/magpie/quotas/refresh";
      const history = path === "/v1/magpie/quotas/history";
      if (!catalog && !cards && !history && path !== "/v1" && path !== "/v1/magpie/concurrency") return forwarded(response);
      const value = await boundedJson(response);
      if (!isRecord(value)) return Response.json(value);
      if (path === "/v1") {
        // MCP is connected separately, once per server or namespace.
        value.mcp_hub = false;
      } else if (Array.isArray(value.data)) {
        value.data = value.data.filter((row) => isRecord(row) && (catalog
          ? typeof row.id === "string" && row.id.startsWith(`${source}/`)
          : row.provider === source));
        if (catalog) {
          const rows = value.data as Record<string, unknown>[];
          value.first_id = rows[0]?.id ?? null;
          value.last_id = rows.at(-1)?.id ?? null;
          value.has_more = false;
        }
      }
      return Response.json(value, { headers: { "cache-control": "no-store" } });
    } catch {
      return Response.json({ error: { message: "Remote provider unavailable. Check the Federation configuration." } }, { status: 502 });
    }
  };
}
