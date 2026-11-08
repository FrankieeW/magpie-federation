// The pools of every machine side by side. Each change is previewed — the
// exact magpie command and the members before and after — and runs only
// when the reader confirms it; each can be undone from the change list.

import type { Candidate, ChangeRecord, MachineView, MemberKind, Pool, PoolOp, PoolsResponse, Preview } from "../shared/api.ts";
import { isPattern } from "../shared/members.ts";
import { getJson, postJson } from "./api.ts";
import { badge, button, byId, node, scalar } from "./dom.ts";
import { dateTime } from "./format.ts";

interface Applied { readonly change: ChangeRecord; readonly matched: boolean; readonly warning?: string }

/** A failed write is "not made" — unless the answer never came, then it is unknown. */
function failed(action: string, error: unknown): string {
  const e = error as { state?: string; message?: string };
  return e.state === "offline" ? `结果未知：${e.message ?? ""}` : `${action}：${e.message ?? ""}`;
}

const el = {
  machines: byId("pools-machines"),
  message: byId("pools-message"),
  refresh: byId<HTMLButtonElement>("pools-refresh"),
  dialog: byId<HTMLDialogElement>("pool-dialog"),
};
const KIND_LABEL: Readonly<Record<MemberKind, string>> = { "remote-pool": "远端池子", "remote-model": "远端模型", pool: "本机池子", model: "模型", pattern: "通配" };
const KIND_ORDER: readonly MemberKind[] = ["remote-pool", "remote-model", "pool", "model"];
const STATE_LABEL: Readonly<Record<string, [string, string]>> = {
  ready: ["已连接", "success"], unconfigured: ["未启用 peer", "warning"], forbidden: ["访问受限", "danger"],
  offline: ["离线", "danger"], incompatible: ["不兼容", "warning"], error: ["错误", "danger"],
};
let loading: AbortController | null = null;

function message(text = "", error = false): void {
  el.message.textContent = text;
  el.message.hidden = !text;
  el.message.classList.toggle("ok", Boolean(text) && !error);
}

function closeDialog(): void {
  if (el.dialog.open) el.dialog.close();
  el.dialog.replaceChildren();
}

function openDialog(...children: Node[]): void {
  el.dialog.replaceChildren(...children);
  if (el.dialog.open) return;
  try {
    el.dialog.showModal();
  } catch {
    el.dialog.setAttribute("open", "");
  }
}

function memberKind(machine: MachineView, member: string): MemberKind {
  if (isPattern(member)) return "pattern";
  return machine.candidates.find((candidate) => candidate.id === member)?.kind ?? (member.startsWith("group/") ? "pool" : "model");
}

function kindTag(kind: MemberKind): HTMLSpanElement {
  return node("span", `kind ${kind}`, KIND_LABEL[kind]);
}

async function apply(machine: MachineView, pool: Pool, preview: Preview, confirm: HTMLButtonElement): Promise<void> {
  confirm.disabled = true;
  try {
    const result = await postJson<Applied>("pools/apply", { machine: machine.id, pool: pool.id, op: preview.op, expected: preview.before });
    closeDialog();
    if (result.warning) message(`已更新「${pool.name}」，但${result.warning}`, true);
    else message(result.matched ? `已更新 ${machine.name} 的池子「${pool.name}」。` : `已写入，但 Magpie 保存的成员与预览不同，请检查「${pool.name}」；可在最近变更中撤销。`, !result.matched);
  } catch (error) {
    closeDialog();
    message(failed("没有修改", error), true);
  }
  await loadPools();
}

function diffList(title: string, members: readonly string[], other: readonly string[], mark: "added" | "removed"): HTMLDivElement {
  const box = node("div");
  box.append(node("h4", "rule-title", title));
  const list = node("ol");
  for (const member of members) list.append(node("li", other.includes(member) ? "" : mark, member));
  if (!members.length) list.append(node("li", "", "（空）"));
  box.append(list);
  return box;
}

function showPreview(machine: MachineView, pool: Pool, preview: Preview): void {
  const heading = node("h3", "", `确认修改 ${machine.name} · ${pool.name}`);
  heading.id = "pool-dialog-title";
  const diff = node("div", "diff");
  diff.append(diffList("修改前", preview.before, preview.after, "removed"), diffList("修改后", preview.after, preview.before, "added"));
  const confirm = button("确认修改", "button primary", () => void apply(machine, pool, preview, confirm));
  const actions = node("div", "dialog-actions");
  actions.append(button("取消", "button", closeDialog), confirm);
  openDialog(heading, node("p", "machine-note", `将在 ${machine.name} 上执行：`), node("p", "command", `magpie ${preview.command.join(" ")}`), diff, actions);
  confirm.focus();
}

async function propose(machine: MachineView, pool: Pool, op: PoolOp): Promise<void> {
  try {
    showPreview(machine, pool, await postJson<Preview>("pools/preview", { machine: machine.id, pool: pool.id, op }));
  } catch (error) {
    closeDialog();
    message(`不能这样修改：${(error as Error).message}`, true);
  }
}

function candidateRows(machine: MachineView, pool: Pool, filter: string): Node[] {
  const taken = new Set([...pool.members, `group/${pool.id}`]);
  const needle = filter.trim().toLowerCase();
  const offered = machine.candidates.filter((c) => !taken.has(c.id) && (!needle || `${c.id} ${c.label}`.toLowerCase().includes(needle)));
  const rows: Node[] = [];
  for (const kind of KIND_ORDER) {
    const group = offered.filter((c: Candidate) => c.kind === kind);
    if (!group.length) continue;
    rows.push(node("li", "candidate-group", `${KIND_LABEL[kind]}（${group.length}）`));
    for (const candidate of group) {
      const item = node("li", "candidate");
      const text = node("span");
      text.append(node("code", "", candidate.id), node("span", "candidate-label", candidate.via ? `${candidate.label} · 经 ${candidate.via}` : candidate.label));
      item.append(text, button("加入", "button small", () => void propose(machine, pool, { type: "add", member: candidate.id })));
      rows.push(item);
    }
  }
  return rows.length ? rows : [node("li", "candidate", needle ? "没有匹配的模型或池子。" : "这台机器的 Magpie 没有可加入的其他成员。")];
}

function openPicker(machine: MachineView, pool: Pool): void {
  const heading = node("h3", "", `向 ${machine.name} · ${pool.name} 加入成员`);
  heading.id = "pool-dialog-title";
  const search = node("input");
  search.type = "search";
  search.placeholder = "按 ID 或名称筛选";
  const list = node("ul", "candidate-list");
  list.replaceChildren(...candidateRows(machine, pool, ""));
  search.addEventListener("input", () => list.replaceChildren(...candidateRows(machine, pool, search.value)));
  const note = node("p", "machine-note", `列表来自 ${machine.name} 的 Magpie：远端条目按它在这台机器上的名字列出；会绕回 ${machine.name} 自身的池子不会出现在这里。新成员加在末尾，之后可调整顺序。`);
  const actions = node("div", "dialog-actions");
  actions.append(button("关闭", "button", closeDialog));
  openDialog(heading, note, search, list, actions);
  search.focus();
}

function renderPool(machine: MachineView, pool: Pool): HTMLElement {
  const box = node("section", "pool");
  const head = node("div", "pool-head");
  const title = node("div");
  title.append(node("h3", "", pool.name), node("code", "", `group/${pool.id}`));
  head.append(title, node("span", "pool-meta", `${pool.routing} · ${pool.members.length} 个成员`));
  const list = node("ol", "members");
  pool.members.forEach((member, index) => {
    const item = node("li", "member");
    const label = node("span");
    label.append(node("code", "", member), kindTag(memberKind(machine, member)));
    const actions = node("span", "member-actions");
    if (machine.writable) {
      const up = button("↑", "icon-button", () => void propose(machine, pool, { type: "move", member, to: index - 1 }));
      const down = button("↓", "icon-button", () => void propose(machine, pool, { type: "move", member, to: index + 1 }));
      const remove = button("✕", "icon-button danger", () => void propose(machine, pool, { type: "remove", member }));
      up.disabled = index === 0;
      down.disabled = index === pool.members.length - 1;
      up.setAttribute("aria-label", `上移 ${member}`);
      down.setAttribute("aria-label", `下移 ${member}`);
      remove.setAttribute("aria-label", `从池子移出 ${member}`);
      actions.append(up, down, remove);
    }
    item.append(node("span", "member-index", String(index + 1)), label, actions);
    list.append(item);
  });
  box.append(head, list);
  if (machine.writable) box.append(button("＋ 加入成员", "button small", () => openPicker(machine, pool)));
  return box;
}

function describe(change: ChangeRecord): string {
  const op = change.op;
  const what = op.type === "add" ? `加入 ${op.member}` : op.type === "remove" ? `移出 ${op.member}` : `把 ${op.member} 移到第 ${op.to + 1} 位`;
  return `${dateTime(change.at)} · ${change.pool} · ${what}${change.undoOf ? "（撤销）" : ""} · ${change.by}`;
}

function renderChanges(machine: MachineView): HTMLElement | null {
  if (!machine.changes.length) return null;
  const details = node("details", "changes");
  details.append(node("summary", "", `最近变更（${machine.changes.length}）`));
  for (const change of [...machine.changes].reverse().slice(0, 20)) {
    const row = node("div", "change");
    row.append(node("span", "", describe(change)));
    if (machine.writable) {
      row.append(button("撤销", "text-button", async () => {
        try {
          const result = await postJson<Applied>("pools/undo", { machine: machine.id, change: change.id });
          message(result.warning ? `已撤销，但${result.warning}` : result.matched ? `已撤销：${describe(change)}` : "已撤销，但池子没有完全回到原样，请检查。", Boolean(result.warning) || !result.matched);
        } catch (error) {
          message(failed("无法撤销", error), true);
        }
        await loadPools();
      }));
    }
    details.append(row);
  }
  return details;
}

function renderMachine(machine: MachineView): HTMLElement {
  const card = node("article", "machine");
  const head = node("div", "machine-head");
  const [label, kind] = STATE_LABEL[machine.state] ?? ["未知", "warning"];
  const title = node("h2", "", machine.name);
  const tags = node("span");
  tags.append(badge(label, kind));
  if (machine.state === "ready") tags.append(badge(machine.writable ? "可修改" : "只读", machine.writable ? "info" : ""));
  head.append(title, tags);
  card.append(head);
  if (machine.magpieVersion) card.append(node("p", "machine-note", `Magpie ${machine.magpieVersion}`));
  if (machine.message) card.append(node("p", machine.state === "ready" ? "machine-note" : "machine-note error", machine.message));
  if (machine.state === "ready" && !machine.pools.length) card.append(node("p", "unknown-note", "这台机器还没有自建的池子。可以在 Magpie 的 Routing 页面或用 magpie group add 新建一个。"));
  machine.pools.forEach((pool) => card.append(renderPool(machine, pool)));
  const changes = renderChanges(machine);
  if (changes) card.append(changes);
  return card;
}

export async function loadPools(): Promise<void> {
  loading?.abort();
  const controller = new AbortController();
  loading = controller;
  el.refresh.disabled = true;
  try {
    const data = await getJson<PoolsResponse>("pools", undefined, controller.signal, 40_000);
    if (controller.signal.aborted) return;
    el.machines.replaceChildren(...data.machines.map(renderMachine));
  } catch (error) {
    if (controller.signal.aborted) return;
    message(`读取池子失败：${scalar((error as Error).message)}`, true);
  } finally {
    if (loading === controller) el.refresh.disabled = false;
  }
}

export function setupPools(): void {
  el.refresh.addEventListener("click", () => {
    message();
    void loadPools();
  });
  el.dialog.addEventListener("cancel", () => el.dialog.replaceChildren());
}
