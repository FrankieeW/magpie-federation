import { describe, expect, test } from "bun:test";
import {
  MemberError,
  applyOp,
  candidatesFrom,
  commandFor,
  inverseOp,
  isPoolId,
  validateMember,
} from "../src/shared/members.ts";

describe("validateMember", () => {
  test("accepts ids as Magpie lists them", () => {
    for (const id of ["upa/a1", "group/pool-a", "nb/group/pool-b", "office/openrouter/anthropic/claude-opus-5.5", "p/qwen3-coder:480b", "p/m:high:fast", "p/gpt-5.5:free"]) {
      expect(validateMember(id)).toBe(id);
    }
  });

  test("refuses patterns, lists, assignments and odd characters", () => {
    for (const id of ["", "a1", "p/*", "re:p/.*", "p/a,p/b", "p/a=b", "p/ a", "p/a\n", "../p/a", "p//a", "/p/a", "p/a/", "-x/a", `p/${"x".repeat(600)}`]) {
      expect(() => validateMember(id)).toThrow(MemberError);
    }
  });
});

describe("isPoolId", () => {
  test("accepts Magpie group ids only", () => {
    expect(isPoolId("pool-b")).toBe(true);
    expect(isPoolId("auto-gpt-5.5")).toBe(true);
    for (const id of ["", "group/x", "x y", "-x", "a".repeat(200)]) expect(isPoolId(id)).toBe(false);
  });
});

describe("applyOp", () => {
  const before = ["upa/a1", "upa/a2"];

  test("adds at the end or at an index, never twice, never the pool itself", () => {
    expect(applyOp("pool-a", before, { type: "add", member: "nb/group/pool-b" })).toEqual(["upa/a1", "upa/a2", "nb/group/pool-b"]);
    expect(applyOp("pool-a", before, { type: "add", member: "nb/upb/b1", index: 0 })).toEqual(["nb/upb/b1", "upa/a1", "upa/a2"]);
    expect(() => applyOp("pool-a", before, { type: "add", member: "upa/a1" })).toThrow("已在池子中");
    expect(() => applyOp("pool-a", before, { type: "add", member: "group/pool-a" })).toThrow("不能把池子放进它自己");
    expect(() => applyOp("pool-a", before, { type: "add", member: "upa/a3", index: 5 })).toThrow(MemberError);
  });

  test("removes and moves only existing members", () => {
    expect(applyOp("pool-a", before, { type: "remove", member: "upa/a1" })).toEqual(["upa/a2"]);
    expect(() => applyOp("pool-a", before, { type: "remove", member: "upa/zz" })).toThrow("不在池子中");
    expect(applyOp("pool-a", before, { type: "move", member: "upa/a2", to: 0 })).toEqual(["upa/a2", "upa/a1"]);
    expect(() => applyOp("pool-a", before, { type: "move", member: "upa/a1", to: 0 })).toThrow("位置没有变化");
    expect(() => applyOp("pool-a", before, { type: "move", member: "upa/a1", to: 9 })).toThrow(MemberError);
  });

  test("never mutates the list it was given", () => {
    const frozen = Object.freeze([...before]);
    applyOp("pool-a", frozen, { type: "add", member: "upa/a3" });
    applyOp("pool-a", frozen, { type: "move", member: "upa/a2", to: 0 });
    expect(frozen).toEqual(before);
  });

  test("keeps existing patterns untouched while editing around them", () => {
    const withPattern = ["openrouter/*:free", "upa/a1"];
    expect(applyOp("pool-a", withPattern, { type: "add", member: "upa/a2" })).toEqual(["openrouter/*:free", "upa/a1", "upa/a2"]);
  });
});

describe("inverseOp", () => {
  test("undoes add, remove and move", () => {
    const before = ["upa/a1", "upa/a2", "nb/upb/b1"];
    for (const op of [
      { type: "add", member: "nb/group/pool-b" },
      { type: "add", member: "nb/group/pool-b", index: 1 },
      { type: "remove", member: "upa/a2" },
      { type: "move", member: "nb/upb/b1", to: 0 },
    ] as const) {
      const after = applyOp("pool-a", before, op);
      expect(applyOp("pool-a", after, inverseOp(op, before))).toEqual(before);
    }
  });
});

describe("commandFor", () => {
  test("appends and drops one member without rewriting the others", () => {
    expect(commandFor("pool-a", { type: "add", member: "nb/group/pool-b" }, ["upa/a1"], ["upa/a1", "nb/group/pool-b"]))
      .toEqual(["group", "set", "pool-a", "models+=nb/group/pool-b"]);
    expect(commandFor("pool-a", { type: "remove", member: "upa/a1" }, ["upa/a1", "upa/a2"], ["upa/a2"]))
      .toEqual(["group", "set", "pool-a", "models-=upa/a1"]);
  });

  test("rewrites the whole list to reorder, unless a member holds a comma", () => {
    expect(commandFor("pool-a", { type: "move", member: "upa/a2", to: 0 }, ["upa/a1", "upa/a2"], ["upa/a2", "upa/a1"]))
      .toEqual(["group", "set", "pool-a", "models=upa/a2,upa/a1"]);
    const tricky = ["re:p/a{1,3}", "upa/a1"];
    expect(() => commandFor("pool-a", { type: "move", member: "upa/a1", to: 0 }, tricky, ["upa/a1", "re:p/a{1,3}"]))
      .toThrow("含逗号");
  });
});

describe("candidatesFrom", () => {
  test("classifies a machine's model list into local and remote models and pools", () => {
    const list = [
      { id: "group/pool-a", display_name: "Pool A", magpie_label: "Pool A · routing group" },
      { id: "upa/a1", display_name: "a1", magpie_label: "a1 · Up A" },
      { id: "nb/group/pool-b", display_name: "Pool B", magpie_label: "Pool B · routing group · Remote magpie" },
      { id: "nb/upb/b1", display_name: "b1", magpie_label: "b1 · Up B · Remote magpie" },
      { id: "openrouter/anthropic/claude", display_name: "claude", magpie_label: "claude · OpenRouter" },
      { id: "bad id with spaces" },
      "not an object",
    ];
    const out = candidatesFrom(list);
    expect(out.map((c) => [c.id, c.kind, c.via])).toEqual([
      ["group/pool-a", "pool", undefined],
      ["upa/a1", "model", undefined],
      ["nb/group/pool-b", "remote-pool", "nb"],
      ["nb/upb/b1", "remote-model", "nb"],
      ["openrouter/anthropic/claude", "model", undefined],
    ]);
    expect(out[2]?.label).toBe("Pool B · routing group · Remote magpie");
  });
});
