import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatewayClient } from "../src/machine/gateway.ts";
import { memoryJournal } from "../src/machine/journal.ts";
import { poolService } from "../src/machine/pools.ts";
import { keyVerifier } from "../src/peer/auth.ts";
import { startPeer, type RunningPeer } from "../src/peer/server.ts";
import { startConsole, type RunningConsole } from "../src/server/console.ts";
import { fakeMagpie, modelList, type FakeMagpie } from "./fakes.ts";

// Response bodies in tests are read loosely; the code under test validates them.
const json = (response: Response): Promise<any> => response.json() as Promise<any>;


const secret = "fake-gateway-key-for-tests-000000";
const account = "private@example.test";
const PEER_KEY = "k-writer-0123456789";
type Server = ReturnType<typeof Bun.serve>;

let directory: string, config: string, token: string;
let upstream: Server, sink: Server, vpsGateway: Server;
let service: RunningConsole, peer: RunningPeer;
let local: FakeMagpie, vps: FakeMagpie;
let mode = "normal";
let leaked = false;
let lastAuthorization: string | null = null;

const row = (changes: Record<string, unknown> = {}) => ({ route_id: 123, session: "session-1", t: "2026-01-01T00:00:00Z", provider: "provider", model: "model", status: 200, in: 5, out: 7, priced: false, cost: 0, providerAccount: account, providerKeyId: "private-key-id", providerKeyName: "work key", ...changes });
const rule = () => ({
  n: 2, turn: 3, tokens: 1024, use: "provider/model", when: ["intent: code", `credential ${secret}`],
  more: ["provider/backup"], held: false, folder: "/private/workspace", private: secret,
  classified: { by: "provider/classifier", intents: ["code", "chat"], intent: "code", score: 2, sure: 0.9, cached: false, ms: 12, error: `diagnostic ${secret}`, private: secret },
});

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "route-inspector-test-"));
  config = join(directory, "config.json");
  sink = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { leaked = true; return new Response("unexpected"); } });
  upstream = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      lastAuthorization = request.headers.get("authorization");
      const url = new URL(request.url);
      if (mode === "redirect") return Response.redirect(`http://127.0.0.1:${sink.port}/`, 302);
      if (mode === "forbidden") return new Response("private upstream body", { status: 403 });
      if (url.pathname === "/v1/magpie/route") return Response.json({
        session: url.searchParams.get("session"), seq: 7,
        route: {
          id: 123, time: "2026-01-01T00:00:00Z", asked: "auto", kind: "title", done: mode !== "running", status: 200, responseId: "resp-1",
          tries: [{ model: "provider/model", done: true, status: 200 }], private: secret,
          ...(mode === "no-rule" ? {} : { rule: rule(), nested: [{ group: "nested-group", name: "Nested group", rule: rule(), folder: "/private/nested" }, { group: "no-decision", rule: null }] }),
        },
      });
      if (url.pathname === "/v1/magpie/usage/requests") {
        if (mode === "running") throw new Error("usage must not be asked while a route is under way");
        expect(url.searchParams.get("route")).toBe("123");
        return Response.json({ rows: [row(), row({ priced: true, cost: 0 }), row({ priced: true, cost: 0.25, handed_on: true }), row({ route_id: 124 }), row({ session: "other" })] });
      }
      return new Response("missing", { status: 404 });
    },
  });
  vpsGateway = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/v1/models") return Response.json({ data: modelList(["group/pool-b", "upb/b1", "la/upa/a1", "la/group/pool-c"]) });
      if (url.pathname === "/v1/magpie/me") {
        return request.headers.get("authorization") === `Bearer ${PEER_KEY}`
          ? Response.json({ name: "laptop", readOnly: false, limits: [], version: "0.1.3285" })
          : Response.json({ error: "send an enabled gateway key" }, { status: 401 });
      }
      return new Response("missing", { status: 404 });
    },
  });
  vps = fakeMagpie([{ id: "pool-b", name: "Pool B", routing: "order", members: ["upb/b1"] }]);
  const vpsGw = gatewayClient(`http://127.0.0.1:${vpsGateway.port}`);
  peer = await startPeer({
    host: "127.0.0.1", port: 0, basePath: "/inspector", version: "test",
    service: poolService({ readGroups: () => vps.readGroups(), listModels: () => vpsGw.models(), run: (a) => vps.run(a), journal: memoryJournal() }),
    verify: keyVerifier(vpsGw, ["laptop"]),
  });
  await writeFile(config, JSON.stringify({
    remotes: [
      { id: "remote", name: "Remote", url: `http://127.0.0.1:${upstream.port}/v1`, key: secret, accountAliases: { [account]: "Team account" } },
      { id: "vps", name: "vps", url: `http://127.0.0.1:${vpsGateway.port}`, key: PEER_KEY, peer: `http://127.0.0.1:${peer.port}/inspector` },
      { id: "down", name: "Down", url: "http://127.0.0.1:1", key: PEER_KEY, peer: "http://127.0.0.1:1/inspector" },
    ],
  }));
  local = fakeMagpie([{ id: "pool-a", name: "Pool A", routing: "order", members: ["upa/a1"] }]);
  service = await startConsole({
    port: 0, config,
    pools: poolService({ readGroups: () => local.readGroups(), listModels: async () => modelList(["group/pool-a", "upa/a1", "upa/a2", "vps/group/pool-b"]), run: (a) => local.run(a), journal: memoryJournal() }),
  });
  const shell = await fetch(service.url);
  token = (await shell.text()).match(/data-api-token="([a-f0-9]+)"/)?.[1] ?? "";
});

afterAll(async () => {
  service?.stop();
  peer?.stop();
  for (const server of [upstream, sink, vpsGateway]) server?.stop(true);
  if (directory) await rm(directory, { recursive: true, force: true });
});

function api(path: string, headers: Record<string, string> = {}) {
  return fetch(new URL(path, service.url), { headers: { "X-Inspector-Token": token, ...headers } });
}

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(new URL(path, service.url), { method: "POST", headers: { "X-Inspector-Token": token, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}

function rawRequest(path: string, host: string | undefined, withToken = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port: service.port });
    let response = "";
    socket.setEncoding("utf8");
    socket.setTimeout(2000, () => socket.destroy(new Error("raw request timed out")));
    socket.on("error", reject);
    socket.on("data", (chunk) => { response += chunk; });
    socket.on("end", () => resolve(response));
    socket.on("connect", () => socket.write(`GET ${path} HTTP/1.1\r\n${host === undefined ? "" : `Host: ${host}\r\n`}${withToken ? `X-Inspector-Token: ${token}\r\n` : ""}Connection: close\r\n\r\n`));
  });
}

describe("console service", () => {
  test("requires a token, rejects cross-site shell reads, and supports sandbox origin", async () => {
    expect((await fetch(new URL("api/remotes", service.url))).status).toBe(403);
    expect((await fetch(service.url, { headers: { "sec-fetch-site": "cross-site", "sec-fetch-dest": "empty" } })).status).toBe(403);
    expect((await fetch(service.url, { headers: { "sec-fetch-site": "cross-site", "sec-fetch-dest": "iframe" } })).status).toBe(200);
    const preflight = await fetch(new URL("api/pools/apply", service.url), { method: "OPTIONS", headers: { origin: "null", "access-control-request-method": "POST" } });
    expect(preflight.headers.get("access-control-allow-origin")).toBe("null");
    expect(preflight.headers.get("access-control-allow-methods")).toContain("POST");
    const remotes = await api("api/remotes", { origin: "null" });
    expect(remotes.headers.get("access-control-allow-origin")).toBe("null");
    expect(await remotes.json()).toEqual({
      remotes: [{ id: "remote", name: "Remote", peer: false }, { id: "vps", name: "vps", peer: true }, { id: "down", name: "Down", peer: true }],
      capabilities: { mode: "session-latest", crossMachineCorrelation: true, historyComplete: false, pools: true },
    });
  });

  test("blocks rebinding hosts before shell and authenticated API access", async () => {
    for (const host of [`attacker.test:${service.port}`, `127.0.0.1:${service.port + 1}`, "", undefined]) {
      for (const path of ["/", "/api/remotes"]) {
        const response = await rawRequest(path, host, true);
        expect(response).not.toMatch(/^HTTP\/1\.[01] 200 /);
        expect(response).not.toContain(token);
        expect(response).not.toContain('"remotes"');
      }
    }
  });

  test("lets only Magpie's window, magpie web and itself frame the page", async () => {
    const policy = (await fetch(service.url)).headers.get("content-security-policy") ?? "";
    expect(policy).toContain("frame-ancestors 'self' wails: http://wails.localhost");
  });

  test("refuses another system user before serving anything but the health probe", async () => {
    const stranger = await startConsole({
      port: 0, config, sameUser: async () => false,
      pools: poolService({ readGroups: () => local.readGroups(), listModels: async () => [], run: (a) => local.run(a), journal: memoryJournal() }),
    });
    try {
      expect((await fetch(stranger.url)).status).toBe(403);
      expect((await fetch(`${stranger.url}api/remotes`, { headers: { "X-Inspector-Token": token } })).status).toBe(403);
      expect((await fetch(`${stranger.url}healthz`)).status).toBe(200);
    } finally {
      stranger.stop();
    }
  });

  test("refuses anything that came through a proxy in front of it", async () => {
    for (const header of ["x-forwarded-for", "forwarded", "cf-connecting-ip", "tailscale-user-login"]) {
      expect((await api("api/remotes", { [header]: "203.0.113.9" })).status).toBe(403);
      expect((await fetch(service.url, { headers: { [header]: "203.0.113.9" } })).status).toBe(403);
    }
  });

  test("passes the host's theme to the page and answers a health probe without data", async () => {
    expect(await (await fetch(`${service.url}?theme=dark`)).text()).toContain('data-host-theme="dark"');
    expect(await (await fetch(`${service.url}?theme=<x>`)).text()).toContain('data-host-theme=""');
    const health = await json(await fetch(`${service.url}healthz`));
    expect(health).toMatchObject({ ok: true, name: "magpie-route-inspector" });
    expect(JSON.stringify(health)).not.toContain(token);
  });

  test("builds the page script from TypeScript", async () => {
    const script = await fetch(`${service.url}app.js`);
    expect(script.headers.get("content-type")).toContain("javascript");
    expect((await script.text()).length).toBeGreaterThan(1000);
  });

  test("filters route and session, protects identities, and distinguishes unknown pricing", async () => {
    mode = "normal";
    const response = await api("api/route?remote=remote&session=session-1&after=0&wait=0");
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).not.toContain(secret);
    expect(body).not.toContain(account);
    expect(body).not.toContain("private-key-id");
    const result = JSON.parse(body);
    expect(lastAuthorization).toBe(`Bearer ${secret}`);
    expect(result.route.kind).toBe("title");
    expect(result.route.rule.when).toEqual(["intent: code", "credential [已隐藏]"]);
    expect(result.route.rule.classified).toEqual({ by: "provider/classifier", intents: ["code", "chat"], intent: "code", score: 2, sure: 0.9, cached: false, ms: 12, error: "diagnostic [已隐藏]" });
    expect(result.route.rule).not.toHaveProperty("folder");
    expect(result.route.nested[0]).not.toHaveProperty("folder");
    expect(result.route.nested[1].rule).toBeNull();
    expect(result.usage.rows.map((item: { cost: { state: string } }) => item.cost.state)).toEqual(["unknown", "known-zero", "estimated"]);
    expect(result.usage.rows[0].accountAlias).toBe("Team account");
    expect(result.usage.rows[2].handedOn).toBe(true);
    expect(result.route.responseId).toBe("resp-1");
    expect(result.link).toEqual({ state: "unavailable", note: "读不到本机路由，这一跳无法与远端对照。" });
    expect(result.rollup.state).toBe("withheld");
    expect(result.earlier).toEqual([]);
    expect((await api(`api/route?remote=remote&session=${"x".repeat(129)}`)).status).toBe(400);
    expect((await api("api/route?remote=remote&session=session-1&wait=26")).status).toBe(400);
  });

  test("lists nothing from a gateway it was not given", async () => {
    expect(await json(await api("api/sessions"))).toEqual({ state: "unavailable", sessions: [], message: "未连接本机网关，会话需要手填。" });
  });

  test("correlates one local hop by response id and remembers the route", async () => {
    const traced = {
      routes: [{
        id: 9, time: "2026-01-01T00:00:00.000Z", session: "session-1", agent: "dsh",
        provider: "remote", model: "remote/provider/model", ms: 1500, responseId: "resp-1",
        tries: [{ id: "remote", model: "provider/model" }],
        prompt: "do not keep", order: [{ who: "secret-account" }],
      }, {
        id: 8, time: "2025-12-31T00:00:00.000Z", session: "session-1", provider: "remote", model: "remote/old",
        tries: [{ id: "remote", model: "old" }],
      }],
    };
    const extra = await startConsole({
      port: 0, config, readTrace: async () => traced,
      pools: poolService({ readGroups: () => local.readGroups(), listModels: async () => [], run: (args) => local.run(args), journal: memoryJournal() }),
    });
    try {
      const shell = await fetch(extra.url);
      const extraToken = (await shell.text()).match(/data-api-token="([a-f0-9]+)"/)?.[1] ?? "";
      const call = (path: string) => fetch(new URL(path, extra.url), { headers: { "X-Inspector-Token": extraToken } });
      const sessions = await json(await call("api/sessions"));
      expect(JSON.stringify(sessions)).not.toContain("do not keep");
      expect(JSON.stringify(sessions)).not.toContain("secret-account");
      expect(sessions.sessions.map((item: { id: string; routeId: number }) => [item.id, item.routeId])).toEqual([["session-1", 9]]);
      const route = await json(await call("api/route?remote=remote&session=session-1&wait=0"));
      expect(route.link).toEqual({ state: "matched", by: "response-id", localRouteId: 9, note: "与本机路由 9 的响应 ID 相同。" });
      expect(route.rollup).toMatchObject({ state: "partial", usd: 0.25 });
      expect(route.earlier).toEqual([]);
      const again = await json(await call("api/route?remote=remote&session=session-1&wait=0"));
      expect(again.earlier).toEqual([]);
    } finally {
      extra.stop();
    }
  });

  test("does not ask for usage while the route is still under way", async () => {
    mode = "running";
    try {
      const result = await json(await api("api/route?remote=remote&session=session-1"));
      expect(result.usage).toEqual({ state: "pending", rows: [] });
    } finally {
      mode = "normal";
    }
  });

  test("does not follow redirects and recovers when the remote recovers", async () => {
    mode = "redirect";
    expect((await json(await api("api/route?remote=remote&session=session-1"))).error.state).toBe("incompatible");
    expect(leaked).toBe(false);
    mode = "forbidden";
    expect((await json(await api("api/route?remote=remote&session=session-1"))).error.state).toBe("forbidden");
    mode = "normal";
    expect((await api("api/route?remote=remote&session=session-1")).status).toBe(200);
  });
});

describe("console pools", () => {
  test("shows every machine, each in its own state", async () => {
    const { machines } = await json(await api("api/pools"));
    expect(machines.map((m: { id: string; state: string; writable: boolean }) => [m.id, m.state, m.writable])).toEqual([
      ["local", "ready", true],
      ["remote", "unconfigured", false],
      ["vps", "ready", true],
      ["down", "offline", false],
    ]);
    const remoteView = machines[2];
    expect(remoteView.pools[0].members).toEqual(["upb/b1"]);
    expect(remoteView.candidates.find((c: { id: string }) => c.id === "la/group/pool-c").kind).toBe("remote-pool");
  });

  test("adds a remote pool into a local pool, then undoes it", async () => {
    const preview = await json(await post("api/pools/preview", { machine: "local", pool: "pool-a", op: { type: "add", member: "vps/group/pool-b" } }));
    expect(preview).toMatchObject({ machine: "local", after: ["upa/a1", "vps/group/pool-b"], command: ["group", "set", "pool-a", "models+=vps/group/pool-b"] });
    const applied = await json(await post("api/pools/apply", { machine: "local", pool: "pool-a", op: preview.op, expected: preview.before }));
    expect(applied.matched).toBe(true);
    expect(local.groups[0]?.members).toEqual(["upa/a1", "vps/group/pool-b"]);
    await post("api/pools/undo", { machine: "local", change: applied.change.id });
    expect(local.groups[0]?.members).toEqual(["upa/a1"]);
  });

  test("adds a model of this machine into the remote's pool through its peer", async () => {
    const applied = await json(await post("api/pools/apply", { machine: "vps", pool: "pool-b", op: { type: "add", member: "la/upa/a1" }, expected: ["upb/b1"] }));
    expect(applied.change.by).toBe("key:laptop");
    expect(vps.groups[0]?.members).toEqual(["upb/b1", "la/upa/a1"]);
    const conflict = await post("api/pools/apply", { machine: "vps", pool: "pool-b", op: { type: "remove", member: "upb/b1" }, expected: ["upb/b1"] });
    expect(conflict.status).toBe(409);
  });

  test("refuses changes without the token, from another origin, or not as JSON", async () => {
    const body = { machine: "local", pool: "pool-a", op: { type: "add", member: "upa/a2" }, expected: ["upa/a1"] };
    expect((await fetch(new URL("api/pools/apply", service.url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).status).toBe(403);
    expect((await post("api/pools/apply", body, { origin: "https://evil.example" })).status).toBe(403);
    const text = await fetch(new URL("api/pools/apply", service.url), { method: "POST", headers: { "X-Inspector-Token": token, "content-type": "text/plain" }, body: JSON.stringify(body) });
    expect(text.status).toBe(415);
    expect(local.groups[0]?.members).toEqual(["upa/a1"]);
  });

  test("validates every field of a change", async () => {
    for (const body of [
      { machine: "../etc", pool: "pool-a", op: { type: "add", member: "upa/a2" } },
      { machine: "local", pool: "pool a", op: { type: "add", member: "upa/a2" } },
      { machine: "local", pool: "pool-a", op: { type: "add", member: "upa/*" } },
      { machine: "local", pool: "pool-a", op: { type: "drop", member: "upa/a2" } },
    ]) {
      expect((await post("api/pools/preview", body)).status).toBe(400);
    }
  });

  test("recovers from an invalid configuration without restarting", async () => {
    const original = await Bun.file(config).text();
    try {
      await writeFile(config, "{invalid");
      const failed = await api("api/remotes");
      expect(failed.status).toBe(503);
      expect((await json(failed)).error.message).toContain("配置错误");
      await writeFile(config, original);
      expect((await api("api/remotes")).status).toBe(200);
    } finally {
      await writeFile(config, original);
    }
  });
});
