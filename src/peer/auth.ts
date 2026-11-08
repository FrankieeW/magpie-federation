// Who is calling the peer API: a gateway key of this machine's Magpie,
// checked by Magpie itself (`/v1/magpie/me`). Revoking the key in Magpie
// revokes it here within the cache's lifetime. Writing takes more: a key
// that is neither read-only nor held to a budget, named in `writers`.

import { createHash } from "node:crypto";
import { InspectorError } from "../server/errors.ts";
import type { Gateway } from "../machine/gateway.ts";

export interface Caller {
  readonly key: string;
  readonly readOnly: boolean;
  readonly canWrite: boolean;
  readonly magpieVersion: string;
}

export type Verifier = (authorization: string | null) => Promise<Caller>;

interface Entry {
  readonly until: number;
  readonly caller?: Caller;
  readonly error?: InspectorError;
}

export interface VerifierOptions {
  readonly okTtlMs?: number;
  readonly failTtlMs?: number;
  readonly now?: () => number;
}

const BEARER = /^Bearer\s+([\x21-\x7e]{16,512})$/i;
const MAX_ENTRIES = 256;
const BUCKET = 20;
const REFILL_MS = 3000;
const KNOWN_GOOD_MS = 24 * 60 * 60 * 1000;

/** A key name as safe to show and journal: no control characters, bounded. */
const keyName = (name: string) => name.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 100) || "unnamed";

function bounded<V>(map: Map<string, V>, key: string, value: V): Map<string, V> {
  const next = new Map(map);
  next.delete(key);
  next.set(key, value);
  while (next.size > MAX_ENTRIES) next.delete(next.keys().next().value as string);
  return next;
}

export function keyVerifier(gateway: Gateway, writers: readonly string[], options: VerifierOptions = {}): Verifier {
  const okTtl = options.okTtlMs ?? 30_000;
  const failTtl = options.failTtlMs ?? 5_000;
  const now = options.now ?? Date.now;
  const allowed = new Set(writers);
  let cache = new Map<string, Entry>();
  let knownGood = new Map<string, number>();
  const inflight = new Map<string, Promise<Caller>>();
  let tokens = BUCKET;
  let refilledAt = now();

  // Only a lookup that reaches the gateway costs anything, so only such a
  // lookup spends the budget: a missing header or a cached answer never
  // does. The token is taken before the gateway is asked, so a burst of
  // concurrent wrong keys can't spend more than the bucket holds, and a key
  // that verified before skips the bucket, so a flood never locks it out.
  const reserve = (hash: string): boolean => {
    const seen = knownGood.get(hash);
    if (seen !== undefined && now() - seen < KNOWN_GOOD_MS) return false;
    const t = now();
    tokens = Math.min(BUCKET, tokens + Math.floor((t - refilledAt) / REFILL_MS));
    refilledAt = t - ((t - refilledAt) % REFILL_MS);
    if (tokens <= 0) throw new InspectorError("forbidden", "失败的认证过多，请稍后再试", 429);
    tokens -= 1;
    return true;
  };
  const refund = () => {
    tokens = Math.min(BUCKET, tokens + 1);
  };

  const lookup = async (hash: string, key: string): Promise<Caller> => {
    const reserved = reserve(hash);
    try {
      const who = await gateway.me(key);
      if (reserved) refund();
      const name = keyName(who.name);
      const caller: Caller = { key: name, readOnly: who.readOnly, canWrite: !who.readOnly && !who.limited && allowed.has(who.name), magpieVersion: who.version };
      cache = bounded(cache, hash, { until: now() + okTtl, caller });
      knownGood = bounded(knownGood, hash, now());
      return caller;
    } catch (error) {
      const failure = error instanceof InspectorError ? error : new InspectorError("error", "无法核验网关密钥", 502);
      if (failure.state === "forbidden") {
        cache = bounded(cache, hash, { until: now() + failTtl, error: failure });
        knownGood = new Map([...knownGood].filter(([h]) => h !== hash));
      } else if (reserved) {
        // the gateway was down, which says nothing against the caller
        refund();
      }
      throw failure;
    }
  };

  return async (authorization) => {
    const match = BEARER.exec(authorization ?? "");
    if (!match) throw new InspectorError("forbidden", "需要 Authorization: Bearer <网关密钥>", 401);
    const key = match[1] as string;
    const hash = createHash("sha256").update(key).digest("hex");
    const hit = cache.get(hash);
    if (hit && hit.until > now()) {
      if (hit.caller) return hit.caller;
      throw hit.error as InspectorError;
    }
    const pending = inflight.get(hash);
    if (pending) return pending;
    const task = lookup(hash, key).finally(() => inflight.delete(hash));
    inflight.set(hash, task);
    return task;
  };
}
