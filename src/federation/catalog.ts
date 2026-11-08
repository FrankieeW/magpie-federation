import { createHash } from "node:crypto";
import { isRecord, serverKey, type ServerConfig } from "./config.ts";

export interface RemoteModel {
  id: string;
  provider: string;
  name: string;
  raw: Record<string, unknown>;
}

export interface RemoteProvider {
  id: string;
  name: string;
  models: RemoteModel[];
}

export type Fetcher = typeof fetch;

export function providerId(server: string, provider: string): string {
  const slug = provider.toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 36) || "provider";
  const hash = createHash("sha256").update(JSON.stringify([server, provider])).digest("hex").slice(0, 8);
  return `mf-${server.toLowerCase().slice(0, 20)}-${slug}-${hash}`;
}

export async function remoteRequest(server: ServerConfig, path: string, init: RequestInit = {}, fetcher: Fetcher = fetch): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.delete("authorization");
  headers.delete("x-api-key");
  headers.delete("x-goog-api-key");
  const key = serverKey(server);
  if (key) headers.set("authorization", `Bearer ${key}`);
  let response: Response;
  try {
    response = await fetcher(new URL(path, server.url), {
      ...init,
      headers,
      redirect: "manual",
      signal: init.signal ?? AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Error(`无法连接服务器 ${server.id}`);
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new Error(`服务器 ${server.id} 返回重定向，请配置最终地址`);
  }
  return response;
}

export async function boundedText(response: Response, maximum = 8 * 1024 * 1024): Promise<string> {
  if (!response.body) throw new Error("远端返回空响应");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) throw new Error("远端响应超过大小限制");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function boundedJson(response: Response, maximum = 8 * 1024 * 1024): Promise<unknown> {
  const text = await boundedText(response, maximum);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("远端响应不是有效 JSON");
  }
}

export function parseModels(value: unknown): RemoteProvider[] {
  if (!isRecord(value) || !Array.isArray(value.data)) throw new Error("远端 /v1/models 格式不兼容");
  const providers = new Map<string, RemoteProvider>();
  const seen = new Set<string>();
  for (const raw of value.data) {
    if (!isRecord(raw) || typeof raw.id !== "string" || seen.has(raw.id)) continue;
    const slash = raw.id.indexOf("/");
    if (slash < 1 || slash === raw.id.length - 1 || /[\x00-\x20\x7f]/.test(raw.id)) continue;
    seen.add(raw.id);
    const id = raw.id.slice(0, slash);
    // Routing groups stay identifiable as a separate source.
    const name = typeof raw.display_name === "string" ? raw.display_name : typeof raw.name === "string" ? raw.name : raw.id.slice(slash + 1);
    const labelPrefix = `${name} · `;
    const sourceName = typeof raw.magpie_label === "string" && raw.magpie_label.startsWith(labelPrefix)
      ? raw.magpie_label.slice(labelPrefix.length)
      : id;
    const providerName = typeof raw.magpie_provider_name === "string" ? raw.magpie_provider_name : id === "group" ? "路由组" : id === "auto" ? "自动路由" : sourceName;
    let provider = providers.get(id);
    if (!provider) {
      provider = { id, name: providerName, models: [] };
      providers.set(id, provider);
    }
    provider.models.push({ id: raw.id, provider: id, name, raw });
  }
  return [...providers.values()];
}

const pending = new Map<string, { expires: number; result: Promise<RemoteProvider[]> }>();

export async function discoverProviders(server: ServerConfig, fetcher: Fetcher = fetch, signal?: AbortSignal, cache = true): Promise<RemoteProvider[]> {
  const fingerprint = createHash("sha256").update(JSON.stringify([server.url, serverKey(server)])).digest("hex");
  const existing = pending.get(fingerprint);
  if (cache && existing && existing.expires > Date.now()) return existing.result;
  const result = (async () => {
    const response = await remoteRequest(server, "models", {
      headers: { "x-magpie-prices": "1" },
      ...(signal ? { signal } : {}),
    }, fetcher);
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`服务器 ${server.id} 的模型发现失败（HTTP ${response.status}）`);
    }
    return parseModels(await boundedJson(response));
  })();
  if (cache) {
    const entry = { expires: Date.now() + 30_000, result };
    pending.set(fingerprint, entry);
    void result.catch(() => {
      if (pending.get(fingerprint) === entry) pending.delete(fingerprint);
    });
    if (pending.size > 128) pending.delete(pending.keys().next().value!);
  }
  return result;
}
