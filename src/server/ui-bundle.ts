// The page's script, built from TypeScript by the Bun the plugin host runs
// on, once per process: no build step for users, no stale bundle to ship.

import { fileURLToPath } from "node:url";

const ENTRY = fileURLToPath(new URL("../ui/main.ts", import.meta.url));
let bundle: Promise<string> | undefined;

async function build(): Promise<string> {
  const result = await Bun.build({ entrypoints: [ENTRY], target: "browser", format: "iife", minify: true });
  const output = result.outputs[0];
  if (!result.success || !output) throw new Error(result.logs.map(String).join("\n") || "页面脚本构建失败");
  return output.text();
}

export function uiBundle(): Promise<string> {
  bundle ??= build().catch((error) => {
    bundle = undefined;
    throw error;
  });
  return bundle;
}
