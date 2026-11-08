import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliRunner, locateMagpie } from "../src/machine/cli.ts";
import { loadFederation, parseFederation } from "../src/federation/config.ts";
import { syncFederation } from "../src/federation/install.ts";
import { mcpUrl } from "../src/federation/mcp.ts";

const root = await mkdtemp(join(tmpdir(), "magpie-federation-e2e-"));
const bin = locateMagpie(process.env);
if (!bin) throw new Error("magpie is required");
const children: ReturnType<typeof Bun.spawn>[] = [];
let completed = false;
const upstreamCalls: { source: string; model: string }[] = [];
let failFirstSource = false;
const upstream = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    const source = url.pathname.split("/")[1]!;
    if (url.pathname.endsWith("/models")) return Response.json({ data: [{ id: "shared-model" }] });
    const body = await request.json() as { model: string; stream?: boolean };
    upstreamCalls.push({ source, model: body.model });
    if (source === "a" && failFirstSource) return Response.json({ error: { message: "sandbox source A unavailable" } }, { status: 429 });
    if (body.stream) {
      return new Response(`data: ${JSON.stringify({ id: `e2e-${source}`, object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: `from-${source}` }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: `e2e-${source}`, object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    }
    return Response.json({
      id: `e2e-${source}`,
      object: "chat.completion",
      created: 0,
      model: body.model,
      choices: [{ index: 0, message: { role: "assistant", content: `from-${source}` }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    });
  },
});

function freePort(): number {
  const socket = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = socket.port!;
  socket.stop(true);
  return port;
}

const aPort = freePort();
const bPort = freePort();
const mcpPort = freePort();

function environment(name: string, port: number): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: join(root, name, "home"),
    XDG_CONFIG_HOME: join(root, name, "config"),
    XDG_CACHE_HOME: join(root, name, "cache"),
    XDG_DATA_HOME: join(root, name, "data"),
    XDG_STATE_HOME: join(root, name, "state"),
    MAGPIE_ADDR: `127.0.0.1:${port}`,
    MAGPIE_BUN: process.env.MAGPIE_BUN || process.execPath,
  };
}
const aEnv = environment("a", aPort);
const bEnv = environment("b", bPort);
const aRun = cliRunner(bin, aEnv, 90_000);
const bRun = cliRunner(bin, bEnv, 90_000);

async function command(run: typeof aRun, ...args: string[]) {
  const result = await run(args);
  // Fixtures use disposable keys only. Keep command output out of reports.
  assert.equal(result.code, 0, `magpie ${args.slice(0, 2).join(" ")} failed (${result.code}): ${result.stderr.slice(-1200)}`);
  return result.stdout;
}

async function serving(name: string, env: Record<string, string>, port: number) {
  const child = Bun.spawn([bin!, "serve"], {
    env, stdin: "ignore",
    stdout: Bun.file(join(root, `${name}.log`)),
    stderr: Bun.file(join(root, `${name}.err.log`)),
  });
  children.push(child);
  await eventually(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/v1/models`, { signal: AbortSignal.timeout(1000) });
    assert.equal(response.status, 200);
  }, 60_000);
}

async function eventually(check: () => Promise<void>, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  let last: unknown;
  while (Date.now() < deadline) {
    try { await check(); return; } catch (error) { last = error; }
    await Bun.sleep(250);
  }
  throw last;
}

const fixture = `
import { createInterface } from "node:readline";
const source = process.argv[2];
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.id === undefined) continue;
  const result = message.method === "initialize"
    ? { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: source, version: "1" } }
    : message.method === "tools/list"
      ? { tools: [{ name: "lookup", description: "Lookup on " + source, inputSchema: { type: "object", properties: {} } }] }
      : { content: [{ type: "text", text: "tool-from-" + source }] };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
}
`;

try {
  for (const env of [aEnv, bEnv]) {
    for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"]) await mkdir(env[key]!, { recursive: true });
  }
  await command(aRun, "update", "auto", "off");
  await command(bRun, "update", "auto", "off");
  await command(bRun, "provider", "add", "Relay A", `url=${upstream.url.origin}/a/v1`, "key=e2e-a", "models=shared-model", "id=relay-a");
  await command(bRun, "provider", "add", "Relay B", `url=${upstream.url.origin}/b/v1`, "key=e2e-b", "models=shared-model", "id=relay-b");
  await command(bRun, "group", "add", "Remote Pool", "models=relay-a/shared-model,relay-b/shared-model", "routing=order");
  const keyOutput = await command(bRun, "gateway-key", "add", "federation-e2e");
  const key = keyOutput.trim().split(/\s+/).find((word) => word.startsWith("sk-"));
  assert.ok(key, "sandbox gateway key missing");
  const fixturePath = join(root, "mcp-fixture.mjs");
  await writeFile(fixturePath, fixture);
  for (const name of ["docs", "github"]) await command(bRun, "library", "mcp", "add", name, process.execPath, fixturePath, name, "agents=none");
  await command(bRun, "library", "mcp", "router", "on");
  await serving("b", bEnv, bPort);
  await serving("a", aEnv, aPort);
  const path = join(aEnv.XDG_CONFIG_HOME!, "magpie-federation", "config.json");
  const config = parseFederation({
    port: mcpPort,
    servers: [{ id: "vps", name: "Sandbox VPS", url: `http://127.0.0.1:${bPort}`, key, mcp: "servers" }],
  });
  const result = await syncFederation(path, aRun, config, aEnv);
  for (const source of ["group", "relay-a", "relay-b"]) assert.ok(result.providers.some((provider) => provider.source === source));
  assert.deepEqual(result.mcp.map((item) => item.namespace), ["docs", "github"]);
  process.stdout.write(`Discovered ${result.providers.length} separate providers and two MCP namespaces.\n`);
  const pluginRows = await command(aRun, "plugin", "--json");
  for (const provider of result.providers) assert.ok(pluginRows.includes(provider.name), `missing native provider name ${provider.name}`);
  const expected = result.providers.filter((provider) => provider.source.startsWith("relay-"));
  for (const provider of expected) {
    await eventually(async () => {
      const response = await fetch(`http://127.0.0.1:${aPort}/v1/models`);
      const list = await response.json() as { data: { id: string; display_name?: string; magpie_label?: string }[] };
      const model = list.data.find((model) => model.id === `${provider.id}/${provider.source}/shared-model`);
      assert.ok(model, `missing native model for ${provider.source}`);
      assert.match(JSON.stringify(model), new RegExp(provider.source));
    }, 60_000);
    const response = await fetch(`http://127.0.0.1:${aPort}/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: `${provider.id}/${provider.source}/shared-model`, messages: [{ role: "user", content: "hello" }] }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json() as { choices: { message: { content: string } }[] };
    const source = provider.source === "relay-a" ? "a" : "b";
    assert.equal(body.choices[0]?.message.content, `from-${source}`);
  }
  assert.ok(upstreamCalls.some((call) => call.source === "a"));
  assert.ok(upstreamCalls.some((call) => call.source === "b"));
  process.stdout.write("Native gateway calls reached each corresponding remote supplier.\n");
  const first = expected.find((provider) => provider.source === "relay-a")!;
  const streamed = await fetch(`http://127.0.0.1:${aPort}/v1/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: `${first.id}/relay-a/shared-model`, stream: true, messages: [{ role: "user", content: "hello" }] }),
  });
  assert.equal(streamed.status, 200);
  assert.match(await streamed.text(), /from-a/);
  failFirstSource = true;
  const group = result.providers.find((provider) => provider.source === "group")!;
  const fallback = await fetch(`http://127.0.0.1:${aPort}/v1/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: `${group.id}/group/remote-pool`, messages: [{ role: "user", content: "hello" }] }),
  });
  assert.equal(fallback.status, 200, await fallback.clone().text());
  const fallbackBody = await fallback.json() as { choices: { message: { content: string } }[] };
  assert.equal(fallbackBody.choices[0]?.message.content, "from-b");
  failFirstSource = false;
  process.stdout.write("Streaming remained intact and the remote routing group handled a failed supplier.\n");
  const settings = await loadFederation(path);
  for (const item of result.mcp) {
    await eventually(async () => {
      const response = await fetch(mcpUrl(settings, item), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      assert.equal(response.status, 200);
      const value = await response.json() as { result: { tools: { name: string }[] } };
      assert.deepEqual(value.result.tools.map((tool) => tool.name), [`${item.namespace}__lookup`]);
    }, 60_000);
    const response = await fetch(mcpUrl(settings, item), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: `${item.namespace}__lookup`, arguments: {} } }),
    });
    assert.equal(response.status, 200);
    const value = await response.json() as { result: { content: { text: string }[] } };
    assert.equal(value.result.content[0]?.text, `tool-from-${item.namespace}`);
  }
  process.stdout.write("Each native MCP entry listed and called only its own namespace.\n");
  await syncFederation(path, aRun, undefined, aEnv);
  const providers = JSON.parse(await readFile(join(aEnv.XDG_CONFIG_HOME!, "magpie", "plugin-providers.json"), "utf8"));
  const serialized = JSON.stringify(providers);
  for (const provider of result.providers) assert.ok(serialized.includes(provider.id));
  process.stdout.write("A repeated sync completed successfully.\n");
  process.stdout.write("Federation E2E passed using two isolated Magpie instances.\n");
  completed = true;
} catch (error) {
  process.stderr.write(`E2E failed. Sandbox logs are in ${root}\n`);
  throw error;
} finally {
  upstream.stop(true);
  for (const child of children) child.kill();
  await Promise.all(children.map((child) => child.exited));
  if (completed) await rm(root, { recursive: true, force: true });
}
