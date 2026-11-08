// Two isolated Magpies for end-to-end checks — A plays this computer, B a
// remote one — each with its own HOME, XDG directories and gateway port, so
// the real Magpie, its config and the agents it wires are never touched.
//
//   bun scripts/sandbox.ts up   [root]   # set up, start, print the E2E command
//   bun scripts/sandbox.ts down [root]   # stop what `up` started
//
// Automatic updates are turned off in both first: an update installs over
// the app the sandbox runs from.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, "");
const ROOT = process.argv[3] ?? "/tmp/mri-sandbox";
const MAGPIE = process.env.MAGPIE_BIN ?? (Bun.which("magpie") || "/Applications/magpie.app/Contents/MacOS/magpie");
const UPSTREAM_PORT = 3790;
const A = { name: "a", gateway: 3711, console: 3713 };
const B = { name: "b", gateway: 3721, console: 3723, peer: 3724 };
type Box = typeof A;

const UPSTREAM = `const MODELS = { a: ["a1", "a2"], b: ["b1", "b2"], fail: ["f1"] };
Bun.serve({ hostname: "127.0.0.1", port: ${UPSTREAM_PORT}, async fetch(request) {
  const url = new URL(request.url); const tag = url.pathname.split("/")[1]; const models = MODELS[tag];
  if (!models) return new Response("not found", { status: 404 });
  if (url.pathname.endsWith("/models")) return Response.json({ object: "list", data: models.map((id) => ({ id, object: "model" })) });
  if (tag === "fail") return Response.json({ error: { type: "rate_limit_error", message: "sandbox 429" } }, { status: 429 });
  const body = await request.json().catch(() => ({}));
  return Response.json({ id: "sandbox-" + tag + "-" + crypto.randomUUID(), object: "chat.completion", created: 0, model: body.model ?? models[0],
    choices: [{ index: 0, message: { role: "assistant", content: "answered by " + tag }, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } });
} });`;

const dir = (box: Box, sub = "") => join(ROOT, box.name, sub);

function envFor(box: Box): Record<string, string> {
  return {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin",
    HOME: dir(box, "home"),
    USER: process.env.USER ?? "sandbox",
    XDG_CONFIG_HOME: dir(box, "config"),
    XDG_CACHE_HOME: dir(box, "cache"),
    XDG_DATA_HOME: dir(box, "data"),
    XDG_STATE_HOME: dir(box, "state"),
    MAGPIE_ADDR: `127.0.0.1:${box.gateway}`,
  };
}

function magpie(box: Box, ...args: string[]): string {
  const run = Bun.spawnSync([MAGPIE, ...args], { env: envFor(box), stdout: "pipe", stderr: "pipe" });
  const out = run.stdout.toString();
  if (run.exitCode !== 0) throw new Error(`magpie ${args[0]} ${args[1] ?? ""} (${box.name}): ${run.stderr.toString().trim() || out.trim()}`);
  return out;
}

function background(name: string, command: string[], env: Record<string, string>): void {
  const child = Bun.spawn(command, { env, stdout: Bun.file(join(ROOT, `${name}.log`)), stderr: Bun.file(join(ROOT, `${name}.err.log`)), stdin: "ignore" });
  child.unref();
  writeFileSync(join(ROOT, `${name}.pid`), String(child.pid));
}

async function waitPort(port: number, path = "/", seconds = 30): Promise<void> {
  for (let i = 0; i < seconds * 4; i += 1) {
    try {
      await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(500) });
      return;
    } catch {
      await Bun.sleep(250);
    }
  }
  throw new Error(`端口 ${port} 没有在 ${seconds} 秒内就绪`);
}

function newKey(box: Box, name: string): string {
  const key = magpie(box, "gateway-key", "add", name).trim().split(/\s+/).find((word) => word.startsWith("sk-"));
  if (!key) throw new Error(`没有读到 ${box.name} 新建的网关密钥`);
  return key;
}

function writeConfig(box: Box, value: unknown): void {
  const path = dir(box, "config/magpie-route-inspector");
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "config.json"), JSON.stringify(value, null, 2), { mode: 0o600 });
}

async function up(): Promise<void> {
  if (existsSync(join(ROOT, "a.pid"))) throw new Error(`${ROOT} 已有运行中的沙箱，请先 down`);
  for (const box of [A, B]) for (const sub of ["home", "config", "cache", "data", "state"]) mkdirSync(dir(box, sub), { recursive: true });
  writeFileSync(join(ROOT, "upstream.mjs"), UPSTREAM);
  background("upstream", [process.execPath, join(ROOT, "upstream.mjs")], { PATH: process.env.PATH ?? "" });
  await waitPort(UPSTREAM_PORT, "/a/v1/models");

  for (const box of [A, B]) magpie(box, "update", "auto", "off");
  magpie(B, "provider", "add", "Up B", `url=http://127.0.0.1:${UPSTREAM_PORT}/b/v1`, "key=sk-sandbox-b", "models=b1,b2", "id=upb");
  magpie(B, "provider", "add", "Fail B", `url=http://127.0.0.1:${UPSTREAM_PORT}/fail/v1`, "key=sk-sandbox-f", "models=f1", "id=failb");
  magpie(B, "group", "add", "Pool B", "models=failb/f1,upb/b1", "routing=order");
  magpie(A, "provider", "add", "Up A", `url=http://127.0.0.1:${UPSTREAM_PORT}/a/v1`, "key=sk-sandbox-a", "models=a1,a2", "id=upa");
  magpie(A, "group", "add", "Pool C", "models=upa/a1", "routing=order");
  const keyForA = newKey(B, "laptop");
  const keyForB = newKey(A, "vps");

  for (const box of [A, B]) background(`serve-${box.name}`, [MAGPIE, "serve"], envFor(box));
  await Promise.all([waitPort(A.gateway, "/v1/models"), waitPort(B.gateway, "/v1/models")]);
  magpie(A, "provider", "add", "remote-magpie", keyForA, `url=http://127.0.0.1:${B.gateway}`, "id=nb");
  magpie(B, "provider", "add", "remote-magpie", keyForB, `url=http://127.0.0.1:${A.gateway}`, "id=la");

  writeConfig(B, { peer: { listen: `127.0.0.1:${B.peer}`, writers: ["laptop"] } });
  writeConfig(A, { remotes: [{ id: "nb", name: "远端（沙箱 B）", url: `http://127.0.0.1:${B.gateway}`, key: keyForA, peer: `http://127.0.0.1:${B.peer}/inspector/` }] });
  for (const box of [B, A]) {
    magpie(box, "plugin", "add", PLUGIN);
    magpie(box, "plugin", "options", "magpie-route-inspector", JSON.stringify({ port: box.console }));
  }
  await Promise.all([waitPort(A.console, "/healthz", 60), waitPort(B.peer, "/v1/peer", 60)]);

  const session = "sandbox-fallback";
  await fetch(`http://127.0.0.1:${B.gateway}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: "Bearer magpie", "content-type": "application/json", "x-magpie-session": session },
    body: JSON.stringify({ model: "group/pool-b", messages: [{ role: "user", content: "hi" }] }),
  });
  process.stdout.write([
    `沙箱已就绪：${ROOT}`,
    `  本机（A）页面：http://127.0.0.1:${A.console}/`,
    `  远端（B）peer：http://127.0.0.1:${B.peer}/inspector/`,
    "端到端检查：",
    `  E2E_CONSOLE=http://127.0.0.1:${A.console}/ E2E_LOCAL_PROVIDERS=${dir(A, "config/magpie/providers.json")} E2E_REMOTE_PROVIDERS=${dir(B, "config/magpie/providers.json")} E2E_REMOTE_ID=nb E2E_SESSION=${session} bun scripts/e2e-ui.ts`,
    `停止：bun scripts/sandbox.ts down ${ROOT}`,
    "",
  ].join("\n"));
}

function down(): void {
  for (const name of ["serve-a", "serve-b", "upstream"]) {
    const file = join(ROOT, `${name}.pid`);
    if (!existsSync(file)) continue;
    try {
      process.kill(Number(readFileSync(file, "utf8")), "SIGTERM");
    } catch {
      // already gone
    }
    Bun.spawnSync(["rm", "-f", file]);
  }
  process.stdout.write(`已停止 ${ROOT} 中的沙箱进程（数据保留，删除目录即可清除）。\n`);
}

const command = process.argv[2];
if (command === "up") await up();
else if (command === "down") down();
else process.stdout.write("用法：bun scripts/sandbox.ts up|down [root]\n");
