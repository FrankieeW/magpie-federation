import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { gatewayClient } from "../src/machine/gateway.ts";
import { memoryJournal } from "../src/machine/journal.ts";
import { poolService } from "../src/machine/pools.ts";
import { keyVerifier } from "../src/peer/auth.ts";
import { peerClient } from "../src/peer/client.ts";
import { startPeer, type RunningPeer } from "../src/peer/server.ts";
import { fakeMagpie, modelList, type FakeMagpie } from "./fakes.ts";

// Response bodies in tests are read loosely; the code under test validates them.
const json = (response: Response): Promise<any> => response.json() as Promise<any>;


const WRITER = "k-writer-0123456789";
const READER = "k-readonly-0123456789";
const LIMITED = "k-limited-0123456789";
const keys = new Map<string, { name: string; readOnly: boolean; limits: unknown[] }>([
  [WRITER, { name: "laptop", readOnly: false, limits: [] }],
  [READER, { name: "screen", readOnly: true, limits: [] }],
  [LIMITED, { name: "laptop-capped", readOnly: false, limits: [{ window: "week" }] }],
]);

let gateway: ReturnType<typeof Bun.serve>;
let peer: RunningPeer;
let magpie: FakeMagpie;
let meCalls = 0;
let clock = 0;

beforeAll(() => {
  gateway = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/v1/models") return Response.json({ object: "list", data: modelList(["group/pool-b", "upb/b1", "upb/b2", "la/upa/a1"]) });
      if (url.pathname === "/v1/magpie/me") {
        meCalls += 1;
        const key = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
        const who = keys.get(key);
        return who ? Response.json({ ...who, version: "0.1.3285", models: [], usage: {}, topModels: [] }) : Response.json({ error: "send an enabled gateway key" }, { status: 401 });
      }
      return new Response("not found", { status: 404 });
    },
  });
});

beforeEach(async () => {
  peer?.stop();
  magpie = fakeMagpie([{ id: "pool-b", name: "Pool B", routing: "order", members: ["upb/b1"] }]);
  meCalls = 0;
  clock = 1_000_000;
  const gw = gatewayClient(`http://127.0.0.1:${gateway.port}`);
  peer = await startPeer({
    host: "127.0.0.1",
    port: 0,
    basePath: "/inspector",
    version: "test",
    service: poolService({ readGroups: () => magpie.readGroups(), listModels: () => gw.models(), run: (a) => magpie.run(a), journal: memoryJournal() }),
    verify: keyVerifier(gw, ["laptop", "laptop-capped"], { okTtlMs: 1000, now: () => clock }),
  });
});

afterAll(() => {
  peer?.stop();
  gateway?.stop(true);
});

const base = () => `http://127.0.0.1:${peer.port}/inspector/`;

describe("peer API", () => {
  test("tells a caller who it is and what it may do", async () => {
    expect((await peerClient(base(), WRITER).hello()).caller).toEqual({ key: "laptop", readOnly: false, canWrite: true });
    expect((await peerClient(base(), READER).hello()).caller).toEqual({ key: "screen", readOnly: true, canWrite: false });
    expect((await peerClient(base(), LIMITED).hello()).caller.canWrite).toBe(false);
  });

  test("refuses no key and a wrong key, as Magpie does", async () => {
    await expect(peerClient(base(), undefined).hello()).rejects.toMatchObject({ state: "forbidden" });
    await expect(peerClient(base(), "k-wrong-0123456789").snapshot()).rejects.toMatchObject({ state: "forbidden" });
  });

  test("lets a read-only key look and preview, but not change", async () => {
    const reader = peerClient(base(), READER);
    expect((await reader.snapshot()).pools.map((p) => p.id)).toEqual(["pool-b"]);
    const preview = await reader.preview("pool-b", { type: "add", member: "la/upa/a1" });
    expect(preview.after).toEqual(["upb/b1", "la/upa/a1"]);
    await expect(reader.apply("pool-b", preview.op, preview.before)).rejects.toThrow("只读密钥");
    await expect(peerClient(base(), LIMITED).apply("pool-b", preview.op, preview.before)).rejects.toMatchObject({ state: "forbidden" });
    expect(magpie.calls).toEqual([]);
  });

  test("lets a writer add the other machine's model, names it in the journal, and undo it", async () => {
    const writer = peerClient(base(), WRITER);
    const result = await writer.apply("pool-b", { type: "add", member: "la/upa/a1" }, ["upb/b1"]);
    expect(result).toMatchObject({ matched: true, change: { by: "key:laptop", after: ["upb/b1", "la/upa/a1"] } });
    expect(magpie.groups[0]?.members).toEqual(["upb/b1", "la/upa/a1"]);
    await writer.undo(result.change.id);
    expect(magpie.groups[0]?.members).toEqual(["upb/b1"]);
    expect((await writer.snapshot()).changes).toHaveLength(2);
  });

  test("passes a conflict through to the console", async () => {
    magpie.editBehind("pool-b", ["upb/b2"]);
    await expect(peerClient(base(), WRITER).apply("pool-b", { type: "add", member: "upb/b1" }, ["upb/b1"])).rejects.toMatchObject({ state: "conflict", status: 409 });
  });

  test("refuses browsers outright", async () => {
    const response = await fetch(`${base()}v1/peer`, { headers: { authorization: `Bearer ${WRITER}`, origin: "https://evil.example" } });
    expect(response.status).toBe(403);
    expect(meCalls).toBe(0);
  });

  test("answers with or without the reverse proxy's prefix", async () => {
    const plain = await fetch(`http://127.0.0.1:${peer.port}/v1/peer`, { headers: { authorization: `Bearer ${WRITER}` } });
    expect(plain.status).toBe(200);
  });

  test("caches a valid key briefly, and follows Magpie when it is revoked", async () => {
    const writer = peerClient(base(), WRITER);
    await writer.hello();
    await writer.hello();
    expect(meCalls).toBe(1);
    keys.delete(WRITER);
    clock += 1001;
    await expect(writer.hello()).rejects.toMatchObject({ state: "forbidden" });
    keys.set(WRITER, { name: "laptop", readOnly: false, limits: [] });
  });

  test("never charges requests that don't reach the gateway, so they can't lock a key out", async () => {
    for (let i = 0; i < 30; i += 1) expect((await fetch(`${base()}v1/peer`)).status).toBe(401);
    expect((await peerClient(base(), READER).hello()).caller.key).toBe("screen");
  });

  test("keeps concurrent wrong keys within the bucket, and never locks out a key that verified before", async () => {
    await peerClient(base(), WRITER).hello();
    const before = meCalls;
    await Promise.all(Array.from({ length: 60 }, (_, i) => fetch(`${base()}v1/peer`, { headers: { authorization: `Bearer k-burst-${String(i).padStart(12, "0")}` } })));
    expect(meCalls - before).toBeLessThanOrEqual(20);
    clock += 1001;
    expect((await peerClient(base(), WRITER).hello()).caller.canWrite).toBe(true);
  });

  test("gives up on an oversized answer as it streams, not after reading it all", async () => {
    // The producer shares this process's event loop with the client, so it
    // yields between chunks; a real peer runs in a process of its own.
    let produced = 0;
    const endless = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch: () => new Response(new ReadableStream({
        async pull(controller) {
          await Bun.sleep(1);
          if (produced >= 64) return controller.close();
          produced += 1;
          controller.enqueue(new Uint8Array(1024 * 1024));
        },
      }), { headers: { "content-type": "application/json" } }),
    });
    try {
      await expect(peerClient(`http://127.0.0.1:${endless.port}/`, WRITER).snapshot()).rejects.toThrow("过大");
      expect(produced).toBeLessThan(40);
    } finally {
      endless.stop(true);
    }
  });

  test("answers its health probe to this machine's direct calls alone", async () => {
    expect(await json(await fetch(`http://127.0.0.1:${peer.port}/healthz`))).toMatchObject({ ok: true, name: "magpie-route-inspector" });
    expect((await fetch(`http://127.0.0.1:${peer.port}/healthz`, { headers: { "x-forwarded-for": "203.0.113.9" } })).status).toBe(404);
  });

  test("stops asking Magpie about a flood of wrong keys", async () => {
    let refused = 0;
    for (let i = 0; i < 25; i += 1) {
      const response = await fetch(`${base()}v1/peer`, { headers: { authorization: `Bearer k-flood-${String(i).padStart(12, "0")}` } });
      if (response.status === 429 || (await json(response)).error?.message?.includes("过多")) refused += 1;
    }
    expect(refused).toBeGreaterThan(0);
    expect(meCalls).toBeLessThanOrEqual(20);
  });
});
