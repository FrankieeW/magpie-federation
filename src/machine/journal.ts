// The changes this plugin made to the machine's pools, newest last, so each
// can be shown and undone. Kept as JSON lines, readable by the user alone,
// trimmed to the most recent entries.

import { appendFile, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ChangeRecord, PoolOp } from "../shared/api.ts";
import { isObject } from "../server/errors.ts";

export interface Journal {
  list(): Promise<readonly ChangeRecord[]>;
  append(record: ChangeRecord): Promise<void>;
}

const KEEP = 200;

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function opFrom(value: unknown): PoolOp | null {
  if (!isObject(value) || typeof value.member !== "string") return null;
  if (value.type === "remove") return { type: "remove", member: value.member };
  if (value.type === "move" && Number.isSafeInteger(value.to)) return { type: "move", member: value.member, to: value.to as number };
  if (value.type === "add") {
    return Number.isSafeInteger(value.index)
      ? { type: "add", member: value.member, index: value.index as number }
      : { type: "add", member: value.member };
  }
  return null;
}

function recordFrom(line: string): ChangeRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isObject(value) || typeof value.id !== "string" || typeof value.at !== "string" || typeof value.pool !== "string") return null;
  const op = opFrom(value.op);
  if (!op || !strings(value.before) || !strings(value.after) || typeof value.by !== "string") return null;
  const base = { id: value.id, at: value.at, pool: value.pool, op, before: value.before, after: value.after, by: value.by };
  return typeof value.undoOf === "string" ? { ...base, undoOf: value.undoOf } : base;
}

export function memoryJournal(): Journal {
  let records: readonly ChangeRecord[] = [];
  return {
    async list() {
      return records;
    },
    async append(record) {
      records = [...records, record].slice(-KEEP);
    },
  };
}

export function fileJournal(path: string): Journal {
  const read = async (): Promise<ChangeRecord[]> => {
    try {
      const text = await readFile(path, "utf8");
      return text.split("\n").filter(Boolean).map(recordFrom).filter((r): r is ChangeRecord => r !== null);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
      throw error;
    }
  };
  return {
    async list() {
      return (await read()).slice(-KEEP);
    },
    async append(record) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const existing = await read();
      if (existing.length >= KEEP * 2) {
        const kept = [...existing.slice(-(KEEP - 1)), record];
        await writeFile(path, kept.map((r) => JSON.stringify(r)).join("\n") + "\n", { mode: 0o600 });
      } else {
        await appendFile(path, JSON.stringify(record) + "\n", { mode: 0o600 });
      }
      await chmod(path, 0o600);
    },
  };
}
