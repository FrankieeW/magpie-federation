// The page's calls to its own service: the per-process token on each, no
// cookies, no redirects, and a time limit, with errors in the service's words.

import { scalar } from "./dom.ts";

export class ApiError extends Error {
  readonly state: string;
  readonly status: number;

  constructor(state: string, message: string, status = 0) {
    super(message);
    this.name = "ApiError";
    this.state = state;
    this.status = status;
  }
}

const token = document.documentElement.dataset.apiToken ?? "";

function apiUrl(endpoint: string, parameters?: Record<string, string | number>): URL {
  const url = new URL(`./api/${endpoint}`, document.baseURI);
  for (const [key, value] of Object.entries(parameters ?? {})) url.searchParams.set(key, String(value));
  return url;
}

async function send<T>(url: URL, init: RequestInit, signal: AbortSignal | undefined, timeout: number): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", abort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeout);
  try {
    const response = await fetch(url, {
      ...init,
      headers: { "X-Inspector-Token": token, Accept: "application/json", ...(init.headers as Record<string, string> | undefined) },
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: controller.signal,
    });
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
      throw new ApiError("incompatible", `服务返回了无法读取的数据（HTTP ${response.status}）。`, response.status);
    }
    const error = (payload as { error?: { state?: string; message?: string } } | null)?.error;
    if (!response.ok || error) {
      const state = error?.state || (response.status === 401 || response.status === 403 ? "forbidden" : "error");
      throw new ApiError(state, scalar(error?.message, `请求失败（HTTP ${response.status}）。`), response.status);
    }
    return payload as T;
  } catch (error) {
    if (signal?.aborted) throw error;
    if (timedOut) throw new ApiError("offline", "响应超时，等待恢复连接。");
    if (error instanceof ApiError) throw error;
    throw new ApiError("offline", "无法连接观测服务或远端；请检查服务与网络。");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

export function getJson<T>(endpoint: string, parameters?: Record<string, string | number>, signal?: AbortSignal, timeout = 50_000): Promise<T> {
  return send<T>(apiUrl(endpoint, parameters), { method: "GET" }, signal, timeout);
}

export function postJson<T>(endpoint: string, body: unknown, signal?: AbortSignal, timeout = 60_000): Promise<T> {
  return send<T>(apiUrl(endpoint), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, signal, timeout);
}
