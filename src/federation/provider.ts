import { configuredServer, isRecord } from "./config.ts";
import { discoverProviders, remoteRequest, type RemoteModel } from "./catalog.ts";

export interface ProviderDescriptor {
  id: string;
  server: string;
  source: string;
  name: string;
}

interface HostInput {
  client?: { auth?: { set?(options: { path: { id: string }; body: Record<string, unknown> }): Promise<unknown> } };
}

function numberOf(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

export function pluginModel(model: RemoteModel, descriptor: ProviderDescriptor): Record<string, unknown> {
  const raw = model.raw;
  const pricing = isRecord(raw.pricing) ? raw.pricing : undefined;
  const remotePrice = isRecord(raw.magpie_price) ? raw.magpie_price : undefined;
  const limit = isRecord(raw.limit) ? raw.limit : {};
  const context = numberOf(raw.context_length ?? raw.magpie_context ?? limit.context);
  const output = numberOf(raw.max_output_tokens ?? raw.magpie_output ?? limit.output);
  const tokenInput = numberOf(pricing?.prompt);
  const tokenOutput = numberOf(pricing?.completion);
  const input = numberOf(remotePrice?.input) ?? (tokenInput === undefined ? undefined : tokenInput * 1_000_000);
  const completion = numberOf(remotePrice?.output) ?? (tokenOutput === undefined ? undefined : tokenOutput * 1_000_000);
  const capabilities = isRecord(raw.capabilities) ? raw.capabilities : {};
  const efforts = Array.isArray(raw.supported_reasoning_levels) ? raw.supported_reasoning_levels : [];
  const endpoints = Array.isArray(raw.native_endpoints) ? raw.native_endpoints : [];
  const npm = endpoints.includes("/v1/messages") ? "@ai-sdk/anthropic" : endpoints.includes("/v1/responses") ? "@ai-sdk/openai" : "@ai-sdk/openai-compatible";
  const modalities = isRecord(raw.modalities) ? raw.modalities : {};
  const inputs = Array.isArray(modalities.input) ? modalities.input : ["text"];
  const outputs = Array.isArray(modalities.output) ? modalities.output : ["text"];
  const kinds = ["text", "image", "audio", "video", "pdf"];
  const tiers = Array.isArray(raw.service_tiers) ? raw.service_tiers.flatMap((tier) =>
    typeof tier === "string" ? [tier] : isRecord(tier) && typeof tier.id === "string" ? [tier.id] : []) : [];
  return {
    id: model.id,
    providerID: descriptor.id,
    name: `${model.name} · ${descriptor.source} · ${descriptor.server}`,
    api: { id: model.id, url: "http://federation.magpie/v1", npm },
    limit: { context: context ?? 0, output: output ?? 0 },
    capabilities: {
      ...capabilities,
      reasoning: capabilities.reasoning ?? (raw.reasoning === true || efforts.length > 0),
      toolcall: capabilities.toolcall ?? true,
      input: capabilities.input ?? (Array.isArray(modalities.input) ? Object.fromEntries(kinds.map((kind) => [kind, inputs.includes(kind)])) : { text: true }),
      output: capabilities.output ?? (Array.isArray(modalities.output) ? Object.fromEntries(kinds.map((kind) => [kind, outputs.includes(kind)])) : { text: true }),
    },
    ...(input === undefined || completion === undefined ? {} : {
      cost: {
        input,
        output: completion,
        cache: {
          read: numberOf(remotePrice?.cache_read) ?? (numberOf(pricing?.input_cache_read) ?? 0) * 1_000_000,
          write: numberOf(remotePrice?.cache_write) ?? (numberOf(pricing?.input_cache_write) ?? 0) * 1_000_000,
        },
      },
    }),
    variants: Object.fromEntries(efforts.filter((effort): effort is string => typeof effort === "string").map((effort) => [effort, {}])),
    ...(tiers.length ? { serviceTiers: tiers } : {}),
    status: "active",
  };
}

/**
 * The generated plugin exports one of these hooks per remote supplier.
 * Its native provider row, model IDs and labels all retain that supplier.
 */
export function createProvider(input: HostInput, path: string, descriptor: ProviderDescriptor) {
  return {
    config: async (config: Record<string, unknown>) => {
      if (!isRecord(config.provider)) config.provider = {};
      const providers = config.provider as Record<string, unknown>;
      providers[descriptor.id] ??= {
        name: descriptor.name,
        npm: "@ai-sdk/openai-compatible",
        api: "http://federation.magpie/v1",
        searches: true,
        models: {},
      };
      // The actual gateway credential belongs to the server config. This
      // stable local account only activates the managed provider in Magpie.
      await input.client?.auth?.set?.({
        path: { id: descriptor.id },
        body: { type: "api", key: "federation-managed", accountId: `${descriptor.server}/${descriptor.source}` },
      });
    },
    auth: {
      provider: descriptor.id,
      single: true,
      methods: [],
      loader: async () => ({
        apiKey: "federation-managed",
        baseURL: "http://federation.magpie/v1",
        fetch: async (input: string | URL | Request, init: RequestInit = {}) => {
          const url = new URL(input instanceof Request ? input.url : String(input));
          const pathMatch = /^\/v1\/(chat\/completions|responses|messages(?:\/count_tokens)?|embeddings|rerank|systemone)$/.exec(url.pathname);
          if (!pathMatch || (init.method ?? "POST").toUpperCase() !== "POST") return Response.json({ error: { message: "Unsupported federation API" } }, { status: 400 });
          let body: unknown;
          try {
            const text = typeof init.body === "string" ? init.body : init.body instanceof Uint8Array ? new TextDecoder().decode(init.body) : "";
            body = JSON.parse(text);
          } catch {
            return Response.json({ error: { message: "Expected a JSON request" } }, { status: 400 });
          }
          if (!isRecord(body) || typeof body.model !== "string" || !body.model.startsWith(`${descriptor.source}/`)) {
            return Response.json({ error: { message: "Model does not belong to this remote provider" } }, { status: 400 });
          }
          const server = await configuredServer(path, descriptor.server);
          if (server.providers && !server.providers.includes(descriptor.source)) {
            return Response.json({ error: { message: "Remote provider is disabled" } }, { status: 403 });
          }
          const headers = new Headers();
          const incoming = new Headers(init.headers);
          for (const name of ["content-type", "accept", "x-magpie-session", "x-magpie-agent", "x-magpie-via", "x-magpie-hops", "x-magpie-user-agent", "anthropic-version", "anthropic-beta"]) {
            const value = incoming.get(name);
            if (value) headers.set(name, value);
          }
          headers.set("content-type", "application/json");
          return remoteRequest(server, pathMatch[1]!, { ...init, headers, body: JSON.stringify(body) });
        },
      }),
    },
    provider: {
      id: descriptor.id,
      async models(_provider: unknown, options: { signal?: AbortSignal } = {}) {
        const server = await configuredServer(path, descriptor.server);
        if (server.providers && !server.providers.includes(descriptor.source)) return {};
        const source = (await discoverProviders(server, fetch, options.signal)).find((provider) => provider.id === descriptor.source);
        return Object.fromEntries((source?.models ?? []).map((model) => [model.id, pluginModel(model, descriptor)]));
      },
    },
  };
}
