const $ = (id) => document.getElementById(id);
const session = document.documentElement.dataset.session;
const theme = new URLSearchParams(location.search).get("theme");
if (theme === "dark" || theme === "light") document.documentElement.dataset.theme = theme;
let settings;
let busy = false;
let generation = 0;
let timer;
const number = (value) => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const count = (value) => number(value) === undefined ? "—" : new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 }).format(value);
const money = (value) => number(value) === undefined ? "未提供" : `$${value.toLocaleString("en-US", { maximumFractionDigits: 4 })}`;
function node(tag, className, text) {
  const value = document.createElement(tag);
  if (className) value.className = className;
  if (text !== undefined) value.textContent = String(text);
  return value;
}
function icon(name) {
  const image = node("img", "provider-icon");
  image.alt = "";
  if (["openai", "opencode", "openrouter", "xai"].includes(name)) image.classList.add("monochrome");
  image.src = new URL(`../api/icon?name=${encodeURIComponent(name || "magpie")}`, location.href).href;
  return image;
}
function message(text) {
  $("message").textContent = text;
  $("message").hidden = !text;
}
async function api(path, options = {}) {
  const response = await fetch(new URL(`../api/${path}`, location.href), {
    ...options, headers: { authorization: `Bearer ${session}`, ...(options.body ? { "content-type": "application/json" } : {}) },
  });
  if (response.status === 401) {
    location.reload();
    throw new Error("正在重新连接看板…");
  }
  const value = await response.json();
  if (!response.ok) {
    const error = new Error(value.error || "看板暂时不可用");
    error.status = response.status;
    throw error;
  }
  return value;
}
function controls() {
  $("enabled").checked = settings.enabled;
  $("mode").value = settings.mode;
  document.body.classList.toggle("disabled", !settings.enabled);
  $("mode-note").textContent = !settings.enabled
    ? "远端连接已关闭。重新启用后恢复所选模式。"
    : settings.mode === "lite"
      ? "Lite 模式 · 仅启用远端看板，使用现有凭据自动连接。供应商与 MCP 接入已暂停。"
      : "完整模式 · 启用远端看板，并将供应商、模型和 MCP 接入 Magpie。";
}
async function apply() {
  if (busy) return;
  busy = true;
  generation += 1;
  $("enabled").disabled = $("mode").disabled = true;
  message("正在应用设置…");
  clearTimeout(timer);
  try {
    await api("settings", { method: "POST", body: JSON.stringify({ enabled: $("enabled").checked, mode: $("mode").value }) });
    settings = await api("status");
    controls();
    message("");
    await refresh();
  } catch (error) {
    message(error.message);
    if (!error.status) {
      setTimeout(() => location.reload(), 1000);
    } else {
      try { settings = await api("status"); } catch {}
    }
    controls();
  } finally {
    busy = false;
    $("enabled").disabled = $("mode").disabled = false;
    if (settings?.enabled && !document.hidden) timer = setTimeout(refresh, 30000);
  }
}
function stat(label, value, note) {
  const card = node("div", "stat");
  card.append(node("div", "stat-label", label), node("div", "stat-value", value), node("div", "stat-note", note));
  return card;
}
function render(data) {
  const usage = data.usage || {};
  const cards = Array.isArray(data.quotas?.data) ? data.quotas.data : [];
  const models = Array.isArray(data.models?.data) ? data.models.data : [];
  $("connection").textContent = data.info?.unavailable
    ? `${data.server.name} · 暂时无法连接`
    : `${data.server.name} · 已自动连接${data.info?.version ? ` · Magpie ${data.info.version}` : ""}`;
  $("totals").replaceChildren(
    stat("请求", count(usage.calls), `${count(usage.errors)} 次失败`),
    stat("输入 Token", count(usage.input), `缓存读取 ${count(usage.cache_read)}`),
    stat("输出 Token", count(usage.output), `推理 ${count(usage.reasoning)}`),
    stat("已知费用", money(usage.cost), usage.unpriced ? `${count(usage.unpriced)} 次调用价格未知` : "按远端记录计价"),
  );
  $("quotas").replaceChildren();
  $("quota-count").textContent = `${cards.length} 个账户或额度入口`;
  for (const card of cards) {
    const element = node("article", "quota-card");
    const heading = node("div", "card-head");
    const title = node("div");
    title.append(node("h3", "", card.name || card.provider), node("div", "card-sub", [card.plan, card.alias || card.user].filter(Boolean).join(" · ")));
    heading.append(icon(card.icon), title);
    element.append(heading);
    if (card.balance) element.append(node("div", "balance", card.balance));
    for (const window of card.windows || []) {
      const section = node("div", "window");
      const line = node("div", "window-top");
      const used = window.text ? undefined : number(window.used);
      line.append(node("strong", "", window.name), node("span", "", window.display || (used === undefined ? "未提供比例" : `${used.toFixed(1)}% 已用`)));
      section.append(line);
      if (used !== undefined) {
        const bar = node("div", "bar");
        const fill = node("div", "fill");
        fill.style.width = `${Math.min(100, Math.max(0, used))}%`;
        bar.append(fill);
        section.append(bar);
      }
      if (window.resetsAt) section.append(node("div", "window-note", `重置于 ${new Date(window.resetsAt).toLocaleString()}`));
      element.append(section);
    }
    if (card.readAt) element.append(node("div", "window-note", `读取于 ${new Date(card.readAt).toLocaleString()}`));
    if (card.error) element.append(node("div", "quota-error", card.error));
    $("quotas").append(element);
  }
  if (!cards.length) $("quotas").append(node("p", "empty", data.quotas?.status === 403 ? "当前网关密钥无权读取远端额度。" : "远端尚未提供额度卡片。"));
  const icons = new Map(cards.map((card) => [card.provider, card.icon]));
  for (const model of usage.models || []) if (!icons.has(model.provider)) icons.set(model.provider, model.icon);
  const groups = new Map();
  for (const model of models) {
    const source = model.id?.split("/")[0];
    if (!source) continue;
    if (!groups.has(source)) groups.set(source, []);
    groups.get(source).push(model);
  }
  $("models").replaceChildren();
  $("model-count").textContent = `${groups.size} 个来源 · ${models.length} 个模型`;
  for (const [source, entries] of groups) {
    const details = node("details");
    const summary = node("summary");
    summary.append(icon(icons.get(source)), node("strong", "", source), node("span", "count", `${entries.length} 个模型`));
    const wrap = node("div", "table-wrap");
    const table = node("table");
    const head = node("thead");
    const row = node("tr");
    for (const label of ["模型", "输入 / 输出价格", "缓存读取 / 写入", "上下文"]) row.append(node("th", "", label));
    head.append(row);
    const body = node("tbody");
    for (const model of entries) {
      const line = node("tr");
      const name = node("td");
      name.append(node("strong", "", model.display_name || model.id));
      if (model.kind) name.append(node("span", "model-tag", model.kind));
      name.append(node("div", "model-id", model.id));
      const price = model.magpie_price;
      const cost = node("td", "", price ? `${money(price.input)} / ${money(price.output)}` : "未提供");
      if (price?.tiers?.length) cost.append(node("div", "price-note", `${price.tiers.length} 档阶梯价格`));
      for (const tier of price?.tiers || []) {
        cost.append(node("div", "price-note", `超过 ${count(tier.above)} 输入 · ${money(tier.input)} / ${money(tier.output)}`));
      }
      const cache = node("td", "", price ? `${money(price.cache_read)} / ${money(price.cache_write)}` : "未提供");
      if (price?.cache_write_1h) cache.append(node("div", "price-note", `1 小时 ${money(price.cache_write_1h)}`));
      line.append(name, cost, cache, node("td", "", count(model.context_length)));
      body.append(line);
    }
    table.append(head, body);
    wrap.append(table);
    details.append(summary, wrap);
    $("models").append(details);
  }
  if (!groups.size) $("models").append(node("p", "empty", "远端模型目录暂不可用。"));
  $("updated").textContent = `更新于 ${new Date(data.observedAt).toLocaleTimeString()} · 价格单位 USD / 百万 Token`;
}
async function refresh() {
  clearTimeout(timer);
  const current = ++generation;
  try {
    settings = await api("status");
    controls();
  } catch (error) {
    message(error.message);
    return;
  }
  if (!settings?.enabled || !$("server").value) {
    $("connection").textContent = settings?.enabled ? "尚未连接服务器，请使用 magpie-federation connect 添加。" : "远端连接已关闭";
    return;
  }
  $("refresh").disabled = true;
  try {
    const data = await api(`dashboard?server=${encodeURIComponent($("server").value)}&period=${$("period").value}`);
    if (current !== generation) return;
    if (!data.disabled) render(data);
    message("");
  } catch (error) {
    if (current === generation) message(error.message);
  } finally {
    $("refresh").disabled = false;
    if (!busy && !document.hidden) timer = setTimeout(refresh, 30000);
  }
}
$("enabled").addEventListener("change", apply);
$("mode").addEventListener("change", apply);
for (const id of ["server", "period"]) $(id).addEventListener("change", refresh);
$("refresh").addEventListener("click", refresh);
document.addEventListener("visibilitychange", () => document.hidden ? clearTimeout(timer) : refresh());
(async () => {
  try {
    settings = await api("status");
    for (const server of settings.servers) {
      const option = node("option", "", server.name);
      option.value = server.id;
      $("server").append(option);
    }
    controls();
    await refresh();
  } catch (error) { message(error.message); }
})();
