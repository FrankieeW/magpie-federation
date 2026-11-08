import { isRecord } from "./config.ts";

export interface Suspension {
  providers: { id: string; wasOff: boolean }[];
  mcp: { name: string; agents: string[]; removed: boolean }[];
}

export function suspensionPlan(
  managedProviders: readonly { id: string }[],
  managedMcp: readonly { name: string; url?: string }[],
  providers: readonly Record<string, unknown>[],
  library: readonly Record<string, unknown>[],
  previous?: Suspension,
): { suspension: Suspension; commands: string[][] } {
  const suspension: Suspension = {
    providers: [...(previous?.providers ?? [])],
    mcp: [...(previous?.mcp ?? [])],
  };
  const commands: string[][] = [];
  for (const managed of managedProviders) {
    const provider = providers.find((item) => item.id === managed.id);
    if (!provider) continue;
    if (!suspension.providers.some((item) => item.id === managed.id)) {
      suspension.providers.push({ id: managed.id, wasOff: provider.off === true });
    }
    if (provider.off !== true) commands.push(["provider", "off", managed.id]);
  }
  for (const managed of managedMcp) {
    const entry = library.find((item) => item.name === managed.name && item.url === managed.url);
    if (!entry) continue;
    const agents = Array.isArray(entry.agents) ? entry.agents.filter((agent): agent is string => typeof agent === "string") : [];
    const simple = Object.keys(entry).every((key) => ["name", "transport", "url", "agents", "local"].includes(key));
    if (!suspension.mcp.some((item) => item.name === managed.name)) {
      suspension.mcp.push({ name: managed.name, agents, removed: simple });
    }
    if (simple) commands.push(["library", "mcp", "rm", managed.name]);
    else if (agents.length) commands.push(["library", "mcp", "agents", managed.name, "none"]);
  }
  return { suspension, commands };
}

export function parseSuspension(value: unknown): Suspension | undefined {
  if (!isRecord(value) || !Array.isArray(value.providers) || !Array.isArray(value.mcp)) return undefined;
  return {
    providers: value.providers.filter((item): item is Suspension["providers"][number] =>
      isRecord(item) && typeof item.id === "string" && typeof item.wasOff === "boolean"),
    mcp: value.mcp.filter((item): item is Suspension["mcp"][number] =>
      isRecord(item) && typeof item.name === "string" && typeof item.removed === "boolean" &&
      Array.isArray(item.agents) && item.agents.every((agent) => typeof agent === "string")),
  };
}
