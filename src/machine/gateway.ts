// This machine's own gateway, asked over loopback with fresh requests — never
// with headers a caller sent, so Magpie sees this computer's plugin, not a
// proxied stranger.

import { InspectorError, isObject } from "../server/errors.ts";
import { readCapped } from "../server/http.ts";

export interface KeyIdentity {
  readonly name: string;
  readonly readOnly: boolean;
  /** Held to a budget; such a key is never let change pools. */
  readonly limited: boolean;
  readonly version: string;
}

export interface Gateway {
  models(): Promise<unknown[]>;
  /** Who a gateway key is, by Magpie's own `/v1/magpie/me`, which answers 401 to no key, a wrong one or one turned off. */
  me(key: string): Promise<KeyIdentity>;
}

const MAX_BODY = 8 * 1024 * 1024;

async function getJSON(url: string, headers: Record<string, string>, timeoutMs: number): Promise<{ status: number; body: unknown }> {
  let response: Response;
  try {
    response = await fetch(url, { headers: { accept: "application/json", ...headers }, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new InspectorError("offline", "无法连接本机 Magpie 网关", 502);
  }
  const raw = await readCapped(response, MAX_BODY, () => new InspectorError("incompatible", "本机网关的回答过大", 502)).catch((error: unknown) => {
    if (error instanceof InspectorError) throw error;
    return "";
  });
  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {
    // a status alone still tells what happened
  }
  return { status: response.status, body };
}

export function gatewayClient(base: string, timeoutMs = 8000): Gateway {
  return {
    async models() {
      const { status, body } = await getJSON(`${base}/v1/models`, {}, timeoutMs);
      if (status !== 200 || !isObject(body) || !Array.isArray(body.data)) {
        throw new InspectorError("incompatible", `本机网关的模型列表不可用（HTTP ${status}）`, 502);
      }
      return body.data;
    },
    async me(key) {
      const { status, body } = await getJSON(`${base}/v1/magpie/me`, { authorization: `Bearer ${key}` }, timeoutMs);
      if (status === 401 || status === 403) throw new InspectorError("forbidden", "网关密钥无效、已停用或已过期", 401);
      if (status !== 200 || !isObject(body) || typeof body.name !== "string" || typeof body.readOnly !== "boolean") {
        throw new InspectorError("incompatible", `本机网关无法核验密钥（HTTP ${status}）`, 502);
      }
      return {
        name: body.name,
        readOnly: body.readOnly,
        limited: Array.isArray(body.limits) && body.limits.length > 0,
        version: typeof body.version === "string" ? body.version : "",
      };
    },
  };
}
