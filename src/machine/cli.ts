// Runs this machine's `magpie` CLI with an argument list — never a shell —
// under a time limit and an output cap, in the plugin host's own environment
// so it acts on the same Magpie (XDG_CONFIG_HOME, MAGPIE_ADDR) that runs it.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export type Env = Readonly<Record<string, string | undefined>>;

export interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type MagpieRunner = (args: readonly string[]) => Promise<CliResult>;

const MAX_OUTPUT = 64 * 1024;

/** Where the magpie executable is: MAGPIE_BIN, PATH, then the usual installs. */
export function locateMagpie(env: Env, explicit?: string): string | null {
  const given = explicit ?? env.MAGPIE_BIN;
  if (given) return isAbsolute(given) && existsSync(given) ? given : null;
  const onPath = Bun.which("magpie", { PATH: env.PATH ?? "" });
  if (onPath) return onPath;
  const home = env.HOME || homedir();
  const known = [
    "/Applications/magpie.app/Contents/MacOS/magpie",
    join(home, "Applications/magpie.app/Contents/MacOS/magpie"),
    join(home, ".local/bin/magpie"),
    "/usr/local/bin/magpie",
    "/opt/homebrew/bin/magpie",
    "/usr/bin/magpie",
  ];
  return known.find((path) => existsSync(path)) ?? null;
}

async function capped(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (text.length < MAX_OUTPUT) text += decoder.decode(value, { stream: true });
  }
  return text.slice(0, MAX_OUTPUT);
}

export function cliRunner(bin: string, env: Env, timeoutMs = 30_000): MagpieRunner {
  return async (args) => {
    const child = Bun.spawn([bin, ...args], {
      env: { ...env } as Record<string, string>,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    try {
      const [stdout, stderr, code] = await Promise.all([capped(child.stdout), capped(child.stderr), child.exited]);
      return { code: child.signalCode ? 124 : code, stdout, stderr: child.signalCode ? `${stderr}\nmagpie 命令超时` : stderr };
    } finally {
      clearTimeout(timer);
    }
  };
}
