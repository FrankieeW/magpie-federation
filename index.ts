// The host part of the plugin: Magpie's Bun plugin host imports this file
// (index.ts is the first entry it looks for) and calls server() with the
// plugin's options. The services run inside that host and stop with it.

import { startServices, type Services } from "./src/server/start.ts";

let started: Promise<Services> | undefined;

/** Stops what server() started; the host normally ends with its process instead. */
export async function stop(): Promise<void> {
  const running = started;
  started = undefined;
  (await running?.catch(() => undefined))?.stop();
}

export default {
  id: "magpie-route-inspector",
  async server(_input: unknown, options: Record<string, unknown> = {}) {
    started ??= startServices(options).catch((error: unknown) => {
      started = undefined;
      throw error;
    });
    await started;
    return {};
  },
};
