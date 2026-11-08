// Everything the plugin runs on one machine: the page's service, always, and
// the peer API when this machine's configuration offers its pools.

import { join } from "node:path";
import type { Env } from "../machine/cli.ts";
import { gatewayClient } from "../machine/gateway.ts";
import { gatewayBase, stateDir } from "../machine/locate.ts";
import { localPools } from "../machine/local.ts";
import { keyVerifier } from "../peer/auth.ts";
import { startPeer, type RunningPeer } from "../peer/server.ts";
import { loadPeerConfig } from "./config.ts";
import { frameAncestorsOf, startConsole, type RunningConsole } from "./console.ts";
import { version } from "./listen.ts";

export interface Services {
  readonly console: RunningConsole;
  readonly peer?: RunningPeer;
  stop(): void;
}

export async function startServices(options: Record<string, unknown> = {}, env: Env = process.env): Promise<Services> {
  if (!options || typeof options !== "object") throw new TypeError("options must be an object");
  const configOptions = options.config === undefined ? {} : { config: options.config };
  const pools = localPools(env, typeof options.magpieBin === "string" ? options.magpieBin : undefined);
  const peerConfig = await loadPeerConfig(configOptions, env);
  const consoleService = await startConsole({
    ...configOptions,
    port: options.port,
    pools,
    frameAncestors: frameAncestorsOf(options.frameAncestors),
    routesPath: join(stateDir(env), "routes.jsonl"),
    gatewayBase: gatewayBase(env),
  });
  let peer: RunningPeer | undefined;
  try {
    peer = peerConfig
      ? await startPeer({
          host: peerConfig.host,
          port: peerConfig.port,
          basePath: peerConfig.basePath,
          version: version(),
          service: pools,
          verify: keyVerifier(gatewayClient(gatewayBase(env)), peerConfig.writers),
        })
      : undefined;
  } catch (error) {
    consoleService.stop();
    throw new Error(`无法在 ${peerConfig?.host}:${peerConfig?.port} 启动 peer 接口：${(error as Error).message}`);
  }
  return {
    console: consoleService,
    ...(peer ? { peer } : {}),
    stop() {
      consoleService.stop();
      peer?.stop();
    },
  };
}
