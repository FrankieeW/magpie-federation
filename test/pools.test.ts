import { beforeEach, describe, expect, test } from "bun:test";
import { groupsFrom } from "../src/machine/groups.ts";
import { memoryJournal } from "../src/machine/journal.ts";
import { poolService, type PoolService } from "../src/machine/pools.ts";
import { InspectorError } from "../src/server/errors.ts";
import { fakeMagpie, modelList, type FakeMagpie } from "./fakes.ts";

const MODELS = modelList(["group/pool-a", "upa/a1", "upa/a2", "nb/group/pool-b", "nb/upb/b1"]);

let magpie: FakeMagpie;
let service: PoolService;

beforeEach(() => {
  magpie = fakeMagpie([{ id: "pool-a", name: "Pool A", routing: "order", members: ["upa/a1", "upa/a2"] }]);
  let n = 0;
  service = poolService({
    readGroups: () => magpie.readGroups(),
    listModels: async () => MODELS,
    run: (args) => magpie.run(args),
    journal: memoryJournal(),
    now: () => new Date("2026-11-08T10:00:00Z"),
    newId: () => `change-${++n}`,
  });
});

describe("groupsFrom", () => {
  test("keeps the user's pools and nothing else of providers.json", () => {
    const pools = groupsFrom({
      providers: [{ id: "upa", key: "sk-secret" }],
      groups: [
        { id: "pool-a", name: "Pool A", routing: "order", members: ["upa/a1"], rules: [{ use: "upa/a1" }] },
        { id: "gone", hidden: true },
        { id: "no-routing", members: ["upa/a2"] },
        { id: "bad id!", members: [] },
        { id: "bad-members", members: [1, 2] },
        "nonsense",
      ],
    });
    expect(pools).toEqual([
      { id: "pool-a", name: "Pool A", routing: "order", members: ["upa/a1"] },
      { id: "no-routing", name: "no-routing", routing: "smart", members: ["upa/a2"] },
    ]);
    expect(JSON.stringify(pools)).not.toContain("sk-secret");
  });

  test("answers no pools for a file without groups, and refuses one that isn't Magpie's", () => {
    expect(groupsFrom({ providers: [] })).toEqual([]);
    expect(() => groupsFrom([1, 2])).toThrow(InspectorError);
  });
});

describe("pool service", () => {
  test("snapshots pools, candidates and changes", async () => {
    const snap = await service.snapshot();
    expect(snap.pools.map((p) => p.id)).toEqual(["pool-a"]);
    expect(snap.candidates.find((c) => c.id === "nb/group/pool-b")?.kind).toBe("remote-pool");
    expect(snap.changes).toEqual([]);
  });

  test("previews a change with the command it will run, without running it", async () => {
    const preview = await service.preview("pool-a", { type: "add", member: "nb/group/pool-b" });
    expect(preview.before).toEqual(["upa/a1", "upa/a2"]);
    expect(preview.after).toEqual(["upa/a1", "upa/a2", "nb/group/pool-b"]);
    expect(preview.command).toEqual(["group", "set", "pool-a", "models+=nb/group/pool-b"]);
    expect(magpie.calls).toEqual([]);
  });

  test("applies through the CLI, verifies the result and journals it", async () => {
    const result = await service.apply("pool-a", { type: "add", member: "nb/group/pool-b" }, ["upa/a1", "upa/a2"], "local");
    expect(result.matched).toBe(true);
    expect(magpie.groups[0]?.members).toEqual(["upa/a1", "upa/a2", "nb/group/pool-b"]);
    expect(result.change).toMatchObject({ id: "change-1", pool: "pool-a", by: "local", after: ["upa/a1", "upa/a2", "nb/group/pool-b"] });
    expect((await service.snapshot()).changes.map((c) => c.id)).toEqual(["change-1"]);
  });

  test("refuses members the machine doesn't offer, so nothing unknown or looping is written", async () => {
    await expect(service.preview("pool-a", { type: "add", member: "la/group/pool-a" })).rejects.toThrow("不提供");
    expect(magpie.calls).toEqual([]);
  });

  test("refuses to apply over a pool someone changed since the preview", async () => {
    magpie.editBehind("pool-a", ["upa/a2"]);
    const attempt = service.apply("pool-a", { type: "add", member: "nb/upb/b1" }, ["upa/a1", "upa/a2"], "local");
    await expect(attempt).rejects.toMatchObject({ state: "conflict", status: 409 });
    expect(magpie.calls).toEqual([]);
  });

  test("reports Magpie's refusal and journals nothing", async () => {
    magpie.failNext("magpie knows no model \"nb/upb/b1\"");
    const attempt = service.apply("pool-a", { type: "add", member: "nb/upb/b1" }, ["upa/a1", "upa/a2"], "local");
    await expect(attempt).rejects.toThrow("knows no model");
    expect((await service.snapshot()).changes).toEqual([]);
  });

  test("undoes a change, and refuses an undo once the pool moved on", async () => {
    const { change } = await service.apply("pool-a", { type: "move", member: "upa/a2", to: 0 }, ["upa/a1", "upa/a2"], "local");
    const undone = await service.undo(change.id, "local");
    expect(magpie.groups[0]?.members).toEqual(["upa/a1", "upa/a2"]);
    expect(undone.change.undoOf).toBe(change.id);

    const again = await service.apply("pool-a", { type: "remove", member: "upa/a1" }, ["upa/a1", "upa/a2"], "local");
    magpie.editBehind("pool-a", ["upa/a2", "upa/a1"]);
    await expect(service.undo(again.change.id, "local")).rejects.toMatchObject({ state: "conflict" });
  });

  test("runs one change at a time", async () => {
    const first = service.apply("pool-a", { type: "add", member: "nb/upb/b1" }, ["upa/a1", "upa/a2"], "local");
    const second = service.apply("pool-a", { type: "add", member: "nb/group/pool-b" }, ["upa/a1", "upa/a2"], "local");
    await expect(first).resolves.toMatchObject({ matched: true });
    await expect(second).rejects.toMatchObject({ state: "conflict" });
  });

  test("undoes the removal of members Magpie holds but wouldn't offer now", async () => {
    magpie.editBehind("pool-a", ["openrouter/*:free", "gone/x", "upa/a1"]);
    const pattern = await service.apply("pool-a", { type: "remove", member: "openrouter/*:free" }, ["openrouter/*:free", "gone/x", "upa/a1"], "local");
    const undone = await service.undo(pattern.change.id, "local");
    expect(undone.matched).toBe(true);
    expect(magpie.groups[0]?.members).toEqual(["openrouter/*:free", "gone/x", "upa/a1"]);
    const offline = await service.apply("pool-a", { type: "remove", member: "gone/x" }, ["openrouter/*:free", "gone/x", "upa/a1"], "local");
    await service.undo(offline.change.id, "local");
    expect(magpie.groups[0]?.members).toEqual(["openrouter/*:free", "gone/x", "upa/a1"]);
  });

  test("reports a change it made even when the journal can't be written", async () => {
    const broken = poolService({
      readGroups: () => magpie.readGroups(),
      listModels: async () => MODELS,
      run: (args) => magpie.run(args),
      journal: { list: async () => [], append: async () => { throw new Error("disk full"); } },
    });
    const result = await broken.apply("pool-a", { type: "add", member: "nb/upb/b1" }, ["upa/a1", "upa/a2"], "local");
    expect(magpie.groups[0]?.members).toEqual(["upa/a1", "upa/a2", "nb/upb/b1"]);
    expect(result.matched).toBe(true);
    expect(result.warning).toContain("无法从这里撤销");
  });

  test("answers 404 for a pool that isn't there", async () => {
    await expect(service.preview("nope", { type: "remove", member: "upa/a1" })).rejects.toMatchObject({ status: 404 });
  });
});
