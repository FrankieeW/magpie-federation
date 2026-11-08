// Taking a port when another copy of this plugin may hold it: the app's
// plugin host and the host a `magpie plugin` command starts both load the
// plugin, and a restarting host overlaps the one it replaces for a moment.
// The port is retried for a short while. When a copy of this same build
// holds it, this one stands by and takes the port the moment that copy lets
// go — so the port never ends up served by nobody. Anything else holding
// the port is an error.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const PLUGIN_NAME = "magpie-route-inspector";
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
let cachedBuild = "";

export function version(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "0";
  } catch {
    return "0";
  }
}

function filesUnder(dir: string): string[] {
  try {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? filesUnder(path) : [path];
    });
  } catch {
    return [];
  }
}

/** A hash of every runtime file, so a rebuilt same-version copy is told apart. */
export function buildId(): string {
  if (cachedBuild) return cachedBuild;
  const hash = createHash("sha256");
  const files = ["src", "public", "page"].flatMap((dir) => filesUnder(join(ROOT, dir))).concat(join(ROOT, "package.json"), join(ROOT, "index.ts")).sort();
  for (const file of files) {
    try {
      hash.update(relative(ROOT, file)).update("\0").update(readFileSync(file));
    } catch {
      // a file that went away changes the hash all the same
    }
  }
  cachedBuild = hash.digest("hex").slice(0, 16);
  return cachedBuild;
}

interface Health {
  readonly name: string;
  readonly version: string;
  readonly build: string;
}

export async function probe(url: string): Promise<Health | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1200) });
    if (!response.ok) return null;
    const body = (await response.json()) as Partial<Health>;
    return body?.name === PLUGIN_NAME ? { name: body.name, version: String(body.version ?? ""), build: String(body.build ?? "") } : null;
  } catch {
    return null;
  }
}

export function health(): Health & { ok: true } {
  return { ok: true, name: PLUGIN_NAME, version: version(), build: buildId() };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Stoppable {
  stop(force?: boolean): void;
}

export interface Listening<T> {
  /** The bound server, or null while standing by for this build's other copy. */
  readonly server: T | null;
  readonly standby: boolean;
  stop(): void;
}

export interface ListenOptions {
  readonly attempts?: number;
  readonly delayMs?: number;
  readonly standbyMs?: number;
}

export async function listen<T extends Stoppable>(
  bind: () => T,
  port: number,
  probeUrl: string,
  onLate: (server: T) => void,
  options: ListenOptions = {},
): Promise<Listening<T>> {
  const attempts = options.attempts ?? 16;
  const delayMs = options.delayMs ?? 100;
  const standbyMs = options.standbyMs ?? 1000;
  const bound = (server: T): Listening<T> => ({ server, standby: false, stop: () => server.stop(true) });
  if (port === 0) return bound(bind());
  const isThisBuild = (h: Health | null) => h !== null && h.version === version() && h.build === buildId();

  const standby = (): Listening<T> => {
    let late: T | null = null;
    const timer = setInterval(() => {
      try {
        late = bind();
      } catch {
        return; // still held
      }
      clearInterval(timer);
      onLate(late);
    }, standbyMs);
    return {
      server: null,
      standby: true,
      stop() {
        clearInterval(timer);
        late?.stop(true);
      },
    };
  };

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return bound(bind());
    } catch (error) {
      if ((error as { code?: string })?.code !== "EADDRINUSE") throw error;
      if (isThisBuild(await probe(probeUrl))) return standby();
      await sleep(delayMs);
    }
  }
  const running = await probe(probeUrl);
  if (isThisBuild(running)) return standby();
  throw new Error(running ? `端口 ${port} 被本插件的另一个版本占用（${running.version}）` : `端口 ${port} 已被其他程序占用`);
}
