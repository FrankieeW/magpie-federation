// This machine's pool service, wired to its own Magpie: providers.json for
// reading, the magpie CLI for writing, the gateway for what may join.

import { join } from "node:path";
import { cliRunner, locateMagpie, type Env, type MagpieRunner } from "./cli.ts";
import { gatewayClient } from "./gateway.ts";
import { readGroups } from "./groups.ts";
import { fileJournal } from "./journal.ts";
import { gatewayBase, providersPath, stateDir } from "./locate.ts";
import { poolService, type PoolService } from "./pools.ts";

const missingCli: MagpieRunner = async () => ({
  code: 127,
  stdout: "",
  stderr: "找不到 magpie 命令：请在插件宿主的环境中设置 MAGPIE_BIN 为 magpie 可执行文件的绝对路径",
});

export function localPools(env: Env, magpieBin?: string): PoolService {
  const bin = locateMagpie(env, magpieBin);
  const gateway = gatewayClient(gatewayBase(env));
  return poolService({
    readGroups: () => readGroups(providersPath(env)),
    listModels: () => gateway.models(),
    run: bin ? cliRunner(bin, env) : missingCli,
    journal: fileJournal(join(stateDir(env), "changes.jsonl")),
  });
}
