const numbers = new Intl.NumberFormat("zh-CN");
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 8 });

export function milliseconds(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "未知";
  if (value < 1000) return `${numbers.format(value)} ms`;
  return `${(value / 1000).toFixed(value < 10000 ? 2 : 1)} s`;
}

export function dateTime(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") return "未知";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "未知" : date.toLocaleString("zh-CN", { hour12: false });
}

export function clock(value: unknown): string {
  if (typeof value !== "string") return "未知";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "未知" : date.toLocaleTimeString("zh-CN", { hour12: false });
}

export function tokenCount(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? numbers.format(value) : "未知";
}

export function httpStatus(value: unknown): string {
  return typeof value === "number" && value > 0 ? `HTTP ${value}` : "HTTP 未知";
}

export function money(value: number): string {
  return usd.format(value);
}

// The short codes Magpie's trace gives a failed try, said plainly; any
// other code is shown as it came.
const FAILURES: Readonly<Record<string, string>> = {
  rate: "限流",
  auth: "认证失败",
  quota: "额度用尽",
  timeout: "超时",
  overload: "过载",
  server: "服务端错误",
  network: "网络错误",
  refused: "被拒绝",
};

export function failure(code: string): string {
  const plain = FAILURES[code.trim().toLowerCase()];
  return plain ? `${plain}（${code}）` : code;
}
