import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cachedSameUser, sameUserCheck } from "../server/owner.ts";
import { boundedJson, remoteRequest } from "./catalog.ts";
import { isRecord, loadFederation } from "./config.ts";

const PAGE = fileURLToPath(new URL("../../page/", import.meta.url));
const CLI = fileURLToPath(new URL("../../scripts/federation.ts", import.meta.url));

function matches(value: string, expected: string): boolean {
  return Buffer.byteLength(value) === expected.length && timingSafeEqual(Buffer.from(value), Buffer.from(expected));
}

export function dashboardHandler(path: string, port: number) {
  const token = randomBytes(32).toString("hex");
  const check = sameUserCheck();
  const owner = check ? cachedSameUser(check) : null;
  return async (request: Request, clientPort?: number): Promise<Response> => {
    const url = new URL(request.url);
    const origin = request.headers.get("origin");
    const own = `http://127.0.0.1:${port}`;
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(request.headers.get("host") ?? "") ||
      (origin && origin !== "null" && origin !== own && origin !== `http://localhost:${port}`) ||
      [...request.headers.keys()].some((name) => name.startsWith("x-forwarded-") || name === "forwarded")) {
      return new Response("Forbidden", { status: 403 });
    }
    if (owner && (!clientPort || !(await owner(clientPort, port)))) return new Response("Forbidden", { status: 403 });
    const headers = new Headers({
      "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
      "content-security-policy": `default-src 'none'; script-src 'self' ${own} http://localhost:${port}; style-src 'self' 'unsafe-inline' ${own} http://localhost:${port}; connect-src 'self' ${own} http://localhost:${port}; img-src 'self' data: ${own} http://localhost:${port}; base-uri 'none'; frame-ancestors 'self' wails: http://wails.localhost`,
    });
    if (origin === "null") {
      headers.set("access-control-allow-origin", "null");
      headers.set("vary", "Origin");
    }
    if (request.method === "OPTIONS") {
      headers.set("access-control-allow-methods", "GET, POST");
      headers.set("access-control-allow-headers", "authorization, content-type");
      return new Response(null, { status: 204, headers });
    }
    const json = (value: unknown, status = 200) => {
      const next = new Headers(headers);
      next.set("content-type", "application/json");
      return new Response(JSON.stringify(value), { status, headers: next });
    };
    try {
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/dashboard/")) {
        headers.set("content-type", "text/html; charset=utf-8");
        const html = (await readFile(join(PAGE, "dashboard.html"), "utf8")).replace("__DASHBOARD_TOKEN__", token);
        return new Response(html, { headers });
      }
      const assets: Record<string, string> = { "/dashboard/app.js": "dashboard.js", "/dashboard/style.css": "dashboard.css" };
      const asset = assets[url.pathname];
      if (request.method === "GET" && asset) {
        headers.set("content-type", asset.endsWith(".js") ? "text/javascript" : "text/css");
        return new Response(Bun.file(join(PAGE, asset)), { headers });
      }
      if (request.method === "GET" && url.pathname === "/api/icon") {
        const name = url.searchParams.get("name") ?? "";
        let file: string;
        if (/^file:[a-f0-9]{16}\.(png|jpg|gif|webp|ico|svg)$/.test(name)) {
          const base = process.env.XDG_CONFIG_HOME || join(process.env.HOME || homedir(), ".config");
          file = join(base, "magpie", "icons", name.slice(5));
        } else if (/^[a-zA-Z0-9_-]{1,80}$/.test(name)) {
          file = join(PAGE, "icons", `${name}.${name === "zcode" ? "png" : "svg"}`);
        } else return new Response("Not found", { status: 404 });
        if (!(await Bun.file(file).exists())) file = join(PAGE, "icon.svg");
        const types: Record<string, string> = { svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp", ico: "image/x-icon" };
        headers.set("content-type", types[file.split(".").at(-1)!] ?? "application/octet-stream");
        return new Response(Bun.file(file), { headers });
      }
      if (!matches(request.headers.get("authorization")?.replace(/^Bearer /i, "") ?? "", token)) return json({ error: "dashboard_session_expired" }, 401);
      const config = await loadFederation(path);
      if (request.method === "GET" && url.pathname === "/api/status") {
        return json({ enabled: config.enabled, mode: config.mode, servers: config.servers.map((server) => ({ id: server.id, name: server.name })) });
      }
      if (request.method === "POST" && url.pathname === "/api/settings") {
        if (!request.headers.get("content-type")?.startsWith("application/json")) return json({ error: "需要 JSON 设置" }, 415);
        const value = await boundedJson(new Response(request.body), 4096);
        if (!isRecord(value) || typeof value.enabled !== "boolean" || !["lite", "full"].includes(String(value.mode))) return json({ error: "设置无效" }, 400);
        const child = Bun.spawn([process.execPath, CLI, "settings", JSON.stringify({ enabled: value.enabled, mode: value.mode })], {
          env: { ...process.env, MAGPIE_FEDERATION_CONFIG: path },
          stdin: "ignore", stdout: "pipe", stderr: "pipe",
        });
        const timer = setTimeout(() => child.kill(), 180_000);
        const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        clearTimeout(timer);
        if (code !== 0) return json({ error: error.trim().slice(-1000) || "设置未能应用，请重试" }, 503);
        return json({ applied: true, message: out.trim() });
      }
      if (request.method !== "GET" || url.pathname !== "/api/dashboard") return json({ error: "Not found" }, 404);
      if (!config.enabled) return json({ disabled: true });
      const server = config.servers.find((item) => item.id === url.searchParams.get("server"));
      if (!server) return json({ error: "请选择已连接的服务器" }, 404);
      const period = url.searchParams.get("period") ?? "today";
      if (!["today", "7d", "30d", "all"].includes(period)) return json({ error: "时间范围无效" }, 400);
      const endpoints = {
        info: "/v1", usage: `magpie/usage?period=${period}`, quotas: "magpie/quotas/cards", models: "models",
      };
      const results = await Promise.all(Object.entries(endpoints).map(async ([key, endpoint]) => {
        try {
          const response = await remoteRequest(server, endpoint, {
            signal: AbortSignal.timeout(15_000),
            headers: key === "models" ? { "x-magpie-prices": "1", "x-magpie-drawers": "1", "x-magpie-videomakers": "1", "x-magpie-deciders": "1" } : {},
          });
          if (!response.ok) {
            await response.body?.cancel();
            return [key, { unavailable: true, status: response.status }];
          }
          return [key, await boundedJson(response)];
        } catch {
          return [key, { unavailable: true }];
        }
      }));
      return json({ server: { id: server.id, name: server.name }, observedAt: new Date().toISOString(), ...Object.fromEntries(results) });
    } catch {
      return json({ error: "暂时无法读取远端看板，请重试" }, 503);
    }
  };
}
