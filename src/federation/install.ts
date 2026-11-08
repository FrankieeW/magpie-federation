import { createHash } from "node:crypto";
import { cp, mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cliRunner, locateMagpie, type Env, type MagpieRunner } from "../machine/cli.ts";
import { gatewayBase } from "../machine/locate.ts";
import { discoverProviders, providerId } from "./catalog.ts";
import { configurationPath, isRecord, loadFederation, saveFederation, serverKey, writePrivate, type FederationConfig } from "./config.ts";
import { discoverMcp, mcpUrl, type McpDescriptor } from "./mcp.ts";
import type { ProviderDescriptor } from "./provider.ts";
import { discoverMetadata, inheritedIcon } from "./metadata.ts";
import { providerUrl } from "./proxy.ts";
import { parseSuspension, suspensionPlan } from "./activity.ts";

const SOURCE_ROOT = fileURLToPath(new URL("../", import.meta.url));

export interface SyncResult {
  providers: ProviderDescriptor[];
  mcp: McpDescriptor[];
  warnings: string[];
  enabled: boolean;
  mode: "lite" | "full";
}

interface NativeMcp {
  name: string;
  url: string;
  agents: string[];
}

async function nativeJson(env: Env, name: string): Promise<Record<string, unknown>> {
  const base = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config");
  try {
    const value: unknown = JSON.parse(await readFile(join(base, "magpie", name), "utf8"));
    if (!isRecord(value)) throw new Error("Invalid Magpie configuration");
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`无法读取 Magpie 的 ${name}`);
  }
}

async function waitForProxy(settings: FederationConfig, path: string, env: Env): Promise<void> {
  try {
    const gateway = await fetch(`${gatewayBase(env)}/v1`, { signal: AbortSignal.timeout(1000) });
    await gateway.body?.cancel();
    if (!gateway.ok) return;
  } catch {
    // Without a serving Magpie, each CLI starts the runtime for its own work.
    return;
  }
  const deadline = Date.now() + 20_000;
  const identity = createHash("sha256").update(path).digest("hex");
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${settings.port}/healthz`, { signal: AbortSignal.timeout(1000) });
      const value: unknown = await response.json();
      if (isRecord(value) && value.name === "magpie-federation" && value.providerProxy === true && value.config === identity) return;
    } catch {
      // The new plugin host is taking over from the previous one.
    }
    await Bun.sleep(150);
  }
  throw new Error(`Federation 转发服务没有在端口 ${settings.port} 就绪，请检查端口占用后重试 sync`);
}

async function nativeMcp(env: Env): Promise<NativeMcp[]> {
  const base = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config");
  const library = join(base, "magpie", "library.json");
  let value: unknown;
  try {
    value = JSON.parse(await readFile(library, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error("无法读取 Magpie 资源库，请修复 library.json 后重试");
  }
  if (!isRecord(value) || !Array.isArray(value.mcp)) return [];
  return value.mcp.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.name !== "string" || typeof entry.url !== "string") return [];
    return [{
      name: entry.name,
      url: entry.url,
      agents: Array.isArray(entry.agents) ? entry.agents.filter((agent): agent is string => typeof agent === "string") : [],
    }];
  });
}

async function runChecked(run: MagpieRunner, args: string[], secrets: string[]): Promise<string> {
  const result = await run(args);
  if (result.code !== 0) {
    let detail = result.stderr || result.stdout;
    for (const secret of secrets) detail = detail.split(secret).join("[REDACTED]");
    throw new Error(`magpie ${args.slice(0, 2).join(" ")} 失败（退出码 ${result.code}），可重新运行 sync\n${detail.trim().slice(-1500)}`);
  }
  return result.stdout;
}

async function installRuntime(path: string, settings: FederationConfig, env: Env, checked: (args: string[]) => Promise<string>) {
  const runtime = join(dirname(path), "runtime");
  const entry = `import { startFederation } from ${JSON.stringify(pathToFileURL(join(SOURCE_ROOT, "federation/mcp.ts")).href)};\nexport default { id: "magpie-federation", server: async () => { await startFederation(${JSON.stringify(path)}); return {}; } };\n`;
  let oldEntry: string | undefined;
  try {
    oldEntry = await readFile(join(runtime, "index.mjs"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const packageText = `${JSON.stringify({
    name: "magpie-federation", version: "0.5.0", type: "module", main: "index.mjs",
    magpie: {
      name: "远端连接",
      options: { port: settings.port },
      page: {
        title: "Remote Dashboard", titles: { zh: "远端看板" }, file: "page/index.html", icon: "page/icon.svg",
        service: { port: settings.port, option: "port" },
      },
    },
  }, null, 2)}\n`;
  let oldPackage: string | undefined;
  try {
    oldPackage = await readFile(join(runtime, "package.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (oldEntry !== entry || oldPackage !== packageText) {
    await cp(join(SOURCE_ROOT, "../page"), join(runtime, "page"), { recursive: true });
    await writePrivate(join(runtime, "package.json"), packageText);
    await writePrivate(join(runtime, "index.mjs"), entry);
  }
  const plugins = await nativeJson(env, "plugins.json");
  const specs = Array.isArray(plugins.plugins) ? plugins.plugins.filter(isRecord) : [];
  const existing = specs.find((plugin) => plugin.spec === runtime);
  if (existing?.off === true) await checked(["plugin", "on", runtime]);
  else if (existing && oldEntry !== entry) {
    await checked(["plugin", "off", runtime]);
    await checked(["plugin", "on", runtime]);
  } else await checked(["plugin", "add", runtime]);
  const options = isRecord(existing?.options) ? existing.options : {};
  if (options.port !== settings.port) await checked(["plugin", "options", runtime, JSON.stringify({ ...options, port: settings.port })]);
  return specs;
}

export async function withConfigurationLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lock = `${path}.lock`;
  let file;
  try {
    file = await open(lock, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new Error(`另一项 Federation 操作正在运行。若进程已退出，请移除 ${lock} 后重试`);
  }
  try {
    await file.writeFile(String(process.pid));
    return await action();
  } finally {
    await file.close();
    await unlink(lock);
  }
}

/**
 * Generate ordinary OpenCode/Magpie hooks. ESM exports are static, so the
 * discovered providers become separate exports in this managed local plugin.
 */
export function providerModule(path: string, descriptors: ProviderDescriptor[]): string {
  const factory = pathToFileURL(join(SOURCE_ROOT, "federation/provider.ts")).href;
  return [
    "// Generated by magpie-federation sync.",
    `import { createProvider } from ${JSON.stringify(factory)};`,
    ...descriptors.map((descriptor, index) =>
      `export const remote${index} = (input) => createProvider(input, ${JSON.stringify(path)}, ${JSON.stringify(descriptor)});`),
    ...(descriptors.length ? [] : ["export const empty = async () => ({});"]),
    "",
  ].join("\n");
}

export async function syncFederation(
  path = configurationPath(),
  run?: MagpieRunner,
  config?: FederationConfig,
  env: Env = process.env,
): Promise<SyncResult> {
  if (!config && !(await Bun.file(path).exists())) throw new Error("Federation 配置不存在，请先运行 connect 或恢复配置文件");
  const settings = config ?? await loadFederation(path);
  const bin = run ? null : locateMagpie(env);
  if (!run && !bin) throw new Error("找不到 magpie，请设置 MAGPIE_BIN");
  const execute = run ?? cliRunner(bin!, env, 90_000);
  const secrets = settings.servers.map((server) => serverKey(server, env)).filter((key): key is string => !!key);
  if (settings.token) secrets.push(settings.token);
  const checked = (args: string[]) => runChecked(execute, args, secrets);
  const statePath = join(dirname(path), "installed.json");
  let previous: Record<string, unknown> = {};
  let previousMcp: (McpDescriptor & { url?: string })[] = [];
  try {
    const state: unknown = JSON.parse(await readFile(statePath, "utf8"));
    if (isRecord(state)) previous = state;
    if (isRecord(state) && Array.isArray(state.mcp)) previousMcp = state.mcp.filter((entry): entry is McpDescriptor & { url?: string } =>
      isRecord(entry) && typeof entry.name === "string" && typeof entry.server === "string");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("无法读取 Federation 的 installed.json");
  }
  const library = await nativeMcp(env);
  const suspension = parseSuspension(previous.suspension);
  if (!settings.enabled || settings.mode === "lite") {
    const native = await nativeJson(env, "providers.json");
    const nativeLibrary = await nativeJson(env, "library.json");
    const managedProviders = Array.isArray(previous.providers) ? previous.providers.filter((provider): provider is ProviderDescriptor =>
      isRecord(provider) && typeof provider.id === "string" && typeof provider.server === "string" &&
      typeof provider.source === "string" && typeof provider.name === "string") : [];
    const plan = suspensionPlan(
      managedProviders, previousMcp,
      Array.isArray(native.providers) ? native.providers.filter(isRecord) : [],
      Array.isArray(nativeLibrary.mcp) ? nativeLibrary.mcp.filter(isRecord) : [],
      suspension,
    );
    await saveFederation(settings, path);
    if (!secrets.includes(settings.token)) secrets.push(settings.token);
    await writePrivate(statePath, `${JSON.stringify({ ...previous, providers: managedProviders, mcp: previousMcp, suspension: plan.suspension, pending: true }, null, 2)}\n`);
    const specs = await installRuntime(path, settings, env, checked);
    const legacy = join(dirname(path), "providers");
    if (specs.some((plugin) => plugin.spec === legacy && plugin.off !== true)) await checked(["plugin", "off", legacy]);
    for (const command of plan.commands) await checked(command);
    if (!run || env.MAGPIE_ADDR !== undefined) await waitForProxy(settings, path, env);
    await writePrivate(statePath, `${JSON.stringify({
      ...previous, providers: managedProviders, mcp: previousMcp, suspension: plan.suspension,
      enabled: settings.enabled, mode: settings.mode, pending: false,
    }, null, 2)}\n`);
    return { providers: [], mcp: [], warnings: [], enabled: settings.enabled, mode: settings.mode };
  }
  // Complete discovery before changing the managed plugin.
  const discovered = await Promise.all(settings.servers.map(async (server) => {
    const effective = { ...server, keyEnv: undefined, key: serverKey(server, env) };
    const [providers, mcp, metadata] = await Promise.all([
      discoverProviders(effective, fetch, undefined, false),
      discoverMcp(effective),
      discoverMetadata(effective),
    ]);
    return { server, providers: providers.filter((provider) => !server.providers || server.providers.includes(provider.id)), mcp, metadata };
  }));
  const warnings: string[] = [];
  const providers = (await Promise.all(discovered.map(async ({ server, providers: sources, metadata }) =>
    Promise.all(sources.map(async (source): Promise<ProviderDescriptor> => {
      const icon = await inheritedIcon(server, source.id, metadata.get(source.id), path, env);
      warnings.push(...icon.warnings);
      return {
        id: providerId(server.id, source.id),
        server: server.id,
        source: source.id,
        name: `${source.name} · ${server.name}`,
        ...(icon.icon ? { icon: icon.icon, iconSource: icon.iconSource } : {}),
      };
    })),
  ))).flat();
  const mcp = discovered.flatMap((item) => item.mcp);
  const native = await nativeJson(env, "providers.json");
  const saved = Array.isArray(native.providers) ? native.providers.filter(isRecord) : [];
  for (const provider of providers) {
    const existing = saved.find((item) => item.id === provider.id);
    if (existing && existing.preset !== "remote-magpie") {
      throw new Error(`${provider.id} 已有其他原生供应商配置，请先解决名称冲突后重试`);
    }
  }
  await saveFederation(settings, path);
  if (!secrets.includes(settings.token)) secrets.push(settings.token);
  const generated = join(dirname(path), "providers");
  const fingerprint = createHash("sha256").update(JSON.stringify(providers)).digest("hex");
  const plannedMcp = mcp.map((item) => ({ ...item, url: mcpUrl(settings, item) }));
  const managed = new Map([...previousMcp, ...plannedMcp].map((item) => [item.name, item]));
  // Journal both the previous and intended entries before native changes.
  // A retry can recognize partial additions and finish obsolete-entry cleanup.
  await writePrivate(statePath, `${JSON.stringify({ providers, mcp: [...managed.values()], fingerprint, pending: true }, null, 2)}\n`);
  const specs = await installRuntime(path, settings, env, checked);
  if (specs.some((plugin) => plugin.spec === generated)) {
    await checked(["plugin", "rm", generated]);
  }
  // Existing IDs and model IDs are reused when upgrading the former hooks.
  if (!run || env.MAGPIE_ADDR !== undefined) await waitForProxy(settings, path, env);
  for (const provider of providers) {
    const url = providerUrl(settings, provider.server, provider.source);
    const existing = saved.find((item) => item.id === provider.id);
    const fields = [`url=${url}`, `name=${provider.name}`, ...(provider.icon ? [`icon=${provider.icon}`] : [])];
    if (existing) {
      await checked(["provider", "set", provider.id, `key=${settings.token}`, ...fields]);
      if (existing.off === true && suspension?.providers.some((item) => item.id === provider.id && !item.wasOff)) {
        await checked(["provider", "on", provider.id]);
      }
      await checked(["provider", "refresh", provider.id]);
    } else {
      await checked(["provider", "add", "remote-magpie", settings.token, `id=${provider.id}`, ...fields]);
    }
  }
  for (const item of mcp) {
    const url = mcpUrl(settings, item);
    const existing = library.find((entry) => entry.name === item.name);
    if (existing) {
      if (existing.url !== url) throw new Error(`资源库中 ${item.name} 已使用其他地址，请在资源库中更新或重命名该条目后重试`);
      const paused = suspension?.mcp.find((entry) => entry.name === item.name);
      if (paused?.agents.length && existing.agents.length === 0) await checked(["library", "mcp", "agents", item.name, paused.agents.join(",")]);
      continue;
    }
    const inherited = previousMcp.filter((entry) => entry.server === item.server).flatMap((entry) => {
      const native = library.find((native) => native.name === entry.name && native.url === (entry.url ?? mcpUrl(settings, entry)));
      return native?.agents ?? [];
    });
    const agents = suspension?.mcp.find((entry) => entry.name === item.name)?.agents.join(",") || [...new Set(inherited)].join(",") || "none";
    await checked(["library", "mcp", "add", item.name, url, `agents=${agents}`, "--local"]);
  }
  for (const item of previousMcp) {
    if (mcp.some((current) => current.name === item.name)) continue;
    const existing = (await nativeMcp(env)).find((entry) => entry.name === item.name && entry.url === (item.url ?? mcpUrl(settings, item)));
    if (existing) await checked(["library", "mcp", "rm", item.name]);
  }
  await writePrivate(statePath, `${JSON.stringify({ providers, mcp: plannedMcp, fingerprint, enabled: settings.enabled, mode: settings.mode }, null, 2)}\n`);
  return { providers, mcp, warnings, enabled: settings.enabled, mode: settings.mode };
}
