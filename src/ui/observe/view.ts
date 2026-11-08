// How one observed route is drawn. Only what the remote returned is shown;
// what it left out stays marked unknown and is never inferred.

import type { Attempt, Cost, CostRollup, Link, Observation, Route, RuleHit, Usage, UsageRow } from "../../shared/observation.ts";
import { badge, node, scalar } from "../dom.ts";
import { clock, failure, httpStatus, milliseconds, money, tokenCount, dateTime } from "../format.ts";

const httpSuccess = (v: unknown) => typeof v === "number" && v >= 200 && v < 300;
export const hasFailure = (a: Attempt) => Boolean(a.fail) || (typeof a.status === "number" && a.status >= 400);

export function routeState(route: Route): [string, string] {
  if (route.error || (typeof route.status === "number" && route.status >= 400)) return ["请求失败", "danger"];
  if (route.done !== true) return ["路由进行中", "info"];
  if (typeof route.status === "number" && route.status >= 300) return ["已结束 · 结果未知", "warning"];
  const last = route.tries[route.tries.length - 1];
  if (last && hasFailure(last)) return ["请求失败", "danger"];
  if (last?.done === true && httpSuccess(last.status)) return ["请求已完成", "success"];
  return ["已结束 · 结果未知", "warning"];
}

/** Who answered: the provider/model of the last, successful try, with the model its reply named. */
export function responderOf(route: Route): { text: string; confirmed: boolean } {
  const last = route.tries[route.tries.length - 1];
  const confirmed = route.done === true && !route.error && !(typeof route.status === "number" && route.status >= 300)
    && last?.done === true && !hasFailure(last) && httpSuccess(last.status);
  if (!confirmed || !last) return { text: route.done === true ? "未确认成功回答者" : "尚未完成，等待证据", confirmed: false };
  const served = route.served?.trim();
  if (!served) return { text: `${last.model}（回复未说明实际模型）`, confirmed: true };
  return { text: last.model.endsWith(`/${served}`) || last.model === served ? last.model : `${last.model}（上报 ${served}）`, confirmed: true };
}

function flowStep(label: string, value: string, className = ""): HTMLDivElement {
  const row = node("div", `flow-step ${className}`.trim());
  row.append(node("span", "", label), node("span", "flow-value", value));
  return row;
}

function metric(label: string, value: string): HTMLDivElement {
  const element = node("div", "metric");
  element.append(node("span", "", label), node("strong", "", value));
  return element;
}

function evidenceValue(value: unknown): string {
  if (typeof value === "boolean") return value ? "是" : "否";
  if (Array.isArray(value)) {
    const values = value.map((item) => (typeof item === "boolean" ? (item ? "是" : "否") : scalar(item, ""))).filter(Boolean);
    return values.length ? values.join(" → ") : "空列表";
  }
  return scalar(value, "");
}

type Fields = ReadonlyArray<readonly [string, string]>;

function evidenceFields(record: unknown, fields: Fields): [string, string][] {
  if (!record || typeof record !== "object" || Array.isArray(record)) return [];
  const source = record as Record<string, unknown>;
  return fields.flatMap(([key, label]): [string, string][] => {
    if (!Object.hasOwn(source, key)) return [];
    const value = evidenceValue(source[key]);
    return value === "" ? [] : [[label, value]];
  });
}

const RULE_FIELDS: Fields = [
  ["n", "命中规则编号"], ["turn", "会话轮次"], ["tokens", "输入 tokens"], ["when", "规则条件（when）"], ["use", "规则选择（use）"],
  ["pick", "选择记录（pick）"], ["wanted", "原定选择（wanted）"], ["more", "额外候选（more）"], ["then", "后续候选（then）"],
  ["small", "小模型候选（small）"], ["unready", "尚未就绪（unready）"], ["instead", "替代选择（instead）"], ["useEffort", "规则推理强度"],
  ["effort", "实际推理强度"], ["held", "保持状态（held）"], ["waits", "等待记录（waits）"], ["grown", "增长记录（grown）"],
  ["compact", "压缩记录（compact）"], ["bare", "bare"], ["images", "图像记录（images）"],
];
const CLASSIFIER_FIELDS: Fields = [
  ["by", "分类模型"], ["intents", "可选意图"], ["intent", "分类意图"], ["score", "分数（score）"], ["sure", "置信记录（sure）"],
  ["effort", "推理强度"], ["cached", "命中缓存"], ["ms", "分类耗时"], ["error", "分类错误"], ["said", "分类返回记录（said）"],
  ["after", "分类后记录（after）"], ["above", "阈值记录（above）"], ["fallback", "回退记录（fallback）"], ["afterEffort", "后续推理强度"],
];

const hasEvidence = (rule: RuleHit | null | undefined) =>
  evidenceFields(rule, RULE_FIELDS).length > 0 || evidenceFields(rule?.classified, CLASSIFIER_FIELDS).length > 0;

function evidenceList(fields: [string, string][]): HTMLDListElement {
  const list = node("dl", "selection-values");
  for (const [label, value] of fields) list.append(node("dt", "", label), node("dd", "", value));
  return list;
}

function renderRule(rule: RuleHit | null | undefined, title: string, route: Route, group: string | undefined): HTMLDivElement {
  const panel = node("div", "rule-panel");
  panel.append(node("h4", "rule-title", title), node("p", "rule-source", `来源：route ${scalar(route.id)} / group ${scalar(group)}`));
  const fields = evidenceFields(rule, RULE_FIELDS);
  if (fields.length) panel.append(evidenceList(fields));
  const classifier = evidenceFields(rule?.classified, CLASSIFIER_FIELDS);
  if (classifier.length) {
    const block = node("div", "classifier-evidence");
    block.append(node("h4", "rule-title", "分类器证据"), evidenceList(classifier));
    panel.append(block);
  }
  if (!hasEvidence(rule)) panel.append(node("p", "unknown-note", "此分组未返回可解释的规则或分类证据。"));
  return panel;
}

function renderSelection(route: Route): HTMLElement {
  const section = node("section", "selection-section");
  section.append(node("h3", "section-label", "选择证据"));
  const nested = (route.nested ?? []).filter((entry) => entry && typeof entry === "object");
  const top = hasEvidence(route.rule);
  const inner = nested.some((entry) => hasEvidence(entry.rule));
  if (!top && !inner) section.append(node("p", "unknown-note", "选择依据未知：本次路由未返回可解释的规则或分类证据；不推断模型被选中的原因。"));
  if (top) section.append(renderRule(route.rule, "当前路由组", route, route.group));
  nested.forEach((entry, i) => section.append(renderRule(entry.rule, `嵌套分组 ${i + 1} · ${scalar(entry.name, scalar(entry.group))}`, route, entry.group)));
  return section;
}

function renderAttempt(attempt: Attempt, index: number, finalResponder: boolean): HTMLLIElement {
  let [state, kind] = ["进行中", "info"];
  if (hasFailure(attempt)) [state, kind] = ["失败", "danger"];
  else if (attempt.done === true) [state, kind] = httpSuccess(attempt.status) ? ["尝试成功", "success"] : ["已结束 · 结果未知", "warning"];
  if (finalResponder) state = "最终成功尝试";
  const item = node("li", `attempt ${kind}`);
  const content = node("div", "attempt-main");
  const top = node("div", "attempt-top");
  top.append(node("span", "attempt-model", scalar(attempt.model)), node("span", "attempt-duration", milliseconds(attempt.ms)));
  const meta = node("div", "attempt-meta");
  meta.append(badge(state, kind), node("span", "", httpStatus(attempt.status)));
  content.append(top, meta);
  if (attempt.fail) content.append(node("p", "attempt-fail", failure(attempt.fail)));
  else if (hasFailure(attempt)) content.append(node("p", "attempt-fail", "失败原因未知（接口未提供）。"));
  item.append(node("span", "attempt-index", String(index + 1)), content);
  return item;
}

function pricing(cost: Cost | undefined): [string, string] {
  if (cost?.state === "known-zero") return ["已知零费 · $0", cost.source || "接口确认零费用"];
  if (cost?.state === "estimated" && Number.isFinite(cost.usd) && cost.usd >= 0) return [`${money(cost.usd)} · 估算`, cost.source || "计价来源未提供"];
  return ["费用未知", "缺少可确认的计价信息"];
}

function cell(primary: string, secondary?: string): HTMLTableCellElement {
  const element = node("td");
  element.append(node("span", "cell-primary", primary));
  if (secondary) element.append(node("span", "cell-secondary", secondary));
  return element;
}

const USAGE_LABELS: Readonly<Record<string, [string, string]>> = {
  ready: ["已读取", "success"], pending: ["等待完成", "warning"], forbidden: ["访问受限", "danger"],
  offline: ["远端离线", "danger"], incompatible: ["接口不兼容", "warning"], error: ["读取异常", "danger"],
};
const USAGE_EMPTY: Readonly<Record<string, string>> = {
  ready: "已读取用量，但没有与当前路由匹配的记录；写入可能有延迟。",
  pending: "路由完成后才会写入用量，届时再读取。费用仍为未知。",
  forbidden: "当前凭据无权读取用量；路由证据与用量权限相互独立。",
  offline: "用量接口暂时不可达，恢复后自动读取。",
  incompatible: "远端用量接口或返回结构不兼容，无法确认费用。",
  error: "暂时无法读取用量，无法确认费用。",
};

function usageRow(row: UsageRow): HTMLTableRowElement {
  const item = node("tr");
  item.append(cell(`${scalar(row.provider)} / ${scalar(row.model)}`, row.served ? `上报模型 ${row.served}` : "上报模型未知"));
  const account = row.accountAlias ?? "无账号信息";
  item.append(cell(account, row.keyAlias ? `密钥：${row.keyAlias}` : "密钥名称未提供"));
  item.append(cell(`${tokenCount(row.input)} / ${tokenCount(row.output)}`, "tokens · 输入 / 输出"));
  const [costValue, source] = pricing(row.cost);
  const costCell = cell(costValue, source);
  costCell.firstElementChild?.classList.add("cost-value");
  item.append(costCell);
  const handedOn = row.handedOn === true ? "已转交后续尝试" : row.handedOn === false ? "未转交后续尝试" : "转交状态未知";
  item.append(cell(`${scalar(row.status)} · ${handedOn}`, dateTime(row.time)));
  return item;
}

const LINK_LABEL: Readonly<Record<Link["state"], [string, string]>> = {
  matched: ["已关联本机", "success"],
  ambiguous: ["无法唯一关联", "warning"],
  unmatched: ["未关联", "warning"],
  unavailable: ["本机未对照", ""],
};

function renderUsage(usage: Usage | undefined, rollup: CostRollup | undefined): HTMLElement {
  const section = node("section", "usage-section");
  const state = usage?.state || "error";
  const [label, kind] = USAGE_LABELS[state] ?? ["状态未知", "warning"];
  const heading = node("div", "usage-heading");
  heading.append(node("h3", "section-label", "用量与费用证据"), badge(label, kind));
  section.append(heading);
  const rows = usage?.rows ?? [];
  if (rows.length) {
    const wrapper = node("div", "usage-table-wrap");
    wrapper.tabIndex = 0;
    wrapper.setAttribute("role", "region");
    wrapper.setAttribute("aria-label", "用量记录，可横向滚动");
    const table = node("table", "usage-table");
    const head = node("tr");
    for (const text of ["供应商 / 模型", "账户 / 密钥别名", "输入 / 输出", "费用（USD）", "状态 / 时间"]) {
      const th = node("th", "", text);
      th.scope = "col";
      head.append(th);
    }
    const body = node("tbody");
    rows.forEach((row) => body.append(usageRow(row)));
    const thead = node("thead");
    thead.append(head);
    table.append(thead, body);
    wrapper.append(table);
    section.append(wrapper);
  } else {
    section.append(node("p", "unknown-note", USAGE_EMPTY[state] ?? "用量状态未知，无法确认费用。"));
  }
  if (usage?.message) section.append(node("p", "usage-note", usage.message));
  if (rollup) {
    const amount = rollup.usd === undefined ? "" : `远端合计 ${money(rollup.usd)}。`;
    section.append(node("p", "usage-note", `${amount}${rollup.note} 范围：近 30 天、当前路由。`));
  } else {
    section.append(node("p", "usage-note", "范围：近 30 天、当前路由。记录已按路由与可用的会话标识核对；跨层记录可能重复，不去重、不求和。"));
  }
  return section;
}

/** The latest route in full: flow, metrics, selection evidence, tries and usage. */
export function renderRoute(data: Observation): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const route = data.route;
  if (route === null) {
    const empty = node("div", "route-empty");
    empty.append(node("h3", "", "会话暂无路由"), node("p", "", "远端明确返回 route: null。此会话可能尚未发起请求，或最新记录已不在缓存中。"));
    fragment.append(empty, node("p", "unknown-note", "确认此会话 ID 与请求实际携带的会话 ID 一致。"));
    return fragment;
  }
  const [state, kind] = routeState(route);
  const summary = node("div", "route-summary");
  summary.append(badge(state, kind));
  if (route.kind) summary.append(badge(`附带调用 · ${route.kind}`, "info"));
  if (data.link) summary.append(badge(LINK_LABEL[data.link.state]?.[0] ?? "关联未知", LINK_LABEL[data.link.state]?.[1] ?? "warning"));
  summary.append(node("p", "", httpStatus(route.status)));
  fragment.append(summary);
  if (data.link) fragment.append(node("p", "unknown-note", data.link.note));
  const responder = responderOf(route);
  const flow = node("div", "route-flow");
  flow.append(
    flowStep("请求模型", scalar(route.asked)),
    flowStep("路由组", scalar(route.group, "未提供（未知）")),
    flowStep("当前 / 末次", scalar(route.model)),
    flowStep("上报模型", scalar(route.served, "未知（响应未提供）")),
    flowStep("最终回答者", responder.text, responder.confirmed ? "responder" : ""),
  );
  const metrics = node("div", "metrics");
  metrics.append(metric("总耗时", milliseconds(route.ms)), metric("首字延迟", milliseconds(route.ttft_ms)), metric("已记录尝试", String(route.tries.length)));
  fragment.append(flow, metrics, renderSelection(route), node("h3", "section-label attempts-label", "尝试顺序 / 回退链"));
  if (route.tries.length) {
    const list = node("ol", "attempts");
    route.tries.forEach((attempt, i) => list.append(renderAttempt(attempt, i, responder.confirmed && i === route.tries.length - 1)));
    fragment.append(list);
  } else {
    fragment.append(node("p", "unknown-note", "接口尚未记录任何尝试（tries 为空）。不据此推断模型选择、失败原因或最终回答者。"));
  }
  if (route.error) fragment.append(node("p", "route-error", `路由错误：${route.error}`));
  fragment.append(renderUsage(data.usage, data.rollup));
  return fragment;
}

/** The routes seen before the latest, so a fallback stays visible after the session moves on. */
export function renderHistory(history: readonly Route[]): HTMLElement | null {
  if (history.length === 0) return null;
  const section = node("section", "history");
  section.append(node("h3", "section-label", `已记录的更早路由（${history.length}）`));
  const list = node("ol", "history-list");
  for (const route of history) {
    const [state, kind] = routeState(route);
    const item = node("li", "history-item");
    const tries = route.tries.map((t) => `${t.model}${hasFailure(t) ? ` ✗${t.status ?? ""}` : t.done ? " ✓" : " …"}`).join(" → ");
    const left = node("span");
    left.append(node("span", "flow-value", `${clock(route.time)} · ${scalar(route.asked)}`), document.createTextNode(`  ${tries || "无尝试记录"}`));
    item.append(left, badge(route.tries.length > 1 ? `${state} · 回退 ${route.tries.length - 1} 次` : state, kind));
    list.append(item);
  }
  section.append(list);
  return section;
}
