import { describe, expect, test } from "bun:test";
import { cachedSameUser, ownerFromLsof, ownerFromProcNet, sameUserCheck } from "../src/server/owner.ts";

// A real /proc/net/tcp layout: the client end of 127.0.0.1:52345 -> 127.0.0.1:3487
// owned by uid 501, our server's end owned by uid 501 too, and an unrelated socket.
const TCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:0D9F 00000000:0000 0A 00000000:00000000 00:00000000 00000000   501        0 11111 1 0000000000000000 100 0 0 10 0
   1: 0100007F:CC39 0100007F:0D9F 01 00000000:00000000 00:00000000 00000000   502        0 22222 1 0000000000000000 20 4 30 10 -1
   2: 0100007F:0D9F 0100007F:CC39 01 00000000:00000000 00:00000000 00000000   501        0 33333 1 0000000000000000 20 4 30 10 -1
`;
const TCP6 = `  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0000000000000000FFFF00000100007F:CC3A 0000000000000000FFFF00000100007F:0D9F 01 00000000:00000000 00:00000000 00000000   501        0 44444 1
`;

describe("socket owners", () => {
  test("reads the client end's owner from /proc/net/tcp, tcp6 and v4-mapped addresses", () => {
    expect(ownerFromProcNet(TCP, 501, 0xcc39, 3487)).toBe(false); // uid 502's process
    expect(ownerFromProcNet(TCP, 502, 0xcc39, 3487)).toBe(true);
    expect(ownerFromProcNet(TCP6, 501, 0xcc3a, 3487)).toBe(true);
    expect(ownerFromProcNet(TCP, 501, 0xdead, 3487)).toBeNull();
  });

  test("finds the client end in lsof output, never the server's own end", () => {
    const output = "p123\nf9\nn127.0.0.1:3487->127.0.0.1:52345\np456\nf31\nn127.0.0.1:52345->127.0.0.1:3487\n";
    expect(ownerFromLsof(output, 52345, 3487)).toBe(true);
    expect(ownerFromLsof("p123\nf9\nn127.0.0.1:3487->127.0.0.1:52345\n", 52345, 3487)).toBe(false);
    expect(ownerFromLsof(output, 5234, 3487)).toBe(false);
  });

  test("on this platform, knows this process's own connection and no stranger's port", async () => {
    const check = sameUserCheck();
    if (!check) return; // no check is made on this platform
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request, srv) {
        const client = srv.requestIP(request);
        return new Response(String(client ? await check(client.port, srv.port as number) : "no-ip"));
      },
    });
    try {
      expect(await (await fetch(`http://127.0.0.1:${server.port}/`)).text()).toBe("true");
      expect(await check(9, server.port as number)).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test("remembers a verdict briefly, and treats a failing check as a refusal", async () => {
    let calls = 0;
    const cached = cachedSameUser(async () => {
      calls += 1;
      return true;
    });
    expect(await cached(50000, 3487)).toBe(true);
    expect(await cached(50000, 3487)).toBe(true);
    expect(calls).toBe(1);
    expect(await cachedSameUser(async () => { throw new Error("lsof gone"); })(1, 2)).toBe(false);
  });
});
