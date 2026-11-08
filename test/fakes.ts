// Test doubles for the machine layer: a Magpie whose providers.json lives in
// memory and whose CLI understands `group set <id> models…`.

import type { Pool } from "../src/shared/api.ts";
import type { CliResult } from "../src/machine/cli.ts";

export interface FakeMagpie {
  groups: Pool[];
  readonly calls: string[][];
  readGroups(): Promise<Pool[]>;
  run(args: readonly string[]): Promise<CliResult>;
  /** Makes the next CLI call fail as Magpie would refuse it. */
  failNext(message: string): void;
  /** Changes a pool behind the service's back, as another editor would. */
  editBehind(pool: string, members: string[]): void;
}

export function fakeMagpie(initial: Pool[]): FakeMagpie {
  let pending: string | null = null;
  const state = {
    groups: initial.map((pool) => ({ ...pool, members: [...pool.members] })),
    calls: [] as string[][],
  };
  const replace = (id: string, members: string[]) => {
    state.groups = state.groups.map((pool) => (pool.id === id ? { ...pool, members } : pool));
  };
  return {
    get groups() {
      return state.groups;
    },
    set groups(value) {
      state.groups = value;
    },
    calls: state.calls,
    async readGroups() {
      return state.groups.map((pool) => ({ ...pool, members: [...pool.members] }));
    },
    async run(args) {
      state.calls.push([...args]);
      if (pending !== null) {
        const message = pending;
        pending = null;
        return { code: 1, stdout: "", stderr: `magpie: ${message}\n` };
      }
      const [verb, sub, id, assignment] = args;
      const pool = state.groups.find((item) => item.id === id);
      if (verb !== "group" || sub !== "set" || !pool || assignment === undefined) {
        return { code: 1, stdout: "", stderr: "magpie: unexpected command\n" };
      }
      if (assignment.startsWith("models+=")) replace(pool.id, [...pool.members, ...assignment.slice(8).split(",")]);
      else if (assignment.startsWith("models-=")) {
        const drop = new Set(assignment.slice(8).split(","));
        replace(pool.id, pool.members.filter((member) => !drop.has(member)));
      } else if (assignment.startsWith("models=")) replace(pool.id, assignment.slice(7).split(","));
      else return { code: 1, stdout: "", stderr: "magpie: unknown setting\n" };
      return { code: 0, stdout: "  models updated\n", stderr: "" };
    },
    failNext(message) {
      pending = message;
    },
    editBehind(id, members) {
      replace(id, members);
    },
  };
}

/** A `/v1/models` list in the shape Magpie answers it. */
export function modelList(ids: readonly string[]): unknown[] {
  return ids.map((id) => ({ id, display_name: id.split("/").pop(), magpie_label: id }));
}
