#!/usr/bin/env bun
import { configurationPath, loadFederation, parseFederation } from "../src/federation/config.ts";
import { syncFederation, withConfigurationLock } from "../src/federation/install.ts";

const [command = "help", id, ...assignments] = process.argv.slice(2);
const path = configurationPath();

try {
  if (["connect", "sync", "mode", "on", "off", "settings"].includes(command)) {
    const result = await withConfigurationLock(path, async () => {
      const config = await loadFederation(path);
      if (command === "mode") {
        if (id !== "lite" && id !== "full") throw new Error("mode 需要 lite 或 full");
        config.mode = id;
      }
      if (command === "on" || command === "off") config.enabled = command === "on";
      if (command === "settings") {
        let settings: unknown;
        try { settings = JSON.parse(id ?? ""); } catch { throw new Error("设置必须是 JSON"); }
        if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error("设置必须是对象");
        const values = settings as Record<string, unknown>;
        if (typeof values.enabled !== "boolean" || (values.mode !== "lite" && values.mode !== "full")) throw new Error("设置需要 enabled 和 mode");
        config.enabled = values.enabled;
        config.mode = values.mode;
      }
      if (command === "connect") {
        if (!id) throw new Error("connect 需要服务器 id");
        const fields: Record<string, unknown> = { id };
        for (const assignment of assignments) {
          const equals = assignment.indexOf("=");
          if (equals < 1) throw new Error("选项需要使用 name=value 形式");
          const key = assignment.slice(0, equals);
          const value = assignment.slice(equals + 1);
          if (!["name", "url", "keyEnv", "mcp", "providers"].includes(key)) throw new Error(`未知选项 ${key}`);
          fields[key] = key === "providers" ? value.split(",").filter(Boolean) : key === "mcp" && value === "off" ? false : value;
        }
        const previous = config.servers.find((server) => server.id === id);
        const server = parseFederation({ servers: [{ ...previous, ...fields }] }).servers[0]!;
        config.servers = [...config.servers.filter((item) => item.id !== id), server];
      }
      return syncFederation(path, undefined, config);
    });
    process.stdout.write(result.enabled
      ? result.mode === "lite" ? "远端看板已就绪（Lite 模式）。\n" : `${result.providers.length} 个供应商已分别接入 Magpie，${result.mcp.length} 个 MCP 入口已加入资源库。\n`
      : "远端连接已关闭。\n");
    for (const provider of result.providers) process.stdout.write(`  ${provider.name} (${provider.id})\n`);
    for (const mcp of result.mcp) process.stdout.write(`  ${mcp.name}\n`);
    for (const warning of result.warnings) process.stderr.write(`${warning}\n`);
  } else {
    process.stdout.write([
      "magpie-federation",
      "",
      "  connect <server> url=https://... keyEnv=REMOTE_MAGPIE_KEY [name=...] [providers=codex,deepseek] [mcp=hub|servers|off]",
      "  sync",
      "  mode lite|full",
      "  on|off",
      "",
      "供应商分别出现在 Magpie 原生列表，在各自的编辑页展开模型。",
      "mcp=hub 接入整台远端的 MCP，mcp=servers 按远端工具命名空间分别接入。",
      "MCP 初次加入时不分配 Agent，在资源库选择使用它的 Agent。",
      "Lite 只启用自动连接的远端看板，完整模式启用供应商与 MCP 接入。",
      `配置文件为 ${path}`,
      "",
    ].join("\n"));
  }
} catch (error) {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exitCode = 1;
}
