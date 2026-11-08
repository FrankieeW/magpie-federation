// Where this machine's Magpie keeps things, as the plugin host's environment
// says: the same XDG directories and gateway address Magpie itself uses.

import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { Env } from "./cli.ts";

const absolute = (value: string | undefined) => (value && isAbsolute(value) ? value : undefined);

export function providersPath(env: Env): string {
  const base = absolute(env.XDG_CONFIG_HOME) ?? join(env.HOME || homedir(), ".config");
  return join(base, "magpie", "providers.json");
}

export function stateDir(env: Env): string {
  const base = absolute(env.XDG_STATE_HOME) ?? join(env.HOME || homedir(), ".local", "state");
  return join(base, "magpie-route-inspector");
}

/**
 * This machine's gateway, from MAGPIE_ADDR as the plugin host gives it. One
 * listening on every interface is reached on loopback, so the gateway sees
 * the plugin as this computer's own caller.
 */
export function gatewayBase(env: Env): string {
  const addr = (env.MAGPIE_ADDR ?? "").trim();
  const match = /^(?:\[([^\]]+)\]|([^:]*)):(\d{1,5})$/.exec(addr);
  if (!match) return "http://127.0.0.1:3425";
  const host = match[1] ?? match[2] ?? "";
  const port = Number(match[3]);
  if (port < 1 || port > 65535) return "http://127.0.0.1:3425";
  const wildcard = host === "" || host === "0.0.0.0" || host === "::";
  if (wildcard) return `http://127.0.0.1:${port}`;
  return host.includes(":") ? `http://[${host}]:${port}` : `http://${host}:${port}`;
}
