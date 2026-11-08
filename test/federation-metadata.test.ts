import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverMetadata, inheritedIcon } from "../src/federation/metadata.ts";
import { parseFederation, saveFederation } from "../src/federation/config.ts";
import { providerHandler, providerUrl } from "../src/federation/proxy.ts";

const roots: string[] = [];
const upstreams: ReturnType<typeof Bun.serve>[] = [];
async function setup(handler: (request: Request) => Response | Promise<Response>) {
  const root = await mkdtemp(join(tmpdir(), "federation-metadata-"));
  roots.push(root);
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  upstreams.push(upstream);
  const path = join(root, "config.json");
  const config = parseFederation({
    port: 3487,
    token: "b".repeat(64),
    servers: [{ id: "vps", name: "VPS", url: upstream.url.origin, key: "remote-private-key", mcp: false }],
  });
  await saveFederation(config, path);
  const serve = providerHandler(path, config.port);
  const request = (suffix: string, init: RequestInit = {}) => serve(new Request(
    `${providerUrl(config, "vps", "relay-a")}${suffix}`,
    { ...init, headers: { host: "127.0.0.1:3487", authorization: `Bearer ${config.token}`, ...init.headers } },
  ));
  return { root, path, config, request, serve };
}

afterEach(async () => {
  for (const upstream of upstreams.splice(0)) upstream.stop(true);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("keeps complete model metadata, tiered pricing and unknown fields", async () => {
  const model = {
    id: "relay-a/model",
    display_name: "Model",
    magpie_price: {
      input: 2, output: 8, cache_read: 0.2, cache_write: 2.5, cache_write_1h: 4,
      tiers: [{ above: 200000, input: 4, output: 12, cache_read: 0.4, cache_write: 5 }],
      peak: { factor: 2, from: "08:00", until: "22:00" },
    },
    native_endpoints: ["/v1/messages", "/v1/responses"],
    context_length: 1000000,
    max_input_tokens: 900000,
    max_output_tokens: 64000,
    supported_reasoning_levels: ["low", "high"],
    service_tiers: [{ id: "priority", name: "Fast" }],
    future_field: { nested: ["preserved"] },
  };
  const { request } = await setup(() => Response.json({ object: "list", data: [model, { id: "relay-b/model" }] }));
  const response = await request("/v1/models");
  expect(await response.json()).toEqual({ object: "list", data: [model], first_id: model.id, last_id: model.id, has_more: false });
});

test("keeps complete quota cards and scopes quota refresh to the supplier", async () => {
  let query: string | undefined;
  const card = {
    provider: "relay-a", name: "Relay A", icon: "deepseek-color", plan: "Pro", user: "account-a",
    balance: "$12.34", balanceSplit: [{ name: "Granted", amount: 2 }],
    balanceTrend: { daily: 1, until: "2027-01-01" },
    windows: [{ name: "5h", used: 37, amount: 370, limit: 1000, resetsAt: "2027-01-01T00:00:00Z", holdsWhy: ["pending"] }],
    daily: { days: [{ day: "2026-11-08", amount: 5 }] },
    resets: { count: 2 }, readAt: "2026-11-08T10:00:00Z", until: "2027-01-01T00:00:00Z", renew: "auto",
  };
  const { request } = await setup((incoming) => {
    query = new URL(incoming.url).search;
    return Response.json({ object: "list", data: [card, { provider: "relay-b", windows: [] }] });
  });
  expect(await (await request("/v1/magpie/quotas/cards")).json()).toEqual({ object: "list", data: [card] });
  expect(await (await request("/v1/magpie/quotas/refresh?provider=relay-b", { method: "POST" })).json()).toEqual({ object: "list", data: [card] });
  expect(query).toBe("?provider=relay-a");
});

test("forwards streaming bodies and authenticates with the remote key", async () => {
  let key = "";
  const { request } = await setup((incoming) => {
    key = incoming.headers.get("authorization") ?? "";
    return new Response('data: {"text":"OK"}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
  });
  const response = await request("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "relay-a/model", stream: true }),
  });
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("[DONE]");
  expect(key).toBe("Bearer remote-private-key");
  expect((await request("/v1/chat/completions", {
    method: "POST", body: JSON.stringify({ model: "relay-b/model" }),
  })).status).toBe(400);
});

test("refuses browser requests, unknown API paths and unrelated model IDs", async () => {
  const { request, serve, config } = await setup(() => Response.json({}));
  expect((await request("/v1/models", { headers: { origin: "https://example.com" } })).status).toBe(403);
  expect((await request("/v1/models", { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
  expect((await request("/v1/magpie/keys")).status).toBe(405);
  expect((await request("/v1/models/relay-b/model")).status).toBe(404);
  expect((await serve(new Request(`${providerUrl(config, "vps", "relay-a")}/v1/models`, {
    headers: { host: "outside.example", authorization: `Bearer ${config.token}` },
  }))).status).toBe(403);
});

test("preserves upstream permission failures without inventing a quota", async () => {
  const refusal = { error: { code: "gateway_key_held", message: "This key cannot see those quotas" } };
  const { request } = await setup(() => Response.json(refusal, { status: 403 }));
  const response = await request("/v1/magpie/quotas/cards");
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual(refusal);
});

test("inherits the remote icon, with an explicit builtin fallback", async () => {
  const { config, path, root } = await setup((request) => Response.json(
    new URL(request.url).pathname.includes("cards")
      ? { data: [{ provider: "relay-a", icon: "xai" }] }
      : { models: [{ provider: "relay-a", icon: "openai" }, { provider: "relay-b", icon: "deepseek-color" }] },
  ));
  const server = config.servers[0]!;
  const metadata = await discoverMetadata(server);
  expect(metadata.get("relay-a")?.icon).toBe("xai");
  expect(metadata.get("relay-b")?.icon).toBe("deepseek-color");
  expect(await inheritedIcon(server, "openai", undefined, path, { HOME: root })).toEqual({ icon: "openai", iconSource: "builtin", warnings: [] });
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path d="M0 0h1v1z"/></svg>';
  const copied = await inheritedIcon(server, "relay-a", {
    icon: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`, warnings: [], iconSource: "remote",
  }, path, { HOME: root });
  expect(copied.iconSource).toBe("remote");
  expect(await readFile(copied.icon!, "utf8")).toBe(svg);
});
