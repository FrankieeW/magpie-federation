// One machine's pools: what they are, what could join them, and changes to
// them — previewed first, applied through Magpie's own CLI one at a time,
// checked against what Magpie wrote, and journaled so each can be undone.

import type { Candidate, ChangeRecord, Pool, PoolOp } from "../shared/api.ts";
import { MemberError, applyOp, candidatesFrom, commandFor, inverseOp } from "../shared/members.ts";
import { InspectorError, firstLine } from "../server/errors.ts";
import type { MagpieRunner } from "./cli.ts";
import type { Journal } from "./journal.ts";

export interface PoolDeps {
  readonly readGroups: () => Promise<Pool[]>;
  readonly listModels: () => Promise<readonly unknown[]>;
  readonly run: MagpieRunner;
  readonly journal: Journal;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

export interface Snapshot {
  readonly pools: readonly Pool[];
  readonly candidates: readonly Candidate[];
  readonly changes: readonly ChangeRecord[];
}

export interface PlannedChange {
  readonly pool: string;
  readonly op: PoolOp;
  readonly before: readonly string[];
  readonly after: readonly string[];
  readonly command: readonly string[];
}

export interface Applied {
  readonly change: ChangeRecord;
  /** Whether Magpie's pool now is exactly what the preview (or, for an undo, the earlier state) said. */
  readonly matched: boolean;
  /** Set when the change was made but something after it failed. */
  readonly warning?: string;
}

interface WriteOptions {
  readonly undoOf?: string;
  /** For an undo: the members the pool should be back to. */
  readonly target?: readonly string[];
  readonly trusted?: boolean;
}

export interface PoolService {
  snapshot(): Promise<Snapshot>;
  preview(pool: string, op: PoolOp): Promise<PlannedChange>;
  apply(pool: string, op: PoolOp, expected: readonly string[], by: string): Promise<Applied>;
  undo(changeId: string, by: string): Promise<Applied>;
}

const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((item, i) => item === b[i]);

function asRequestError(error: unknown): never {
  if (error instanceof MemberError) throw new InspectorError("error", error.message, 400);
  throw error;
}

export function poolService(deps: PoolDeps): PoolService {
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? (() => crypto.randomUUID());
  let queue: Promise<unknown> = Promise.resolve();

  // Changes wait their turn: each one plans against what the last one left.
  const exclusive = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  };

  const findPool = async (id: string): Promise<Pool> => {
    const pool = (await deps.readGroups()).find((item) => item.id === id);
    if (!pool) throw new InspectorError("error", `没有找到池子 ${id}`, 404);
    return pool;
  };

  const planFrom = async (poolId: string, before: readonly string[], op: PoolOp, trusted = false): Promise<PlannedChange> => {
    let after: string[];
    try {
      after = applyOp(poolId, before, op, { trusted });
    } catch (error) {
      asRequestError(error);
    }
    if (op.type === "add" && !trusted) {
      const offered = candidatesFrom(await deps.listModels());
      if (!offered.some((candidate) => candidate.id === op.member)) {
        throw new InspectorError("error", `这台机器的 Magpie 不提供 ${op.member}：它可能不存在，或会绕回这台机器形成循环`, 400);
      }
    }
    let command: string[];
    try {
      command = commandFor(poolId, op, before, after);
    } catch (error) {
      asRequestError(error);
    }
    return { pool: poolId, op, before: [...before], after, command };
  };

  const plan = async (poolId: string, op: PoolOp): Promise<PlannedChange> =>
    planFrom(poolId, (await findPool(poolId)).members, op);

  const write = async (poolId: string, op: PoolOp, expected: readonly string[], by: string, options: WriteOptions = {}): Promise<Applied> => {
    const conflict = () => new InspectorError("conflict", "池子在预览之后被改过，请刷新后再试", 409);
    // A pool that moved on since the reader saw it is a conflict, whatever
    // the change would make of it now.
    const current = (await findPool(poolId)).members;
    if (!same(current, expected)) throw conflict();
    const planned = await planFrom(poolId, current, op, options.trusted);
    // Planning may have asked the gateway; look once more right before the
    // write, so the window another editor could slip into is the CLI's own.
    if (!same((await findPool(poolId)).members, expected)) throw conflict();
    const result = await deps.run(planned.command);
    if (result.code !== 0) {
      const why = firstLine(result.stderr || result.stdout) || `退出码 ${result.code}`;
      throw new InspectorError("error", `Magpie 拒绝了这次修改：${why}`, 422);
    }
    const actual = [...(await findPool(poolId)).members];
    const base = { id: newId(), at: now().toISOString(), pool: poolId, op, before: planned.before, after: actual, by };
    const change: ChangeRecord = options.undoOf ? { ...base, undoOf: options.undoOf } : base;
    const matched = same(actual, options.target ?? planned.after);
    try {
      await deps.journal.append(change);
    } catch {
      return { change, matched, warning: "池子已修改，但变更日志写入失败，这次修改无法从这里撤销" };
    }
    return { change, matched };
  };

  return {
    async snapshot() {
      const [pools, models, changes] = await Promise.all([deps.readGroups(), deps.listModels(), deps.journal.list()]);
      return { pools, candidates: candidatesFrom(models), changes };
    },
    preview: (poolId, op) => plan(poolId, op),
    apply: (poolId, op, expected, by) => exclusive(() => write(poolId, op, expected, by)),
    undo: (changeId, by) =>
      exclusive(async () => {
        const record = (await deps.journal.list()).find((item) => item.id === changeId);
        if (!record) throw new InspectorError("error", "没有找到这次变更", 404);
        // The member comes back from the journal, which recorded what Magpie
        // held: it is restored as it was, offered now or not.
        return write(record.pool, inverseOp(record.op, record.before), record.after, by, { undoOf: record.id, target: record.before, trusted: true });
      }),
  };
}
