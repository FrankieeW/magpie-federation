// Building the page from data without ever parsing it as markup: every text
// goes in as textContent.

export function node<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string | number): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = String(text);
  return element;
}

export function button(text: string, className: string, listener: (event: MouseEvent) => void): HTMLButtonElement {
  const element = node("button", className, text);
  element.type = "button";
  element.addEventListener("click", listener);
  return element;
}

export function badge(text: string, kind = ""): HTMLSpanElement {
  return node("span", `badge ${kind}`.trim(), text);
}

export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`页面缺少 #${id}`);
  return element as T;
}

/** A shown value, or the fallback for what is missing. */
export function scalar(value: unknown, fallback = "未知"): string {
  if (typeof value === "string" && value.trim() !== "") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return fallback;
}
