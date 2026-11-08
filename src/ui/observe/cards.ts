// Observations: one card per remote and session, each long-polling on its
// own, keeping the routes it saw before the latest so a fallback outlives
// the next request of the same session.

import type { Observation, Route } from "../../shared/observation.ts";
import { ApiError, getJson } from "../api.ts";
import { badge, button, byId, node, scalar } from "../dom.ts";
import { dateTime } from "../format.ts";
import { renderHistory, renderRoute } from "./view.ts";

interface Remote { readonly id: string; readonly name: string }

interface Card {
  readonly key: string;
  readonly remote: Remote;
  readonly session: string;
  active: boolean;
  generation: number;
  controller: AbortController | null;
  seq: number;
  data: Observation | null;
  error: Error | null;
  resets: number;
  history: readonly Route[];
  resumeAfterPageShow: boolean;
  pollTask: Promise<unknown>;
  readonly element: HTMLElement;
  readonly connectionBadge: HTMLSpanElement;
  readonly connectionText: HTMLSpanElement;
  readonly connectionDetail: HTMLSpanElement;
  readonly lastRead: HTMLParagraphElement;
  readonly toggle: HTMLButtonElement;
  readonly snapshotNote: HTMLParagraphElement;
  readonly routeView: HTMLDivElement;
  readonly evidenceValues: HTMLDListElement;
}

const HISTORY = 8;
const el = {
  remote: byId<HTMLSelectElement>("remote-select"),
  session: byId<HTMLInputElement>("session-input"),
  add: byId<HTMLButtonElement>("add-observation"),
  reload: byId<HTMLButtonElement>("reload-remotes"),
  configuration: byId("configuration-state"),
  message: byId("form-message"),
  count: byId("observation-count"),
  empty: byId("empty-state"),
  observations: byId("observations"),
};
const cards = new Map<string, Card>();
let remotes: Remote[] = [];
let remotesController: AbortController | null = null;
let remotesGeneration = 0;
let nextNumber = 1;
let pageHidden = false;

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

function formMessage(text = ""): void {
  el.message.textContent = text;
  el.message.hidden = !text;
}

export async function loadRemotes(): Promise<void> {
  if (pageHidden) return;
  remotesController?.abort();
  const controller = new AbortController();
  remotesController = controller;
  const generation = ++remotesGeneration;
  const previous = el.remote.value;
  el.reload.disabled = el.add.disabled = el.remote.disabled = true;
  el.configuration.hidden = false;
  el.configuration.className = "configuration-state";
  el.configuration.textContent = "正在读取服务端远端配置…";
  try {
    const data = await getJson<{ remotes: Remote[] }>("remotes", undefined, controller.signal, 15_000);
    if (controller.signal.aborted || generation !== remotesGeneration || pageHidden) return;
    if (!Array.isArray(data?.remotes) || data.remotes.some((r) => !r || typeof r.id !== "string" || !r.id)) {
      throw new ApiError("incompatible", "远端列表格式不兼容，无法创建观测。");
    }
    remotes = data.remotes;
    el.remote.replaceChildren();
    if (!remotes.length) {
      el.remote.append(node("option", "", "未配置远端"));
      el.configuration.textContent = "尚未配置远端。请在服务端配置文件的 remotes 中添加实例，再重新读取远端；页面不接收或保存连接凭据。";
      return;
    }
    for (const remote of remotes) {
      const option = node("option", "", scalar(remote.name, remote.id));
      option.value = remote.id;
      el.remote.append(option);
    }
    if (remotes.some((r) => r.id === previous)) el.remote.value = previous;
    el.remote.disabled = el.add.disabled = false;
    el.configuration.hidden = true;
  } catch (error) {
    if (controller.signal.aborted || generation !== remotesGeneration || pageHidden) return;
    remotes = [];
    el.remote.replaceChildren(node("option", "", "远端列表不可用"));
    el.configuration.className = "configuration-state error";
    el.configuration.textContent = `读取远端失败：${scalar((error as Error).message)} 可点击“重新读取远端”重试。`;
  } finally {
    if (generation === remotesGeneration) el.reload.disabled = false;
  }
}

function updateCount(): void {
  el.count.textContent = `${cards.size} 个观测`;
  el.empty.hidden = cards.size > 0;
}

function setConnection(card: Card, text: string, kind: string, detail: string): void {
  card.connectionBadge.className = `badge ${kind}`.trim();
  card.connectionText.textContent = text;
  card.connectionDetail.textContent = detail;
}

function renderSnapshotNote(card: Card): void {
  const notes: string[] = [];
  if (card.data && !card.active) notes.push("观测已停止：以下为最后一次成功读取的快照。");
  else if (card.data && card.error) notes.push("连接异常：以下为最后一次成功读取的快照，尚未确认远端当前状态。");
  if (card.resets > 0) notes.push(`已接受 ${card.resets} 次序号回退；远端可能重启或清空了路由缓存。`);
  card.snapshotNote.textContent = notes.join(" ");
  card.snapshotNote.hidden = notes.length === 0;
}

function renderEvidence(card: Card): void {
  const route = card.data?.route;
  const values: [string, string][] = [
    ["远端实例", `${scalar(card.remote.name, card.remote.id)} / ${card.remote.id}`],
    ["会话 ID", card.session],
    ["路由 ID", route === null ? "无（route: null）" : scalar(route?.id)],
    ["序号 seq", card.data ? scalar(card.data.seq) : "尚未收到"],
    ["路由时间", dateTime(route?.time)],
    ["观测时间", dateTime(card.data?.observedAt)],
    ["用量读取", dateTime(card.data?.usage?.observedAt)],
    ["路由来源", "远端 /v1/magpie/route（会话最新记录）"],
    ["用量来源", "远端用量 API（近 30 天 / 当前路由 ID，路由完成后读取）"],
  ];
  card.evidenceValues.replaceChildren(...values.flatMap(([label, value]) => [node("dt", "", label), node("dd", "", value)]));
}

function renderCard(card: Card): void {
  if (!card.data) return;
  card.lastRead.textContent = `最近读取 ${dateTime(card.data.observedAt)}`;
  renderSnapshotNote(card);
  const history = renderHistory(card.history);
  card.routeView.replaceChildren(renderRoute(card.data), ...(history ? [history] : []));
  renderEvidence(card);
}

/** The routes before `next`: the one it replaces joins them, newest first, each id once. */
function nextHistory(card: Card, next: Observation): readonly Route[] {
  const previous = card.data?.route;
  if (!previous || !next.route || previous.id === next.route.id) return card.history;
  return [previous, ...card.history.filter((route) => route.id !== previous.id && route.id !== next.route?.id)].slice(0, HISTORY);
}

function stopObservation(card: Card, update = true): void {
  card.active = false;
  card.generation += 1;
  card.controller?.abort();
  card.controller = null;
  card.toggle.textContent = "继续观测";
  if (update) {
    setConnection(card, "已停止", "", "自动更新已暂停，保留最后一次返回的证据。");
    renderSnapshotNote(card);
  }
}

const current = (card: Card, generation: number, signal: AbortSignal) =>
  !pageHidden && card.active && card.generation === generation && !signal.aborted && cards.get(card.key) === card;

async function poll(card: Card, generation: number, signal: AbortSignal): Promise<void> {
  let first = true;
  let failures = 0;
  let fast = 0;
  while (current(card, generation, signal)) {
    const startedAt = Date.now();
    let pause = 0;
    try {
      const data = await getJson<Observation>("route", { remote: card.remote.id, session: card.session, after: card.seq, wait: first ? 0 : 25 }, signal);
      if (!current(card, generation, signal)) return;
      if (!data || !Number.isSafeInteger(data.seq) || data.seq < 0 || !Object.hasOwn(data, "route") || data.remote !== card.remote.id || data.session !== card.session) {
        throw new ApiError("incompatible", "路由响应缺少有效序号、路由或正确的来源标识。");
      }
      const previousSeq = card.seq;
      if (card.data && data.seq < previousSeq) card.resets += 1;
      // Sequence numbers belong to the remote's process: a lower one after a
      // restart is accepted as the new truth.
      card.history = nextHistory(card, data);
      card.seq = data.seq;
      card.data = data;
      card.error = null;
      failures = 0;
      first = false;
      renderCard(card);
      const elapsed = Date.now() - startedAt;
      if (elapsed < 1200 && (data.route === null || data.seq === previousSeq)) {
        fast += 1;
        pause = Math.min(8000, 1000 * 2 ** Math.min(fast - 1, 3));
      } else {
        fast = 0;
        pause = Math.max(0, 300 - elapsed);
      }
      setConnection(card, "观测中", "success", data.route === null ? "会话暂无路由，正在等待请求出现。" : data.route.done ? "已收到完成状态，继续等待会话的新变化。" : "正在追踪当前路由的尝试与回退。");
    } catch (error) {
      if (!current(card, generation, signal)) return;
      failures += 1;
      first = true;
      card.error = error as Error;
      const state = (error as ApiError).state || "error";
      const labels: Record<string, string> = { forbidden: "访问受限", offline: "连接中断", incompatible: "接口不兼容", error: "读取失败" };
      pause = state === "forbidden" || state === "incompatible" ? 30_000 : Math.min(30_000, 1000 * 2 ** Math.min(failures - 1, 5));
      setConnection(card, labels[state] ?? "读取失败", "danger", `${scalar((error as Error).message)} ${pause / 1000} 秒后自动重试。`);
      renderSnapshotNote(card);
      if (!card.data) {
        const empty = node("div", "route-empty");
        empty.append(node("h3", "", "暂时无法读取路由"), node("p", "", "恢复连接后将自动更新，也可点击“立即刷新”重试。"));
        card.routeView.replaceChildren(empty);
      }
    }
    if (!current(card, generation, signal)) return;
    await delay(pause, signal);
  }
}

function startObservation(card: Card): void {
  if (pageHidden || cards.get(card.key) !== card) return;
  stopObservation(card, false);
  const generation = ++card.generation;
  const controller = new AbortController();
  card.controller = controller;
  card.active = true;
  card.error = null;
  card.toggle.textContent = "停止";
  setConnection(card, "连接中", "info", "正在读取会话最新路由…");
  renderSnapshotNote(card);
  card.pollTask = card.pollTask.then(() => (current(card, generation, controller.signal) ? poll(card, generation, controller.signal) : undefined));
}

function closeObservation(card: Card): void {
  stopObservation(card, false);
  cards.delete(card.key);
  card.element.remove();
  updateCount();
}

function createObservation(remote: Remote, session: string): void {
  const key = JSON.stringify([remote.id, session]);
  const existing = cards.get(key);
  if (existing) {
    existing.element.scrollIntoView({ behavior: "smooth", block: "start" });
    existing.element.focus({ preventScroll: true });
    if (!existing.active) startObservation(existing);
    formMessage("这个远端与会话已有独立观测，已定位到对应面板。");
    return;
  }
  const number = nextNumber++;
  const element = node("article", "observation");
  element.tabIndex = -1;
  const heading = node("h3", "", scalar(remote.name, remote.id));
  heading.id = `observation-${number}`;
  element.setAttribute("aria-labelledby", heading.id);
  const connectionText = node("span", "", "连接中");
  const connectionBadge = badge("", "info");
  connectionBadge.replaceChildren(node("span", "connection-dot"), connectionText);
  const card: Card = {
    key, remote, session, active: false, generation: 0, controller: null, seq: 0, data: null, error: null, resets: 0,
    history: [], resumeAfterPageShow: false, pollTask: Promise.resolve(), element, connectionBadge, connectionText,
    connectionDetail: node("span", "connection-detail", "正在查询真实路由…"),
    lastRead: node("p", "", "尚未收到路由快照"),
    toggle: button("停止", "button small", () => (card.active ? stopObservation(card) : startObservation(card))),
    snapshotNote: node("p", "snapshot-note"),
    routeView: node("div"),
    evidenceValues: node("dl"),
  };
  const title = node("div", "card-title");
  title.append(node("span", "card-number", String(number).padStart(2, "0")), heading);
  const close = button("×", "close-button", () => closeObservation(card));
  close.setAttribute("aria-label", `关闭 ${scalar(remote.name, remote.id)} 的会话 ${session} 观测`);
  const titleRow = node("div", "card-title-row");
  titleRow.append(title, close);
  const sessionLabel = node("p", "session-label", "会话 / ");
  sessionLabel.append(node("code", "", session));
  const connection = node("div", "connection-line");
  connection.setAttribute("role", "status");
  connection.append(connectionBadge, card.connectionDetail);
  const controls = node("div", "toolbar-buttons");
  controls.append(button("立即刷新", "button small subtle", () => startObservation(card)), card.toggle);
  const toolbar = node("div", "card-toolbar");
  toolbar.append(card.lastRead, controls);
  const header = node("header", "card-header");
  header.append(titleRow, sessionLabel, connection, toolbar);
  card.snapshotNote.hidden = true;
  const waiting = node("div", "route-empty");
  waiting.append(node("h3", "", "正在建立观测"), node("p", "", "收到远端响应后显示路由与来源证据。"));
  card.routeView.append(waiting);
  const evidence = node("details", "evidence");
  evidence.append(node("summary", "", "来源证据与观测标识"), card.evidenceValues);
  const body = node("div", "card-body");
  body.append(card.snapshotNote, card.routeView, evidence);
  element.append(header, body);
  cards.set(key, card);
  el.observations.prepend(element);
  updateCount();
  renderEvidence(card);
  startObservation(card);
}

function addObservation(): void {
  formMessage();
  const session = el.session.value.trim();
  const remote = remotes.find((item) => item.id === el.remote.value);
  if (!remote) return formMessage("请选择一个已配置的远端实例。");
  if (!session) {
    formMessage("请输入实际请求使用的会话 ID。");
    return el.session.focus();
  }
  if (new TextEncoder().encode(session).length > 128) {
    formMessage("会话 ID 超过 128 个 UTF-8 字节。请使用完整且符合长度限制的真实 ID，页面不会截断它。");
    return el.session.focus();
  }
  createObservation(remote, session);
}

export function setupObservations(): void {
  el.add.addEventListener("click", addObservation);
  el.session.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      if (!el.add.disabled) addObservation();
    }
  });
  el.reload.addEventListener("click", () => void loadRemotes());
  window.addEventListener("pagehide", () => {
    pageHidden = true;
    remotesGeneration += 1;
    remotesController?.abort();
    for (const card of cards.values()) {
      card.resumeAfterPageShow = card.active;
      stopObservation(card);
    }
  });
  window.addEventListener("pageshow", (event) => {
    if (!event.persisted) return;
    pageHidden = false;
    void loadRemotes();
    for (const card of cards.values()) {
      if (card.resumeAfterPageShow) startObservation(card);
      card.resumeAfterPageShow = false;
    }
  });
  void loadRemotes();
}
