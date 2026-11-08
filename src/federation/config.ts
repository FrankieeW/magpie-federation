import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Env } from "../machine/cli.ts";

export interface ServerConfig {
  id: string;
  name: string;
  url: string;
  key?: string;
  keyEnv?: string;
  providers?: string[];
  mcp: false | "hub" | "servers";
}

export interface FederationConfig {
  port: number;
  token: string;
  servers: ServerConfig[];
  enabled: boolean;
  mode: "lite" | "full";
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function configurationPath(env: Env = process.env): string {
  return resolve(env.MAGPIE_FEDERATION_CONFIG ||
    join(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config"), "magpie-federation", "config.json"));
}

export function gatewayUrl(value: unknown): string {
  let url: URL;
  try {
    url = new URL(String(value));
  } catch {
    throw new Error("服务器地址必须是 HTTP(S) URL");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("服务器地址不能含凭据、查询或片段");
  }
  if (!/^\/(?:v1\/?)?$/.test(url.pathname)) throw new Error("服务器地址只接受 origin 或 /v1");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const parts = host.split(".").map(Number);
  const ipv4 = parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255);
  const [a = -1, b = -1] = parts;
  const privateHost = host === "localhost" || host === "::1" || host.endsWith(".ts.net") || host.endsWith(".local") ||
    (ipv4 && (a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)));
  if (url.protocol === "http:" && !privateHost) throw new Error("公网服务器必须使用 HTTPS");
  return `${url.origin}/v1/`;
}

export function parseFederation(value: unknown): FederationConfig {
  if (!isRecord(value)) throw new Error("配置必须是对象");
  const port = value.port ?? 3487;
  if (!Number.isInteger(port) || Number(port) < 1024 || Number(port) > 65535) throw new Error("port 必须是 1024–65535");
  const token = value.token ?? "";
  if (typeof token !== "string" || (token !== "" && !/^[a-f0-9]{64}$/.test(token))) throw new Error("token 必须是 64 位随机十六进制字符串");
  const entries = value.servers ?? value.remotes ?? [];
  if (!Array.isArray(entries)) throw new Error("servers 必须是数组");
  const enabled = value.enabled ?? true;
  const mode = value.mode ?? (entries.length ? "full" : "lite");
  if (typeof enabled !== "boolean") throw new Error("enabled 必须是布尔值");
  if (mode !== "lite" && mode !== "full") throw new Error("mode 必须是 lite 或 full");
  const seen = new Set<string>();
  const servers = entries.map((entry): ServerConfig => {
    if (!isRecord(entry) || typeof entry.id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(entry.id) || seen.has(entry.id)) {
      throw new Error("每台服务器需要唯一的 1–64 位 id，只允许字母、数字、连字符和下划线");
    }
    seen.add(entry.id);
    const name = entry.name ?? entry.id;
    if (typeof name !== "string" || !name.trim() || name.length > 120 || /[\x00-\x1f\x7f]/.test(name)) throw new Error(`${entry.id} 的 name 无效`);
    if (entry.key !== undefined && (typeof entry.key !== "string" || !entry.key || /[\x00-\x20\x7f]/.test(entry.key))) throw new Error(`${entry.id} 的 key 无效`);
    if (entry.keyEnv !== undefined && (typeof entry.keyEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.keyEnv))) throw new Error(`${entry.id} 的 keyEnv 无效`);
    if (entry.providers !== undefined && (!Array.isArray(entry.providers) || !entry.providers.every((id) => typeof id === "string" && id && !/[\x00-\x20/]/.test(id)))) {
      throw new Error(`${entry.id} 的 providers 必须是远端供应商 id 数组`);
    }
    const mcp = entry.mcp === true ? "hub" : (entry.mcp ?? "hub");
    if (mcp !== false && mcp !== "hub" && mcp !== "servers") throw new Error(`${entry.id} 的 mcp 只能是 false、hub 或 servers`);
    return {
      id: entry.id,
      name: name.trim(),
      url: gatewayUrl(entry.url),
      ...(entry.key === undefined ? {} : { key: entry.key as string }),
      ...(entry.keyEnv === undefined ? {} : { keyEnv: entry.keyEnv as string }),
      ...(entry.providers === undefined ? {} : { providers: entry.providers as string[] }),
      mcp,
    };
  });
  return { port: Number(port), token, servers, enabled, mode };
}

export async function loadFederation(path = configurationPath()): Promise<FederationConfig> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return parseFederation({});
    throw new Error("无法读取 Federation 配置");
  }
  if (text.length > 1024 * 1024) throw new Error("Federation 配置超过 1 MiB");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Federation 配置不是有效的 JSON");
  }
  return parseFederation(value);
}

export async function writePrivate(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, content, { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

export async function saveFederation(config: FederationConfig, path = configurationPath()): Promise<void> {
  config.token ||= randomBytes(32).toString("hex");
  await writePrivate(path, `${JSON.stringify(parseFederation(config), null, 2)}\n`);
}

export function serverKey(server: ServerConfig, env: Env = process.env): string | undefined {
  const key = server.keyEnv ? env[server.keyEnv] : server.key;
  if (server.keyEnv && !key) throw new Error(`${server.id} 的密钥环境变量尚未设置`);
  if (key && /[\x00-\x20\x7f]/.test(key)) throw new Error(`${server.id} 的网关密钥无效`);
  return key;
}

export async function configuredServer(path: string, id: string): Promise<ServerConfig> {
  const server = (await loadFederation(path)).servers.find((item) => item.id === id);
  if (!server) throw new Error(`服务器 ${id} 已从配置移除，请重新同步`);
  return server;
}
