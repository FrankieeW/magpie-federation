// The console's view of every machine's pools: this one's directly, each
// configured remote's through the plugin's peer API there. A remote that
// fails is shown in its own state; it never hides the others.

import type { MachineView, PoolOp } from "../shared/api.ts";
import type { Applied, PlannedChange, PoolService } from "../machine/pools.ts";
import { peerClient as defaultPeerClient, type PeerClient } from "../peer/client.ts";
import type { RemoteConfig } from "./config.ts";
import { InspectorError } from "./errors.ts";

export interface PoolsApi {
  machines(): Promise<MachineView[]>;
  preview(machine: string, pool: string, op: PoolOp): Promise<PlannedChange>;
  apply(machine: string, pool: string, op: PoolOp, expected: readonly string[]): Promise<Applied>;
  undo(machine: string, change: string): Promise<Applied>;
}

type ClientFactory = (base: string, key: string | undefined) => PeerClient;

const UNCONFIGURED = "在这台远端也安装本插件并开启 peer 接口，再在本机配置中为它填写 peer，即可在这里查看和修改它的池子。";

function empty(remote: RemoteConfig, state: MachineView["state"], message: string): MachineView {
  return { id: remote.id, name: remote.name, state, message, writable: false, pools: [], candidates: [], changes: [] };
}

export function poolsApi(local: PoolService, remotes: () => Promise<readonly RemoteConfig[]>, makeClient: ClientFactory = defaultPeerClient): PoolsApi {
  const clientFor = async (machine: string): Promise<PeerClient> => {
    const remote = (await remotes()).find((item) => item.id === machine);
    if (!remote) throw new InspectorError("error", "未找到配置的远端", 404);
    if (!remote.peer) throw new InspectorError("unconfigured", UNCONFIGURED, 409);
    return makeClient(remote.peer, remote.key);
  };

  const remoteView = async (remote: RemoteConfig): Promise<MachineView> => {
    if (!remote.peer) return empty(remote, "unconfigured", UNCONFIGURED);
    const client = makeClient(remote.peer, remote.key);
    try {
      const [hello, snapshot] = await Promise.all([client.hello(), client.snapshot()]);
      const base = { id: remote.id, name: remote.name, state: "ready" as const, writable: hello.caller.canWrite, ...snapshot };
      const note = hello.caller.canWrite ? undefined : `密钥「${hello.caller.key}」只能查看：要修改，请在远端配置的 peer.writers 中加入它，并使用非只读、无预算限制的密钥。`;
      return { ...base, ...(note ? { message: note } : {}), ...(hello.magpieVersion ? { magpieVersion: hello.magpieVersion } : {}) };
    } catch (error) {
      const failure = error instanceof InspectorError ? error : new InspectorError("error", "读取远端池子失败");
      return empty(remote, failure.state === "conflict" ? "error" : failure.state, failure.message);
    }
  };

  return {
    async machines() {
      const localView = local.snapshot().then(
        (snapshot): MachineView => ({ id: "local", name: "本机", state: "ready", writable: true, ...snapshot }),
        (error): MachineView => {
          const failure = error instanceof InspectorError ? error : new InspectorError("error", "读取本机池子失败");
          return { id: "local", name: "本机", state: failure.state === "conflict" ? "error" : failure.state, message: failure.message, writable: false, pools: [], candidates: [], changes: [] };
        },
      );
      return Promise.all([localView, ...(await remotes()).map(remoteView)]);
    },
    async preview(machine, pool, op) {
      return machine === "local" ? local.preview(pool, op) : (await clientFor(machine)).preview(pool, op);
    },
    async apply(machine, pool, op, expected) {
      return machine === "local" ? local.apply(pool, op, expected, "local") : (await clientFor(machine)).apply(pool, op, expected);
    },
    async undo(machine, change) {
      return machine === "local" ? local.undo(change, "local") : (await clientFor(machine)).undo(change);
    },
  };
}
