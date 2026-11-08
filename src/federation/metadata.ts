import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Env } from "../machine/cli.ts";
import { boundedJson, remoteRequest } from "./catalog.ts";
import { isRecord, type ServerConfig } from "./config.ts";

export interface ProviderMetadata {
  icon?: string;
  iconSource?: "remote" | "builtin";
  warnings: string[];
}

// These are Magpie's own bundled icon names. An explicit remote icon wins.
const builtins: Readonly<Record<string, string>> = {
  auto: "magpie", group: "magpie", openai: "openai", codex: "codex-color",
  "chatgpt-api": "openai", deepseek: "deepseek-color", anthropic: "anthropic",
  claude: "claudecode-color", google: "gemini-color", gemini: "gemini-color",
  grok: "xai", xai: "xai", nvidia: "nvidia-color", openrouter: "openrouter",
  "minimax-cn": "minimax-color", "minimax-code": "minimax-color",
  "opencode-go": "opencode", "opencode-zen": "opencode",
  "opencode-zen-free": "opencode", zcode: "zcode",
};

async function optionalJson(server: ServerConfig, path: string): Promise<unknown> {
  try {
    const response = await remoteRequest(server, path, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) {
      await response.body?.cancel();
      return undefined;
    }
    return await boundedJson(response);
  } catch {
    return undefined;
  }
}

export async function discoverMetadata(server: ServerConfig): Promise<Map<string, ProviderMetadata>> {
  const [cards, usage] = await Promise.all([
    optionalJson(server, "magpie/quotas/cards"),
    optionalJson(server, "magpie/usage?period=all"),
  ]);
  const rows = [
    ...(isRecord(cards) && Array.isArray(cards.data) ? cards.data : []),
    ...(isRecord(usage) && Array.isArray(usage.models) ? usage.models : []),
    ...(isRecord(usage) && Array.isArray(usage.accounts) ? usage.accounts : []),
  ];
  const result = new Map<string, ProviderMetadata>();
  for (const row of rows) {
    if (!isRecord(row) || typeof row.provider !== "string" || typeof row.icon !== "string" || !row.icon) continue;
    if (!result.has(row.provider)) result.set(row.provider, { icon: row.icon, iconSource: "remote", warnings: [] });
  }
  return result;
}

/** Resolve Magpie's file references without assuming a remote file exists here. */
export async function inheritedIcon(
  server: ServerConfig,
  source: string,
  metadata: ProviderMetadata | undefined,
  configPath: string,
  env: Env,
): Promise<ProviderMetadata> {
  const fallback = builtins[source];
  const icon = metadata?.icon;
  if (!icon) return { ...(fallback ? { icon: fallback, iconSource: "builtin" as const } : {}), warnings: [] };
  if (/^[A-Za-z0-9_-]{1,80}$/.test(icon)) return metadata!;
  const file = /^file:([a-f0-9]{16}\.(?:png|jpg|gif|webp|ico|svg))$/.exec(icon);
  if (file) {
    const base = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config");
    if (await Bun.file(join(base, "magpie", "icons", file[1]!)).exists()) return metadata!;
    try {
      const response = await remoteRequest(server, `/api/icons/${file[1]}`, { signal: AbortSignal.timeout(5000) });
      if (response.ok) {
        const image = await boundedImage(response);
        const target = join(dirname(configPath), "icons", file[1]!);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, image, { mode: 0o600 });
        return { icon: target, iconSource: "remote", warnings: [] };
      }
      await response.body?.cancel();
    } catch {
      // A gateway can expose the reference while its GUI keeps the file private.
    }
  }
  const data = /^data:image\/([A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(icon);
  if (data) {
    const image = Buffer.from(data[2]!, "base64");
    if (image.length && image.length <= 1024 * 1024) {
      const suffix = data[1] === "svg+xml" ? "svg" : data[1] === "jpeg" ? "jpg" : data[1]!;
      if (["svg", "png", "jpg", "gif", "webp", "ico"].includes(suffix)) {
        const digest = createHash("sha256").update(image).digest("hex").slice(0, 16);
        const target = join(dirname(configPath), "icons", `${digest}.${suffix}`);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, image, { mode: 0o600 });
        return { icon: target, iconSource: "remote", warnings: [] };
      }
    }
  }
  return {
    ...(fallback ? { icon: fallback, iconSource: "builtin" as const } : {}),
    warnings: [`${server.name}/${source} 的自定义图标未能读取，远端需要提供可读取的图标文件`],
  };
}

async function boundedImage(response: Response): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty icon");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024 * 1024) throw new Error("Icon exceeds 1 MiB");
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}
