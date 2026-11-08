// Text from a remote, made safe to show: control characters out, the
// gateway key, configured account identities, email addresses and bearer
// tokens replaced — before the length cap, so nothing cut in half survives.

export interface Redaction {
  readonly key?: string;
  readonly accountAliases: Readonly<Record<string, string>>;
}

export function redact(value: unknown, remote: Redaction, max = 512): string | undefined {
  if (typeof value !== "string") return undefined;
  let result = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  if (remote.key) result = result.split(remote.key).join("[已隐藏]");
  for (const [identity, alias] of Object.entries(remote.accountAliases)) result = result.split(identity).join(alias);
  result = result.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "未配置别名");
  result = result.replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [已隐藏]");
  return result.slice(0, max);
}
