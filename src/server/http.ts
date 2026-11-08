// HTTP helpers both services share: JSON answers, bounded JSON bodies, and
// errors that tell the reader what happened without leaking internals.

import { ParseError } from "../shared/parse.ts";
import { InspectorError } from "./errors.ts";

const BASE_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
} as const;

export function jsonResponse(value: unknown, status = 200, extra?: Headers): Response {
  const headers = new Headers(BASE_HEADERS);
  headers.set("content-type", "application/json; charset=utf-8");
  extra?.forEach((value, key) => headers.set(key, value));
  return new Response(JSON.stringify(value), { status, headers });
}

export function errorResponse(error: unknown, extra?: Headers): Response {
  if (error instanceof InspectorError) {
    return jsonResponse({ error: { state: error.state, message: error.message } }, error.status, extra);
  }
  if (error instanceof ParseError) {
    return jsonResponse({ error: { state: "error", message: error.message } }, 400, extra);
  }
  return jsonResponse({ error: { state: "error", message: "服务处理请求失败" } }, 500, extra);
}

/**
 * A response's text, read as it streams in and given up the moment it passes
 * `max` bytes — a peer or gateway answering without end can't fill memory.
 */
export async function readCapped(response: Response, max: number, tooBig: () => Error): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      throw tooBig();
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/** A JSON body of at most `max` bytes, sent as application/json. */
export async function readJson(request: Request, max = 64 * 1024): Promise<unknown> {
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/json(?:\s*;|$)/i.test(type)) {
    throw new InspectorError("error", "请求体必须是 application/json", 415);
  }
  const reader = request.body?.getReader();
  if (!reader) throw new InspectorError("error", "缺少请求体", 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new InspectorError("error", "请求体过大", 413);
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
  } catch {
    throw new InspectorError("error", "请求体不是有效的 JSON", 400);
  }
}
