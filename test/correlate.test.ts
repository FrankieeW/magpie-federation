import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { correlate, costRollup, type HopRef } from "../src/server/correlate.ts";
import { parseTrace } from "../src/server/local-trace.ts";
import { fileRouteJournal } from "../src/server/routes-journal.ts";
import type { Route, Usage } from "../src/shared/observation.ts";

const hop = (changes: Partial<HopRef> & Pick<HopRef, "routeId">): HopRef => ({
  time: "2026-01-01T00:00:00.000Z",
  ms: 1000,
  provider: "vps",
  model: "vps/group/pool",
  tries: [{ id: "vps", model: "provider/model" }],
  ...changes,
});

const remote = { remoteId: "vps", time: "2026-01-01T00:00:00.200Z", asked: "provider/model", responseId: "resp-1" };

describe("correlate", () => {
  test("matches the only hop with the same response id", () => {
    const link = correlate(remote, [
      hop({ routeId: 4, responseId: "resp-1" }),
      hop({ routeId: 5, responseId: "other", provider: "local", model: "local/model", tries: [{ id: "local", model: "local/model" }] }),
    ]);
    expect(link).toEqual({ state: "matched", by: "response-id", localRouteId: 4, note: "与本机路由 4 的响应 ID 相同。" });
  });

  test("does not pick when two hops share the response id", () => {
    const link = correlate(remote, [hop({ routeId: 4, responseId: "resp-1" }), hop({ routeId: 6, responseId: "resp-1" })]);
    expect(link.state).toBe("ambiguous");
  });

  test("matches by time and model only when nothing else fits", () => {
    const link = correlate({ ...remote, responseId: undefined }, [
      hop({ routeId: 4 }),
      hop({ routeId: 7, time: "2026-01-01T01:00:00.000Z" }),
    ]);
    expect(link).toMatchObject({ state: "matched", by: "time-and-model", localRouteId: 4 });
  });

  test("rejects a hop whose response id is a different call", () => {
    const link = correlate(remote, [hop({ routeId: 4, responseId: "other" })]);
    expect(link.state).toBe("unmatched");
  });

  test("says when the session never went to that remote", () => {
    const link = correlate(remote, [hop({ routeId: 4, provider: "other", model: "other/model", tries: [{ id: "other", model: "other/model" }] })]);
    expect(link.note).toContain("没有发往「vps」");
  });

  test("withholds a total until the call is matched and priced", () => {
    const usage: Usage = { state: "ready", rows: [{ time: "t", provider: "p", model: "m", status: 200, cost: { state: "estimated", usd: 0.5, source: "Magpie usage" }, routeId: 1 }] };
    expect(costRollup({ state: "unmatched", note: "" }, usage).state).toBe("withheld");
    expect(costRollup({ state: "matched", note: "" }, usage)).toMatchObject({ state: "deduped", usd: 0.5 });
    const mixed: Usage = { state: "ready", rows: [...usage.rows, { ...usage.rows[0]!, cost: { state: "unknown" } }] };
    expect(costRollup({ state: "matched", note: "" }, mixed)).toMatchObject({ state: "partial", usd: 0.5 });
  });
});

describe("local trace", () => {
  test("keeps session hops and drops prompt text", () => {
    const { hops, sessions } = parseTrace({
      routes: [
        { id: 2, time: "2026-01-01T00:00:02.000Z", session: "s", agent: "dsh", provider: "vps", model: "vps/m", responseId: "r", tries: [{ id: "vps", model: "m" }], prompt: "secret prompt" },
        { id: 1, time: "2026-01-01T00:00:01.000Z", session: "s", provider: "vps", model: "old", tries: [{ id: "vps", model: "old" }] },
        { id: 3, time: "2026-01-01T00:00:03.000Z", provider: "vps", model: "no-session", tries: [] },
      ],
    });
    expect(hops.map((item) => item.routeId)).toEqual([2, 1, 3]);
    expect(JSON.stringify(hops)).not.toContain("secret prompt");
    expect(sessions).toEqual([{ id: "s", agent: "dsh", time: "2026-01-01T00:00:02.000Z", model: "vps/m", provider: "vps", routeId: 2 }]);
  });
});

describe("route journal", () => {
  test("replaces the same route and lists older ones newest first", async () => {
    const directory = await mkdtemp(join(tmpdir(), "route-journal-"));
    try {
      const journal = fileRouteJournal(join(directory, "routes.jsonl"));
      const route = (id: number, asked: string): Route => ({ id, time: `2026-01-01T00:00:0${id}.000Z`, asked, done: true, tries: [] });
      await journal.record("vps", "s", route(1, "first"));
      await journal.record("vps", "s", route(2, "second"));
      await journal.record("vps", "s", route(1, "first-again"));
      expect((await journal.earlier("vps", "s", 2)).map((item) => item.asked)).toEqual(["first-again"]);
      const reopened = fileRouteJournal(join(directory, "routes.jsonl"));
      expect((await reopened.earlier("vps", "s", null)).map((item) => item.id)).toEqual([2, 1]);
      expect((await stat(join(directory, "routes.jsonl"))).mode & 0o777).toBe(0o600);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
