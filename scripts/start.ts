// The same services without Magpie's window: `bun run start`.

import { startServices } from "../src/server/start.ts";

try {
  const services = await startServices();
  process.stdout.write(`Magpie Route Inspector: ${services.console.url}${services.console.reused ? "（已由另一个同版本实例提供）" : ""}\n`);
  if (services.peer) process.stdout.write(`peer API: port ${services.peer.port}\n`);
  const stop = () => {
    services.stop();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
} catch (error) {
  process.stderr.write(`无法启动 Magpie Route Inspector：${(error as Error).message}\n`);
  process.exitCode = 1;
}
