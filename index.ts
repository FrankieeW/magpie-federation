import { configurationPath } from "./src/federation/config.ts";
import { startFederation } from "./src/federation/mcp.ts";

export default {
  id: "magpie-federation",
  async server(_input: unknown, options: Record<string, unknown> = {}) {
    const path = typeof options.config === "string" ? options.config : configurationPath();
    await startFederation(path);
    return {};
  },
};
