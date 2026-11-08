// Routes this plugin has actually seen, newest kept, so a later request in
// the same session does not erase the one before it. The remote API only
// returns a session's latest route. What was never observed is not invented.

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Route } from "../shared/observation.ts";
import { isObject } from "./errors.ts";

export interface RouteJournal {
  record(remote: string, session: string, route: Route): Promise<void>;
  /** The session's recorded routes except `currentId`, newest first. */
  earlier(remote: string, session: string, currentId: number | null, limit?: number): Promise<Route[]>;
}

interface Stored {
  readonly remote: string;
  readonly session: string;
  readonly at: string;
  readonly route: Route;
}

const KEEP = 500;

function routeOf(value: unknown): Route | null {
  if (!isObject(value) || !Number.isSafeInteger(value.id) || (value.id as number) <= 0) return null;
  if (typeof value.time !== "string" || typeof value.asked !== "string" || typeof value.done !== "boolean" || !Array.isArray(value.tries)) return null;
  return value as unknown as Route;
}

function storedOf(value: unknown): Stored | null {
  if (!isObject(value) || typeof value.remote !== "string" || typeof value.session !== "string" || typeof value.at !== "string") return null;
  const route = routeOf(value.route);
  return route ? { remote: value.remote, session: value.session, at: value.at, route } : null;
}

function remember(records: readonly Stored[], next: Stored): Stored[] {
  const key = `${next.remote}\0${next.route.id}`;
  return [...records.filter((record) => `${record.remote}\0${record.route.id}` !== key), next].slice(-KEEP);
}

function stamp(route: Route): number {
  const parsed = Date.parse(route.time);
  return Number.isFinite(parsed) ? parsed : 0;
}

function listEarlier(records: readonly Stored[], remote: string, session: string, currentId: number | null, limit: number): Route[] {
  return records
    .filter((record) => record.remote === remote && record.session === session && record.route.id !== currentId)
    .sort((a, b) => stamp(b.route) - stamp(a.route) || b.route.id - a.route.id)
    .slice(0, limit)
    .map((record) => record.route);
}

export function memoryRouteJournal(): RouteJournal {
  let records: readonly Stored[] = [];
  return {
    async record(remote, session, route) {
      records = remember(records, { remote, session, at: new Date().toISOString(), route });
    },
    async earlier(remote, session, currentId, limit = 40) {
      return listEarlier(records, remote, session, currentId, limit);
    },
  };
}

export function fileRouteJournal(path: string): RouteJournal {
  let chain: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(run: () => Promise<T>): Promise<T> => {
    const next = chain.then(run, run);
    chain = next.then(() => undefined, () => undefined);
    return next;
  };
  const read = async (): Promise<Stored[]> => {
    try {
      const text = await readFile(path, "utf8");
      return text.split("\n").filter(Boolean).map((line) => {
        try {
          return storedOf(JSON.parse(line));
        } catch {
          return null;
        }
      }).filter((record): record is Stored => record !== null);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
      throw error;
    }
  };
  const write = async (records: readonly Stored[]): Promise<void> => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const body = records.length ? `${records.map((record) => JSON.stringify(record)).join("\n")}\n` : "";
    await writeFile(path, body, { mode: 0o600 });
    await chmod(path, 0o600);
  };
  return {
    record(remote, session, route) {
      return exclusive(async () => {
        await write(remember(await read(), { remote, session, at: new Date().toISOString(), route }));
      });
    },
    earlier(remote, session, currentId, limit = 40) {
      return exclusive(async () => listEarlier(await read(), remote, session, currentId, limit));
    },
  };
}
