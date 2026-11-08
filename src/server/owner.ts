// Whether a loopback connection to the console comes from a process of the
// user running it. Another account on the same computer reaches 127.0.0.1
// too, and could read the page's token from GET /; it is refused before
// anything is served. Linux tells each socket's owner in /proc/net/tcp; on
// macOS, lsof run as this user sees this user's processes alone, so a client
// end it can find is this user's. Elsewhere there is no cheap way to tell.

import { readFile } from "node:fs/promises";

export type SameUser = (clientPort: number, serverPort: number) => Promise<boolean>;

const port = (address: string | undefined) => Number.parseInt(address?.split(":").pop() ?? "", 16);

/**
 * The owner verdict from a /proc/net/tcp(6) table for the client end of the
 * connection (local = clientPort, remote = serverPort), or null when the
 * table has no such socket.
 */
export function ownerFromProcNet(table: string, uid: number, clientPort: number, serverPort: number): boolean | null {
  for (const line of table.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 8) continue;
    if (port(fields[1]) === clientPort && port(fields[2]) === serverPort) return Number(fields[7]) === uid;
  }
  return null;
}

/** Whether `lsof -F n` output, run as this user, shows the client end of the connection. */
export function ownerFromLsof(output: string, clientPort: number, serverPort: number): boolean {
  const loop = String.raw`(?:127\.\d+\.\d+\.\d+|\[::1\]|localhost)`;
  return new RegExp(`^n${loop}:${clientPort}->${loop}:${serverPort}$`, "m").test(output);
}

function linux(): SameUser | null {
  const uid = process.getuid?.();
  if (uid === undefined) return null;
  return async (clientPort, serverPort) => {
    for (const path of ["/proc/net/tcp", "/proc/net/tcp6"]) {
      const verdict = ownerFromProcNet(await readFile(path, "utf8").catch(() => ""), uid, clientPort, serverPort);
      if (verdict !== null) return verdict;
    }
    return false;
  };
}

function darwin(): SameUser {
  return async (clientPort, serverPort) => {
    const run = Bun.spawn(["/usr/sbin/lsof", "-nP", `-iTCP:${clientPort}`, "-sTCP:ESTABLISHED", "-F", "n"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => run.kill(), 3000);
    try {
      const output = await new Response(run.stdout).text();
      await run.exited;
      return ownerFromLsof(output, clientPort, serverPort);
    } finally {
      clearTimeout(timer);
    }
  };
}

/** This platform's check, or null where none can be made. */
export function sameUserCheck(platform: string = process.platform): SameUser | null {
  if (platform === "linux") return linux();
  if (platform === "darwin") return darwin();
  return null;
}

/** A check that remembers each client port's verdict briefly: a browser reuses its connections. */
export function cachedSameUser(check: SameUser, ttlMs = 30_000): SameUser {
  let verdicts = new Map<string, { ok: boolean; until: number }>();
  return async (clientPort, serverPort) => {
    const key = `${clientPort}>${serverPort}`;
    const hit = verdicts.get(key);
    if (hit && hit.until > Date.now()) return hit.ok;
    const ok = await check(clientPort, serverPort).catch(() => false);
    const next = new Map([...verdicts].filter(([, v]) => v.until > Date.now()).slice(-511));
    next.set(key, { ok, until: Date.now() + ttlMs });
    verdicts = next;
    return ok;
  };
}
