// Join one remote route to the local hop that forwarded it. A match is
// returned only when one hop is singled out — by the same response id, or
// by time and model when no response id contradicts it. Anything else is
// reported as ambiguous or unmatched, and is not used to add up cost.

import type { CostRollup, Link, Usage } from "../shared/observation.ts";

export interface HopRef {
  readonly routeId: number;
  readonly time: string;
  readonly responseId?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly ms?: number;
  readonly tries: readonly { readonly id: string; readonly model: string }[];
}

export interface RemoteRef {
  readonly remoteId: string;
  readonly time?: string;
  readonly responseId?: string;
  readonly asked?: string;
  readonly model?: string;
}

const SLACK_MS = 5000;

function leaf(id: string | undefined): string {
  if (!id) return "";
  const slash = id.lastIndexOf("/");
  return (slash >= 0 ? id.slice(slash + 1) : id).toLowerCase();
}

function targets(hop: HopRef, remoteId: string): boolean {
  if (hop.provider === remoteId) return true;
  if (hop.model === remoteId || hop.model?.startsWith(`${remoteId}/`)) return true;
  return hop.tries.some((attempt) => attempt.id === remoteId || attempt.model === remoteId || attempt.model.startsWith(`${remoteId}/`));
}

function sameModel(remote: RemoteRef, hop: HopRef): boolean {
  const wanted = leaf(remote.asked) || leaf(remote.model);
  if (!wanted) return false;
  if (leaf(hop.model) === wanted) return true;
  return hop.tries.some((attempt) => leaf(attempt.model) === wanted);
}

/** The hop names a different call than the remote route, so time cannot rescue it. */
function contradicts(remote: RemoteRef, hop: HopRef): boolean {
  return Boolean(remote.responseId && hop.responseId && remote.responseId !== hop.responseId);
}

function withinWindow(remote: RemoteRef, hop: HopRef): boolean {
  if (!remote.time || hop.ms === undefined || !Number.isFinite(hop.ms) || hop.ms < 0) return false;
  const start = Date.parse(hop.time);
  const at = Date.parse(remote.time);
  if (!Number.isFinite(start) || !Number.isFinite(at)) return false;
  return at >= start - SLACK_MS && at <= start + hop.ms + SLACK_MS;
}

function ambiguous(hops: readonly HopRef[], why: string): Link {
  const ids = hops.map((hop) => hop.routeId);
  const shown = ids.slice(0, 8).join("、");
  return { state: "ambiguous", note: `有 ${ids.length} 条本机路由的${why}都像同一次调用（${shown}），不选其中一条。` };
}

export function correlate(remote: RemoteRef, hops: readonly HopRef[]): Link {
  const aimed = hops.filter((hop) => targets(hop, remote.remoteId));
  if (aimed.length === 0) {
    return {
      state: "unmatched",
      note: hops.length === 0
        ? "本机最近的路由里没有这个会话，无法关联。会话可能没传到本机，或已经不在本机缓存中。"
        : `本机有这个会话的路由，但没有发往「${remote.remoteId}」的一跳。配置里的远端 id 需要和本机 Remote magpie 的 provider id 一致。`,
    };
  }
  if (remote.responseId) {
    const same = aimed.filter((hop) => hop.responseId === remote.responseId);
    if (same.length === 1) {
      const hop = same[0] as HopRef;
      return { state: "matched", by: "response-id", localRouteId: hop.routeId, note: `与本机路由 ${hop.routeId} 的响应 ID 相同。` };
    }
    if (same.length > 1) return ambiguous(same, "响应 ID");
  }
  const timed = aimed.filter((hop) => !contradicts(remote, hop) && withinWindow(remote, hop) && sameModel(remote, hop));
  if (timed.length === 1) {
    const hop = timed[0] as HopRef;
    return { state: "matched", by: "time-and-model", localRouteId: hop.routeId, note: `与本机路由 ${hop.routeId} 的时间和模型相符，没有第二条同样相符。` };
  }
  if (timed.length > 1) return ambiguous(timed, "时间和模型");
  return { state: "unmatched", note: "本机有发往该远端的路由，但响应 ID 对不上，时间和模型也不能唯一对应。不猜测是哪一跳。" };
}

export function costRollup(link: Link, usage: Usage): CostRollup {
  if (link.state !== "matched") return { state: "withheld", note: "还没有唯一关联到本机的一跳，跨层费用不求和。" };
  if (usage.state !== "ready") return { state: "withheld", note: "远端用量尚未就绪，不用本机记录估计这笔费用。" };
  let usd = 0;
  let known = 0;
  let unknown = 0;
  for (const row of usage.rows) {
    if (row.cost.state === "unknown") unknown += 1;
    else {
      known += 1;
      usd = Math.round((usd + row.cost.usd) * 1e8) / 1e8;
    }
  }
  if (known === 0) return { state: "withheld", note: "远端没有可计价的记录，不把本机估价当成实际费用。" };
  if (unknown > 0) return { state: "partial", usd, note: `合计只含远端 ${known} 条已知费用，另有 ${unknown} 条未知未计入。本机把这次调用转给远端的费用不重复计算。` };
  return { state: "deduped", usd, note: "合计只计远端实际执行的记录。本机把这次调用转给远端的费用不重复计算。" };
}
