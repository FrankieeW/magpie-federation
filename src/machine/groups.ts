// The user's routing groups, read from providers.json — the file Magpie
// documents as their home. Only the groups are kept; the providers beside
// them, keys included, are dropped as soon as the file is parsed. Writes
// never come here: they go through `magpie group set` (cli.ts), so Magpie's
// own lock and checks apply.

import { readFile, stat } from "node:fs/promises";
import type { Pool } from "../shared/api.ts";
import { isPoolId } from "../shared/members.ts";
import { InspectorError, isObject } from "../server/errors.ts";

const MAX_FILE = 16 * 1024 * 1024;

function poolFrom(value: unknown): Pool | null {
  if (!isObject(value) || typeof value.id !== "string" || !isPoolId(value.id) || value.hidden === true) return null;
  if (!Array.isArray(value.members) || !value.members.every((member) => typeof member === "string")) return null;
  const clean = (text: unknown, max: number) => (typeof text === "string" ? text.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max) : "");
  const name = clean(value.name, 120) || value.id;
  const routing = clean(value.routing, 64) || "smart";
  return { id: value.id, name, routing, members: [...(value.members as string[])] };
}

/** The visible user pools in a parsed providers.json. */
export function groupsFrom(value: unknown): Pool[] {
  if (!isObject(value)) throw new InspectorError("incompatible", "providers.json 的格式无法识别", 502);
  if (value.groups === undefined) return [];
  if (!Array.isArray(value.groups)) throw new InspectorError("incompatible", "providers.json 中的 groups 不是列表", 502);
  return value.groups.map(poolFrom).filter((pool): pool is Pool => pool !== null);
}

export async function readGroups(path: string): Promise<Pool[]> {
  try {
    const info = await stat(path);
    if (info.size > MAX_FILE) throw new InspectorError("incompatible", "providers.json 超过 16 MiB", 502);
    return groupsFrom(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (error instanceof InspectorError) throw error;
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw new InspectorError("error", "无法读取本机 Magpie 的池子配置", 500);
  }
}
