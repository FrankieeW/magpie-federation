// Browser end-to-end check of the page against two real (sandboxed) Magpies,
// set up as in README "开发与端到端验证": a console on this machine's side and
// a peer on the other. Usage:
//
//   E2E_CONSOLE=http://127.0.0.1:3613/ E2E_LOCAL_PROVIDERS=… E2E_REMOTE_PROVIDERS=… \
//   E2E_REMOTE_ID=nb E2E_SESSION=… bun scripts/e2e-ui.ts
//
// Every change it makes through the page is checked against the Magpies'
// own providers.json, and undone before it ends.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";

const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} 未设置`);
  return value;
};

function chromiumPath(): string {
  if (process.env.E2E_CHROMIUM) return process.env.E2E_CHROMIUM;
  const cache = join(homedir(), "Library/Caches/ms-playwright");
  for (const dir of readdirSync(cache).filter((d) => d.startsWith("chromium-")).sort().reverse()) {
    for (const arch of ["chrome-mac-arm64", "chrome-mac"]) {
      const path = join(cache, dir, arch, "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
      if (existsSync(path)) return path;
    }
  }
  throw new Error("找不到 Playwright 的 Chromium；请设置 E2E_CHROMIUM");
}

const members = (file: string, pool: string): string[] =>
  (JSON.parse(readFileSync(file, "utf8")).groups as { id: string; members: string[] }[]).find((g) => g.id === pool)?.members ?? [];

function check(condition: boolean, what: string): void {
  if (!condition) throw new Error(`E2E 失败：${what}`);
  process.stdout.write(`  ✓ ${what}\n`);
}

async function waitFor(what: string, test: () => boolean, timeoutMs = 15_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (test()) return check(true, what);
    await Bun.sleep(200);
  }
  check(false, what);
}

async function confirmPreview(page: Page, command: string): Promise<void> {
  const dialog = page.locator("#pool-dialog");
  await dialog.locator(".command").waitFor();
  check((await dialog.locator(".command").textContent())?.includes(command) === true, `预览显示将执行的命令：${command}`);
  await dialog.getByRole("button", { name: "确认修改" }).click();
  await page.locator("#pools-message").filter({ hasText: "已更新" }).waitFor();
}

async function undoLatest(page: Page, machine: string): Promise<void> {
  const card = page.locator(".machine", { has: page.locator("h2", { hasText: machine }) });
  await card.locator("details.changes summary").click();
  await card.locator(".change").first().getByRole("button", { name: "撤销" }).click();
  await page.locator("#pools-message").filter({ hasText: "已撤销" }).waitFor();
}

const consoleUrl = env("E2E_CONSOLE");
const localProviders = env("E2E_LOCAL_PROVIDERS");
const remoteProviders = env("E2E_REMOTE_PROVIDERS");
const remoteId = env("E2E_REMOTE_ID");
const shots = process.env.E2E_SHOTS ?? "/tmp";

const browser = await chromium.launch({ executablePath: chromiumPath(), headless: true });
const errors: string[] = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 400) errors.push(`HTTP ${response.status()} ${new URL(response.url()).pathname}`);
  });
  await page.goto(`${consoleUrl}?theme=dark`);
  check((await page.locator("html").getAttribute("data-theme")) === "dark", "页面采用宿主传入的深色主题");

  process.stdout.write("模型池\n");
  await page.getByRole("tab", { name: "模型池" }).click();
  await page.locator(".machine").nth(1).waitFor();
  const names = await page.locator(".machine h2").allTextContents();
  check(names.length === 2 && names[0] === "本机", `显示两台机器：${names.join("、")}`);
  const remoteCard = page.locator(".machine").nth(1);
  check((await remoteCard.textContent())?.includes("可修改") === true, "远端经 peer 连接且可修改");

  const localCard = page.locator(".machine").first();
  const poolC = localCard.locator(".pool", { has: page.locator("code", { hasText: "group/pool-c" }) });
  const before = members(localProviders, "pool-c");
  await poolC.getByRole("button", { name: "＋ 加入成员" }).click();
  await page.locator("#pool-dialog input[type=search]").fill("pool-b");
  const offer = page.locator("#pool-dialog .candidate", { has: page.locator("code", { hasText: `${remoteId}/group/pool-b` }) });
  check((await offer.count()) === 1, `候选中有远端池子 ${remoteId}/group/pool-b`);
  await offer.getByRole("button", { name: "加入" }).click();
  await confirmPreview(page, `models+=${remoteId}/group/pool-b`);
  await waitFor("本机 providers.json 中 pool-c 加入了远端池子", () => members(localProviders, "pool-c").at(-1) === `${remoteId}/group/pool-b`);
  await page.screenshot({ path: join(shots, "e2e-pools.png"), fullPage: true });
  await undoLatest(page, "本机");
  await waitFor("撤销后本机 pool-c 恢复原样", () => JSON.stringify(members(localProviders, "pool-c")) === JSON.stringify(before));

  const remoteBefore = members(remoteProviders, "pool-b");
  const first = remoteBefore[0] ?? "";
  const poolB = remoteCard.locator(".pool", { has: page.locator("code", { hasText: "group/pool-b" }) });
  await poolB.getByRole("button", { name: `下移 ${first}` }).click();
  await confirmPreview(page, "group set pool-b models=");
  await waitFor("远端 providers.json 中 pool-b 的顺序已调整", () => members(remoteProviders, "pool-b")[1] === first);
  await undoLatest(page, names[1] ?? "");
  await waitFor("撤销后远端 pool-b 恢复原样", () => JSON.stringify(members(remoteProviders, "pool-b")) === JSON.stringify(remoteBefore));

  const session = process.env.E2E_SESSION;
  if (session) {
    process.stdout.write("路由观测\n");
    await page.getByRole("tab", { name: "路由观测" }).click();
    await page.locator("#remote-select:not([disabled])").waitFor();
    await page.locator("#session-input").fill(session);
    await page.getByRole("button", { name: "添加观测" }).click();
    const card = page.locator(".observation").first();
    await card.locator(".flow-step.responder").waitFor({ timeout: 20_000 });
    const responder = (await card.locator(".flow-step.responder .flow-value").textContent()) ?? "";
    check(responder.includes("/"), `最终回答者带上供应商：${responder}`);
    check((await card.locator(".attempt-fail").first().textContent())?.includes("限流") === true, "失败原因显示为可读文字");
    await page.screenshot({ path: join(shots, "e2e-observe.png"), fullPage: true });
  }
  process.stdout.write("嵌入防护\n");
  const foreign = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(`<!doctype html><iframe src="${consoleUrl}" width="900" height="700"></iframe>`, { headers: { "content-type": "text/html" } }),
  });
  try {
    const attacker = await browser.newPage();
    await attacker.goto(`http://127.0.0.1:${foreign.port}/`);
    await attacker.waitForTimeout(1500);
    const framed = attacker.frames().find((frame) => frame !== attacker.mainFrame());
    const rendered = framed ? await framed.locator("#tab-pools").count().catch(() => 0) : 0;
    check(rendered === 0, "其他网站嵌入控制台时页面不渲染（frame-ancestors 生效）");
    await attacker.close();
  } finally {
    foreign.stop(true);
  }
  check(errors.length === 0, `页面没有脚本错误${errors.length ? `：${errors.join(" | ")}` : ""}`);
} finally {
  await browser.close();
}
