import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { suspensionPlan } from "../src/federation/activity.ts";
import { loadFederation, parseFederation, saveFederation, writePrivate } from "../src/federation/config.ts";
import { syncFederation } from "../src/federation/install.ts";
import { providerHandler } from "../src/federation/proxy.ts";
import { mcpHandler } from "../src/federation/mcp.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("starts new configurations in Lite and retains the legacy full default", () => {
  expect(parseFederation({})).toMatchObject({ enabled: true, mode: "lite" });
  expect(parseFederation({ servers: [{ id: "vps", url: "https://example.com" }] }).mode).toBe("full");
  expect(parseFederation({ mode: "lite", servers: [{ id: "vps", url: "https://example.com" }] }).mode).toBe("lite");
  expect(() => parseFederation({ mode: "other" })).toThrow();
  expect(() => parseFederation({ enabled: "false" })).toThrow();
});

test("pauses only managed entries and preserves richer MCP settings", () => {
  const result = suspensionPlan(
    [{ id: "managed-on" }, { id: "managed-off" }],
    [{ name: "simple", url: "http://127.0.0.1/simple" }, { name: "customized", url: "http://127.0.0.1/customized" }],
    [{ id: "managed-on" }, { id: "managed-off", off: true }, { id: "other" }],
    [
      { name: "simple", url: "http://127.0.0.1/simple", transport: "http", local: true, agents: ["codex"] },
      { name: "customized", url: "http://127.0.0.1/customized", agents: ["claude-code"], disabledTools: ["delete"] },
      { name: "other", url: "https://example.com", agents: ["codex"] },
    ],
  );
  expect(result.commands).toEqual([
    ["provider", "off", "managed-on"],
    ["library", "mcp", "rm", "simple"],
    ["library", "mcp", "agents", "customized", "none"],
  ]);
  expect(result.suspension.providers).toEqual([{ id: "managed-on", wasOff: false }, { id: "managed-off", wasOff: true }]);
  expect(result.suspension.mcp).toEqual([
    { name: "simple", agents: ["codex"], removed: true },
    { name: "customized", agents: ["claude-code"], removed: false },
  ]);
  const again = suspensionPlan(
    [{ id: "managed-on" }], [], [{ id: "managed-on", off: true }], [], result.suspension,
  );
  expect(again.commands).toEqual([]);
  expect(again.suspension).toEqual(result.suspension);
});

test("Lite sync avoids remote discovery and installs only the dashboard runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "federation-mode-"));
  directories.push(root);
  const path = join(root, "magpie-federation", "config.json");
  const config = parseFederation({ mode: "lite", servers: [{ id: "vps", url: "http://127.0.0.1:9" }] });
  const commands: string[][] = [];
  await writePrivate(join(root, "magpie-federation", "installed.json"), JSON.stringify({
    providers: [{ id: "mf-owned", source: "relay", server: "vps", name: "Relay" }], mcp: [],
  }));
  await writePrivate(join(root, "magpie", "providers.json"), JSON.stringify({
    providers: [{ id: "mf-owned", preset: "remote-magpie" }, { id: "unrelated" }],
  }));
  const result = await syncFederation(path, async (args) => {
    commands.push([...args]);
    return { code: 0, stdout: "", stderr: "" };
  }, config, { XDG_CONFIG_HOME: root });
  expect(result).toMatchObject({ mode: "lite", enabled: true, providers: [], mcp: [] });
  expect(commands).toContainEqual(["provider", "off", "mf-owned"]);
  expect(commands.some((args) => args[0] === "provider" && args[1] === "add")).toBe(false);
  expect((await loadFederation(path)).mode).toBe("lite");
  const runtime = JSON.parse(await readFile(join(root, "magpie-federation", "runtime", "package.json"), "utf8"));
  expect(runtime.magpie.page.titles.zh).toBe("远端看板");
  expect(runtime.magpie.page.file).toBe("page/index.html");
  expect(await Bun.file(join(root, "magpie-federation", "runtime", "page", "dashboard.html")).exists()).toBe(true);
});

test("Lite and off refuse integration endpoints before forwarding", async () => {
  const root = await mkdtemp(join(tmpdir(), "federation-mode-"));
  directories.push(root);
  const path = join(root, "config.json");
  const config = parseFederation({ mode: "lite", token: "c".repeat(64), servers: [{ id: "vps", url: "http://127.0.0.1:9" }] });
  await saveFederation(config, path);
  const provider = providerHandler(path, 3487);
  const mcp = mcpHandler(path, 3487);
  const req = (route: string, init: RequestInit = {}) => new Request(`http://127.0.0.1:3487${route}`, {
    ...init, headers: { host: "127.0.0.1:3487", authorization: `Bearer ${config.token}` },
  });
  expect((await provider(req("/provider/vps/relay/v1/models"))).status).toBe(403);
  expect((await mcp(req(`/mcp/${config.token}/vps`, { method: "POST", body: "{}" }))).status).toBe(403);
  config.mode = "full";
  config.enabled = false;
  await saveFederation(config, path);
  expect((await provider(req("/provider/vps/relay/v1/models"))).status).toBe(403);
});
