// The plugin's configuration file: the remotes the console observes and
// manages, and — on a machine that offers its pools — the peer listener.
// `remotes` is read again on every request that needs it, so an edit
// applies at once; `peer` (its listener and writers) is read at start.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Env } from "../machine/cli.ts";
import { InspectorError, isObject } from "./errors.ts";

export interface RemoteConfig {
  readonly id: string;
  readonly name: string;
  /** The remote gateway's `/v1/` base. */
  readonly url: string;
  readonly key?: string;
  readonly accountAliases: Readonly<Record<string, string>>;
  /** The remote plugin's peer API base, ending in `/`. */
  readonly peer?: string;
}

export interface PeerListenConfig {
  readonly host: string;
  readonly port: number;
  readonly basePath: string;
  readonly writers: readonly string[];
}

export interface Config {
  readonly remotes: readonly RemoteConfig[];
  readonly peer?: PeerListenConfig;
}

export interface ConfigOptions {
  readonly config?: unknown;
}

const invalid = (message: string) => new InspectorError("error", `配置错误：${message}`, 503);

/** Cleartext is let through only where the network itself is private. */
export function plainHttpAllowed(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host === "::1" || host.endsWith(".ts.net") || host.endsWith(".local")) return true;
  const ip = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!ip) return false;
  const [a, b] = [Number(ip[1]), Number(ip[2])];
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

function checkedUrl(raw: unknown, at: string): URL {
  let url: URL;
  try {
    url = new URL(String(raw));
  } catch {
    throw invalid(`${at} 必须是 HTTP(S) 地址`);
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw invalid(`${at} 只能是 HTTP(S) 地址，不能包含凭据、查询或片段`);
  }
  if (url.protocol === "http:" && !plainHttpAllowed(url.hostname)) {
    throw invalid(`${at} 在公网上必须使用 https://（网关密钥不能明文传输）`);
  }
  return url;
}

export function configPath(options: ConfigOptions = {}, env: Env = process.env): { path: string; explicit: boolean } {
  const explicit = options.config ?? env.MAGPIE_ROUTE_INSPECTOR_CONFIG;
  if (explicit !== undefined && (typeof explicit !== "string" || !explicit.trim())) throw invalid("config 必须是 JSON 配置文件路径");
  const base = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config");
  return { path: (explicit as string | undefined) ?? join(base, "magpie-route-inspector", "config.json"), explicit: explicit !== undefined };
}

function keyOf(entry: Record<string, unknown>, at: string, env: Env): string | undefined {
  let key = entry.key;
  if (entry.keyEnv !== undefined) {
    if (typeof entry.keyEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.keyEnv)) throw invalid(`${at}.keyEnv 必须是环境变量名`);
    key = env[entry.keyEnv];
    if (typeof key !== "string" || !key) throw invalid(`${at}.keyEnv 指定的环境变量尚未设置`);
  }
  if (key !== undefined && (typeof key !== "string" || !key || /[\x00-\x20\x7f]/.test(key))) throw invalid(`${at} 的 API key 无效`);
  return key as string | undefined;
}

function aliasesOf(entry: Record<string, unknown>, at: string): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  if (entry.accountAliases === undefined) return out;
  if (!isObject(entry.accountAliases)) throw invalid(`${at}.accountAliases 必须是身份到别名的对象`);
  for (const [identity, alias] of Object.entries(entry.accountAliases)) {
    if (!identity || typeof alias !== "string" || !alias.trim() || alias.length > 120) throw invalid(`${at}.accountAliases 的身份和别名不能为空，别名最多 120 位`);
    out[identity] = alias.trim();
  }
  return out;
}

function peerUrlOf(value: unknown, gateway: URL, at: string): string | undefined {
  if (value === undefined || value === false) return undefined;
  if (value === true) return `${gateway.origin}/inspector/`;
  if (typeof value !== "string") throw invalid(`${at}.peer 必须是远端插件 peer 接口的地址，或 true（即 <网关 origin>/inspector/）`);
  const url = checkedUrl(value, `${at}.peer`);
  return `${url.origin}${url.pathname.replace(/\/*$/, "/")}`;
}

function remoteOf(entry: unknown, index: number, seen: Set<string>, env: Env): RemoteConfig {
  const at = `remotes[${index}]`;
  if (!isObject(entry)) throw invalid(`${at} 必须是对象`);
  if (typeof entry.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(entry.id) || entry.id === "local" || seen.has(entry.id)) {
    throw invalid(`${at}.id 必须是唯一的 1–64 位字母、数字、下划线或连字符，且不能是 local`);
  }
  seen.add(entry.id);
  if (typeof entry.name !== "string" || !entry.name.trim() || entry.name.length > 120) throw invalid(`${at}.name 需要 1–120 位显示名称`);
  const url = checkedUrl(entry.url, `${at}.url`);
  if (!/^\/(?:v1\/?)?$/.test(url.pathname)) throw invalid(`${at}.url 仅接受网关 origin 或 /v1`);
  const key = keyOf(entry, at, env);
  const peer = peerUrlOf(entry.peer, url, at);
  const base = { id: entry.id, name: entry.name.trim(), url: `${url.origin}/v1/`, accountAliases: aliasesOf(entry, at) };
  return { ...base, ...(key === undefined ? {} : { key }), ...(peer === undefined ? {} : { peer }) };
}

function listenOf(value: unknown): PeerListenConfig | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) throw invalid("peer 必须是对象");
  const match = typeof value.listen === "string" ? /^(\[::1\]|[0-9.]+|localhost):(\d{1,5})$/.exec(value.listen) : null;
  const port = match ? Number(match[2]) : 0;
  const host = match ? (match[1] as string).replace(/^\[|\]$/g, "") : "";
  if (!match || port < 1024 || port > 65535 || !plainHttpAllowed(host)) {
    throw invalid("peer.listen 必须是回环、内网或 Tailscale 地址加端口（如 127.0.0.1:3488），公网请放在 HTTPS 反向代理后面");
  }
  const writers = value.writers ?? [];
  if (!Array.isArray(writers) || !writers.every((w) => typeof w === "string" && w.trim() && w.length <= 128)) {
    throw invalid("peer.writers 必须是允许修改池子的网关密钥名称列表");
  }
  const basePath = value.basePath ?? "/inspector";
  if (typeof basePath !== "string" || !/^(?:\/[A-Za-z0-9._-]+)?$/.test(basePath)) throw invalid("peer.basePath 必须形如 /inspector");
  return { host, port, basePath, writers: writers.map((w: string) => w.trim()) };
}

export function parseConfig(value: unknown, env: Env = process.env): Config {
  if (!isObject(value)) throw invalid("配置必须是对象");
  const remotes = value.remotes ?? [];
  if (!Array.isArray(remotes)) throw invalid("remotes 必须是数组");
  const seen = new Set<string>();
  const peer = listenOf(value.peer);
  return { remotes: remotes.map((entry, i) => remoteOf(entry, i, seen, env)), ...(peer ? { peer } : {}) };
}

async function readConfigValue(options: ConfigOptions, env: Env): Promise<unknown> {
  const source = configPath(options, env);
  let text: string;
  try {
    text = await readFile(source.path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT" && !source.explicit) return {};
    throw invalid("无法读取配置文件，请检查路径和文件权限");
  }
  if (text.length > 1024 * 1024) throw invalid("配置文件超过 1 MiB");
  try {
    return JSON.parse(text);
  } catch {
    throw invalid("配置文件不是有效的 JSON");
  }
}

export async function loadConfig(options: ConfigOptions = {}, env: Env = process.env): Promise<Config> {
  return parseConfig(await readConfigValue(options, env), env);
}

/**
 * The peer listener alone, read once at start: the rest of the file may be
 * mid-edit then, and is read again by each request that needs it.
 */
export async function loadPeerConfig(options: ConfigOptions = {}, env: Env = process.env): Promise<PeerListenConfig | undefined> {
  // A file that exists but can't be read or parsed fails the start, so a
  // peer meant to run never silently doesn't.
  const value = await readConfigValue(options, env);
  return isObject(value) ? listenOf(value.peer) : undefined;
}
