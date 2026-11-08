import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChangeRecord } from "../src/shared/api.ts";
import { readGroups } from "../src/machine/groups.ts";
import { fileJournal } from "../src/machine/journal.ts";
import { gatewayBase, providersPath, stateDir } from "../src/machine/locate.ts";
import { health, listen } from "../src/server/listen.ts";
import { loadPeerConfig, parseConfig, plainHttpAllowed } from "../src/server/config.ts";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "route-inspector-io-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const change = (id: string): ChangeRecord => ({ id, at: "2026-11-08T10:00:00Z", pool: "pool-a", op: { type: "add", member: "upa/a1" }, before: [], after: ["upa/a1"], by: "local" });

describe("file journal", () => {
  test("keeps changes across instances, readable by the user alone, skipping damaged lines", async () => {
    const path = join(dir, "state", "changes.jsonl");
    await fileJournal(path).append(change("c1"));
    await writeFile(path, `${await Bun.file(path).text()}not json\n{"id":1}\n`);
    await fileJournal(path).append({ ...change("c2"), undoOf: "c1", op: { type: "move", member: "upa/a1", to: 0 } });
    const listed = await fileJournal(path).list();
    expect(listed.map((c) => [c.id, c.undoOf])).toEqual([["c1", undefined], ["c2", "c1"]]);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("trims itself to the most recent changes", async () => {
    const path = join(dir, "trim.jsonl");
    const journal = fileJournal(path);
    for (let i = 0; i < 401; i += 1) await journal.append(change(`c${i}`));
    const listed = await journal.list();
    expect(listed).toHaveLength(200);
    expect(listed.at(-1)?.id).toBe("c400");
  });

  test("starts empty without a file", async () => {
    expect(await fileJournal(join(dir, "none.jsonl")).list()).toEqual([]);
  });
});

describe("providers.json on disk", () => {
  test("reads pools, answers none without a file, and refuses one it can't parse", async () => {
    const path = join(dir, "providers.json");
    await writeFile(path, JSON.stringify({ providers: [{ id: "p", key: "sk-x" }], groups: [{ id: "g", name: "G", routing: "order", members: ["p/m"] }] }));
    expect(await readGroups(path)).toEqual([{ id: "g", name: "G", routing: "order", members: ["p/m"] }]);
    expect(await readGroups(join(dir, "missing.json"))).toEqual([]);
    await writeFile(path, "{broken");
    await expect(readGroups(path)).rejects.toMatchObject({ state: "error" });
  });
});

describe("where things are", () => {
  test("follows the XDG directories and MAGPIE_ADDR the plugin host gives", () => {
    expect(providersPath({ XDG_CONFIG_HOME: "/x/config", HOME: "/h" })).toBe("/x/config/magpie/providers.json");
    expect(providersPath({ HOME: "/h" })).toBe("/h/.config/magpie/providers.json");
    expect(stateDir({ XDG_STATE_HOME: "/x/state" })).toBe("/x/state/magpie-route-inspector");
    expect(gatewayBase({})).toBe("http://127.0.0.1:3425");
    expect(gatewayBase({ MAGPIE_ADDR: "0.0.0.0:3611" })).toBe("http://127.0.0.1:3611");
    expect(gatewayBase({ MAGPIE_ADDR: ":3611" })).toBe("http://127.0.0.1:3611");
    expect(gatewayBase({ MAGPIE_ADDR: "[::1]:3611" })).toBe("http://[::1]:3611");
    expect(gatewayBase({ MAGPIE_ADDR: "nonsense" })).toBe("http://127.0.0.1:3425");
  });
});

describe("configuration", () => {
  test("lets cleartext through on private networks only", () => {
    for (const host of ["127.0.0.1", "localhost", "[::1]", "10.1.2.3", "172.20.0.1", "192.168.1.20", "100.101.102.103", "box.tail1234.ts.net", "nas.local"]) {
      expect(plainHttpAllowed(host)).toBe(true);
    }
    for (const host of ["8.8.8.8", "172.32.0.1", "100.128.0.1", "magpie.example.com"]) expect(plainHttpAllowed(host)).toBe(false);
  });

  test("derives the peer address and refuses a key over public cleartext", () => {
    const config = parseConfig({ remotes: [{ id: "vps", name: "vps", url: "https://magpie.example.com/v1", key: "k-0123456789abcdef", peer: true }] });
    expect(config.remotes[0]?.peer).toBe("https://magpie.example.com/inspector/");
    expect(parseConfig({ remotes: [{ id: "a", name: "A", url: "https://m.example.com", peer: "https://m.example.com/x" }] }).remotes[0]?.peer).toBe("https://m.example.com/x/");
    expect(() => parseConfig({ remotes: [{ id: "a", name: "A", url: "http://magpie.example.com" }] })).toThrow("https://");
    expect(() => parseConfig({ remotes: [{ id: "a", name: "A", url: "https://m.example.com", peer: "http://m.example.com/inspector" }] })).toThrow("https://");
    expect(() => parseConfig({ remotes: [{ id: "local", name: "L", url: "https://m.example.com" }] })).toThrow("local");
  });

  test("checks the peer listener and its writers", async () => {
    expect(parseConfig({ peer: { listen: "127.0.0.1:3488", writers: ["laptop"] } }).peer).toEqual({ host: "127.0.0.1", port: 3488, basePath: "/inspector", writers: ["laptop"] });
    for (const peer of [{ listen: "0.0.0.0:3488" }, { listen: "8.8.8.8:3488" }, { listen: "127.0.0.1:80" }, { listen: "127.0.0.1:3488", writers: "laptop" }, { listen: "127.0.0.1:3488", basePath: "inspector" }]) {
      expect(() => parseConfig({ peer })).toThrow("配置错误");
    }
    const path = join(dir, "peer-config.json");
    await writeFile(path, JSON.stringify({ remotes: "mid-edit", peer: { listen: "127.0.0.1:3490" } }));
    expect((await loadPeerConfig({ config: path }))?.port).toBe(3490);
  });
});

describe("taking the port", () => {
  const serve = (port: number, body: () => Response) => Bun.serve({ hostname: "127.0.0.1", port, fetch: body });

  test("stands by for this build's other copy, then takes the port when it lets go", async () => {
    const holder = serve(0, () => Response.json(health()));
    const port = holder.port as number;
    let late: ReturnType<typeof Bun.serve> | null = null;
    const listening = await listen(() => serve(port, () => new Response("new")), port, `http://127.0.0.1:${port}/healthz`, (server) => { late = server; }, { attempts: 2, delayMs: 10, standbyMs: 50 });
    expect(listening.standby).toBe(true);
    holder.stop(true);
    for (let i = 0; i < 40 && !late; i += 1) await Bun.sleep(50);
    expect(late).not.toBeNull();
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("new");
    listening.stop();
  });

  test("refuses a port someone else holds", async () => {
    const other = serve(0, () => new Response("someone else"));
    const port = other.port as number;
    await expect(listen(() => serve(port, () => new Response("")), port, `http://127.0.0.1:${port}/healthz`, () => {}, { attempts: 2, delayMs: 10 })).rejects.toThrow("其他程序");
    other.stop(true);
  });

  test("takes the port once a dying host lets go of it", async () => {
    const dying = serve(0, () => new Response("old"));
    const port = dying.port as number;
    setTimeout(() => dying.stop(true), 60);
    const listening = await listen(() => serve(port, () => new Response("new")), port, `http://127.0.0.1:${port}/healthz`, () => {}, { attempts: 20, delayMs: 20 });
    expect(listening.server).not.toBeNull();
    listening.stop();
  });
});
