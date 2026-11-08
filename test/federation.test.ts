import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseModels, providerId, remoteRequest } from "../src/federation/catalog.ts";
import { loadFederation, parseFederation, saveFederation, writePrivate } from "../src/federation/config.ts";
import { providerModule, syncFederation, withConfigurationLock } from "../src/federation/install.ts";
import { mcpHandler, mcpName, mcpUrl } from "../src/federation/mcp.ts";
import { createProvider, pluginModel } from "../src/federation/provider.ts";

const directories: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
async function temporary() {
  const directory = await mkdtemp(join(tmpdir(), "magpie-federation-test-"));
  directories.push(directory);
  return join(directory, "config.json");
}

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("native remote provider identities", () => {
  test("keeps the same model at two suppliers distinct, including routing groups", () => {
    const sources = parseModels({ data: [
      { id: "relay-a/gpt-5", display_name: "GPT 5" },
      { id: "relay-b/gpt-5", display_name: "GPT 5" },
      { id: "relay-a/gpt-5" },
      { id: "group/smart", display_name: "Smart" },
      { id: "unnamespaced" },
    ] });
    expect(sources.map((source) => source.id)).toEqual(["relay-a", "relay-b", "group"]);
    expect(sources[0]?.models.map((model) => model.id)).toEqual(["relay-a/gpt-5"]);
    expect(providerId("vps", "relay-a")).not.toBe(providerId("vps", "relay-b"));
    expect(providerId("vps", "OpenAI")).not.toBe(providerId("vps", "openai"));
    expect(providerId("vps", "relay-a")).toBe(providerId("vps", "relay-a"));
  });

  test("preserves context and known prices, and labels exact server and supplier", () => {
    const descriptor = { id: "local-relay", name: "Relay · VPS", server: "vps", source: "relay-a" };
    const model = parseModels({ data: [{ id: "relay-a/gpt-5", display_name: "GPT 5", context_length: 400000, pricing: { prompt: "0.000002", completion: "0.000008" } }] })[0]!.models[0]!;
    expect(pluginModel(model, descriptor)).toMatchObject({
      name: "GPT 5 · relay-a · vps",
      api: { id: "relay-a/gpt-5" },
      limit: { context: 400000 },
      cost: { input: 2, output: 8 },
    });
    const unknown = pluginModel({ ...model, raw: {} }, descriptor);
    expect(unknown).not.toHaveProperty("cost");
    const detailed = pluginModel({ ...model, raw: {
      ...model.raw,
      native_endpoints: ["/v1/responses"],
      supported_reasoning_levels: ["low", "high"],
      service_tiers: [{ id: "priority" }],
      modalities: { input: ["text", "image"], output: ["text"] },
      magpie_price: { input: 3, output: 9, cache_read: 0.3 },
    } }, descriptor);
    expect(detailed).toMatchObject({
      api: { npm: "@ai-sdk/openai" },
      variants: { low: {}, high: {} },
      serviceTiers: ["priority"],
      capabilities: { reasoning: true, input: { text: true, image: true, audio: false }, output: { image: false } },
      cost: { input: 3, output: 9, cache: { read: 0.3 } },
    });
  });

  test("generates separate native hooks, never interpolating executable config text", () => {
    const module = providerModule("/tmp/a \"path\"/config.json", [
      { id: "mf-one", server: "vps", source: "relay-a", name: 'Relay A " · VPS' },
      { id: "mf-two", server: "vps", source: "relay-b", name: "Relay B · VPS" },
    ]);
    expect(module).toContain("export const remote0");
    expect(module).toContain("export const remote1");
    expect(module).toContain('Relay A \\" · VPS');
    expect(module).toContain("/src/federation/provider.ts");
  });

  test("forwards only to the corresponding supplier and streams the remote response", async () => {
    const calls: { body: unknown; key: string | null; path: string }[] = [];
    const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      calls.push({ body: await request.json(), key: request.headers.get("authorization"), path: new URL(request.url).pathname });
      return new Response('data: {"choices":[]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
    } });
    servers.push(upstream);
    const path = await temporary();
    await saveFederation(parseFederation({ servers: [{ id: "vps", url: upstream.url.origin, key: "private-remote-key", mcp: false }] }), path);
    const hooks = createProvider({}, path, { id: "mf-relay", server: "vps", source: "relay-a", name: "Relay A · VPS" });
    const loader = await hooks.auth.loader();
    const response = await loader.fetch("http://federation.magpie/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer incoming-secret", "x-api-key": "incoming-anthropic-secret" },
      body: JSON.stringify({ model: "relay-a/gpt-5", messages: [], stream: true }),
    });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(await response.text()).toContain("[DONE]");
    expect(calls).toEqual([{ body: { model: "relay-a/gpt-5", messages: [], stream: true }, key: "Bearer private-remote-key", path: "/v1/chat/completions" }]);
    const denied = await loader.fetch("http://federation.magpie/v1/chat/completions", { body: JSON.stringify({ model: "relay-b/gpt-5" }) });
    expect(denied.status).toBe(400);
    expect(calls).toHaveLength(1);
  });

  test("does not follow a credential-bearing redirect", async () => {
    let leaked = false;
    const target = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { leaked = true; return new Response(""); } });
    const redirect = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return Response.redirect(target.url.href, 302); } });
    servers.push(target, redirect);
    const server = parseFederation({ servers: [{ id: "vps", url: redirect.url.origin, key: "remote-secret" }] }).servers[0]!;
    await expect(remoteRequest(server, "models")).rejects.toThrow("重定向");
    expect(leaked).toBe(false);
  });
});

describe("Federation configuration and synchronization", () => {
  test("does not replace managed entries when the configuration file is missing", async () => {
    const path = await temporary();
    let called = false;
    await expect(syncFederation(path, async () => { called = true; return { code: 0, stdout: "", stderr: "" }; })).rejects.toThrow("配置不存在");
    expect(called).toBe(false);
  });

  test("validates private transport and accepts the previous remotes format", () => {
    expect(() => parseFederation({ servers: [{ id: "vps", url: "http://example.com" }] })).toThrow("HTTPS");
    expect(() => parseFederation({ servers: [{ id: "vps", url: "https://example.com?key=secret" }] })).toThrow();
    expect(parseFederation({ remotes: [{ id: "vps", name: "VPS", url: "http://100.64.0.1", keyEnv: "VPS_KEY" }] }).servers[0]).toMatchObject({ id: "vps", url: "http://100.64.0.1/v1/", mcp: "hub" });
  });

  test("stores configuration privately and refuses concurrent writes", async () => {
    const path = await temporary();
    await saveFederation(parseFederation({}), path);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await loadFederation(path)).token).toHaveLength(64);
    await withConfigurationLock(path, async () => {
      await expect(withConfigurationLock(path, async () => {})).rejects.toThrow("正在运行");
    });
  });

  test("completes all discovery before changing native provider entries", async () => {
    const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return new Response("private server error", { status: 401 }); } });
    servers.push(upstream);
    const path = await temporary();
    const commands: readonly string[][] = [];
    const config = parseFederation({ servers: [{ id: "vps", url: upstream.url.origin, mcp: false }] });
    await expect(syncFederation(path, async (args) => { (commands as string[][]).push([...args]); return { code: 0, stdout: "", stderr: "" }; }, config, { XDG_CONFIG_HOME: dirname(path) })).rejects.toThrow("HTTP 401");
    expect(commands).toEqual([]);
    expect(await Bun.file(path).exists()).toBe(false);
  });

  test("registers every supplier separately using managed local credentials", async () => {
    const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return Response.json({ data: [{ id: "codex/gpt-5" }, { id: "deepseek/v4" }] }); } });
    servers.push(upstream);
    const path = await temporary();
    const commands: string[][] = [];
    const result = await syncFederation(path, async (args) => { commands.push([...args]); return { code: 0, stdout: "", stderr: "" }; }, parseFederation({ servers: [{ id: "vps", url: upstream.url.origin, key: "secret-must-stay-in-config", mcp: false }] }), { XDG_CONFIG_HOME: dirname(path) });
    expect(result.providers.map((provider) => provider.source)).toEqual(["codex", "deepseek"]);
    expect(commands[0]?.slice(0, 2)).toEqual(["plugin", "add"]);
    const accounts: string[] = [];
    for (const descriptor of result.providers) {
      const hooks = createProvider({ client: { auth: { async set(options) { accounts.push(options.path.id); } } } }, path, descriptor);
      await hooks.config({});
    }
    expect(accounts).toEqual(result.providers.map((provider) => provider.id));
    expect(JSON.stringify(commands)).not.toContain("secret-must-stay-in-config");
    expect(await readFile(join(path, "../providers/index.mjs"), "utf8")).not.toContain("secret-must-stay-in-config");
  });

  test("keeps existing MCP assignments and tool settings when synchronizing again", async () => {
    const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      return Response.json(new URL(request.url).pathname === "/v1" ? { mcp_hub: true } : { data: [{ id: "relay/model" }] });
    } });
    servers.push(upstream);
    const path = await temporary();
    const env = { XDG_CONFIG_HOME: dirname(path) };
    const config = parseFederation({ token: "a".repeat(64), servers: [{ id: "vps", url: upstream.url.origin }] });
    const item = { server: "vps", name: mcpName("vps") };
    const library = { mcp: [{ name: item.name, url: mcpUrl(config, item), agents: ["codex"], disabledTools: ["unused"] }] };
    const libraryPath = join(dirname(path), "magpie", "library.json");
    await writePrivate(libraryPath, JSON.stringify(library));
    const commands: string[][] = [];
    await syncFederation(path, async (args) => { commands.push([...args]); return { code: 0, stdout: "", stderr: "" }; }, config, env);
    expect(commands.some((args) => args[0] === "library")).toBe(false);
    expect(JSON.parse(await readFile(libraryPath, "utf8"))).toEqual(library);
  });
});

test("MCP namespaces keep source identity and reject cross-server calls", async () => {
  let calls = 0;
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    calls += 1;
    const body = await request.json() as { id: number; method: string };
    return Response.json({ jsonrpc: "2.0", id: body.id, result: body.method === "initialize" ? { serverInfo: { name: "magpie" }, capabilities: { tools: {} } } : { tools: [{ name: "docs__search", inputSchema: { type: "object" } }, { name: "github__read", inputSchema: { type: "object" } }] } });
  } });
  servers.push(upstream);
  const path = await temporary();
  const config = parseFederation({ port: 3487, servers: [{ id: "vps", name: "VPS", url: upstream.url.origin, mcp: "servers" }] });
  await saveFederation(config, path);
  const url = mcpUrl(config, { server: "vps", namespace: "docs", name: "mf-vps-mcp-docs" });
  const handler = mcpHandler(path, 3487);
  const request = (method: string, params?: unknown, headers: Record<string, string> = {}) => new Request(url, {
    method: "POST",
    headers: { host: "127.0.0.1:3487", "content-type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const list = await (await handler(request("tools/list"))).json() as { result: { tools: { name: string }[] } };
  expect(list.result.tools.map((tool: { name: string }) => tool.name)).toEqual(["docs__search"]);
  const init = await (await handler(request("initialize"))).json() as { result: { instructions: string; serverInfo: { title: string } } };
  expect(init.result.instructions).toContain("docs");
  expect(init.result.serverInfo.title).toBe("VPS / docs");
  expect((await handler(request("tools/call", { name: "github__read" }))).status).toBe(400);
  expect(calls).toBe(2);
  expect((await handler(request("tools/list", undefined, { origin: "https://other.example" }))).status).toBe(403);
  expect((await handler(new Request(url.replace(config.token, "0".repeat(64)), { method: "POST", headers: { host: "127.0.0.1:3487" } }))).status).toBe(403);
});
