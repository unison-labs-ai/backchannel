import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsSpool } from "../src/fs-spool.ts";
import { HttpSpool } from "../src/http-spool.ts";
import { startRelay } from "../src/relay.ts";
import { matchesScope } from "../src/types.ts";
import type { Message } from "../src/types.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bch-test-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("FsSpool", () => {
  test("direct message: send, inbox, take deletes", async () => {
    const spool = new FsSpool(root);
    await spool.register("alice");
    await spool.register("bob");

    const sent = await spool.send("alice", "@bob", "hello bob", { priority: "urgent" });
    const inbox = await spool.inbox("bob");
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.body).toBe("hello bob");
    expect(inbox[0]!.priority).toBe("urgent");

    const taken = await spool.take("bob", sent.id);
    expect(taken?.body).toBe("hello bob");
    expect(await spool.inbox("bob")).toHaveLength(0);
  });

  test("take is exclusive: second claim returns null", async () => {
    const spool = new FsSpool(root);
    await spool.register("alice");
    await spool.register("bob");
    const msg = await spool.send("alice", "@bob", "only once");

    const results = await Promise.all([spool.take("bob", msg.id), spool.take("bob", msg.id)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  test("channel fan-out excludes sender, requires subscribers", async () => {
    const spool = new FsSpool(root);
    await spool.register("alice");
    await spool.register("bob");
    await spool.register("carol");
    await spool.subscribe("alice", "#dev");
    await spool.subscribe("bob", "#dev");

    expect(spool.send("alice", "#empty", "anyone?")).rejects.toThrow("no other subscribers");

    await spool.send("alice", "#dev", "channel msg");
    expect(await spool.inbox("alice")).toHaveLength(0);
    expect(await spool.inbox("bob")).toHaveLength(1);
    expect(await spool.inbox("carol")).toHaveLength(0);
  });

  test("send to unknown agent fails", async () => {
    const spool = new FsSpool(root);
    await spool.register("alice");
    expect(spool.send("alice", "@nobody", "hi")).rejects.toThrow("unknown agent");
  });

  test("take --keep moves to cur instead of deleting", async () => {
    const spool = new FsSpool(root);
    await spool.register("alice");
    await spool.register("bob");
    const msg = await spool.send("alice", "@bob", "keep me");
    await spool.take("bob", msg.id, true);
    expect(await spool.inbox("bob")).toHaveLength(0);
    expect(await Bun.file(join(root, "spool", "bob", "cur", `${msg.id}.json`)).exists()).toBe(true);
  });

  test("watch delivers new messages", async () => {
    const spool = new FsSpool(root);
    await spool.register("alice");
    await spool.register("bob");
    const received: string[] = [];
    const stop = spool.watch("bob", (m) => received.push(m.body));
    await spool.send("alice", "@bob", "wake up");
    await new Promise((r) => setTimeout(r, 300));
    stop();
    expect(received).toContain("wake up");
  });
});

describe("scopes", () => {
  const msg = (scope?: string) => ({ scope }) as Message;

  test("unscoped messages match any reader", () => {
    expect(matchesScope(msg(), undefined)).toBe(true);
    expect(matchesScope(msg(), "github.com/org/repo")).toBe(true);
  });

  test("scoped messages need a containing match", () => {
    expect(matchesScope(msg("myrepo"), "github.com/org/myrepo")).toBe(true);
    expect(matchesScope(msg("github.com/org/myrepo"), "github.com/org/myrepo")).toBe(true);
    expect(matchesScope(msg("https://github.com/org/myrepo.git"), "git@github.com:org/myrepo")).toBe(true);
    expect(matchesScope(msg("otherrepo"), "github.com/org/myrepo")).toBe(false);
    expect(matchesScope(msg("myrepo"), undefined)).toBe(false);
  });

  test("scoped message waits for a matching reader", async () => {
    const spool = new FsSpool(root);
    await spool.register("alice");
    await spool.register("bob");
    const scoped = await spool.send("alice", "@bob", "rebase your branch", { scope: "org/myrepo" });
    const unscoped = await spool.send("alice", "@bob", "general note");

    const otherSession = (await spool.inbox("bob")).filter((m) => matchesScope(m, "github.com/org/unrelated"));
    expect(otherSession.map((m) => m.id)).toEqual([unscoped.id]);

    const rightSession = (await spool.inbox("bob")).filter((m) => matchesScope(m, "github.com/org/myrepo"));
    expect(rightSession.map((m) => m.id).sort()).toEqual([scoped.id, unscoped.id].sort());
  });
});

describe("relay auth", () => {
  test("register issues per-agent tokens; room token required", async () => {
    const server = startRelay({ port: 0, token: "room-secret", root });
    const url = server.url.toString().replace(/\/$/, "");

    const noToken = await fetch(`${url}/v1/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "alice" }),
    });
    expect(noToken.status).toBe(401);

    const lobby = new HttpSpool(url, "room-secret");
    const alice = await lobby.register("alice");
    expect(alice.token).toBeDefined();
    expect((alice as Record<string, unknown>).tokenHash).toBeUndefined();

    server.stop(true);
  });

  test("registered names cannot be taken over with the room token", async () => {
    const server = startRelay({ port: 0, token: "room-secret", root });
    const url = server.url.toString().replace(/\/$/, "");
    const lobby = new HttpSpool(url, "room-secret");
    const alice = await lobby.register("alice");

    expect(lobby.register("alice")).rejects.toThrow("present its token");

    const aliceSpool = new HttpSpool(url, alice.token);
    const again = await aliceSpool.register("alice");
    expect(again.name).toBe("alice");
    server.stop(true);
  });

  test("from is server-enforced; inboxes are private", async () => {
    const server = startRelay({ port: 0, token: "room-secret", root });
    const url = server.url.toString().replace(/\/$/, "");
    const lobby = new HttpSpool(url, "room-secret");
    const alice = await lobby.register("alice");
    const bob = await lobby.register("bob");
    const aliceSpool = new HttpSpool(url, alice.token);
    const bobSpool = new HttpSpool(url, bob.token);

    await aliceSpool.send("bob", "@bob", "spoofed?");
    const inbox = await bobSpool.inbox("bob");
    expect(inbox[0]!.from).toBe("alice");

    expect(aliceSpool.inbox("bob")).rejects.toThrow('token is for "alice"');

    const roomReader = new HttpSpool(url, "room-secret");
    expect(roomReader.agents()).rejects.toThrow("agent token required");
    server.stop(true);
  });

  test("end-to-end channel flow with per-agent tokens + SSE", async () => {
    const server = startRelay({ port: 0, root });
    const url = server.url.toString().replace(/\/$/, "");
    const lobby = new HttpSpool(url);
    const alice = await lobby.register("alice");
    const bob = await lobby.register("bob");
    const aliceSpool = new HttpSpool(url, alice.token);
    const bobSpool = new HttpSpool(url, bob.token);

    await aliceSpool.subscribe("alice", "#dev");
    await bobSpool.subscribe("bob", "#dev");

    const received: string[] = [];
    const stop = bobSpool.watch("bob", (m) => received.push(m.body));
    await new Promise((r) => setTimeout(r, 200));
    await aliceSpool.send("alice", "#dev", "over the wire");
    await new Promise((r) => setTimeout(r, 500));
    stop();

    expect(received).toContain("over the wire");
    const inbox = await bobSpool.inbox("bob");
    expect(inbox).toHaveLength(1);
    expect(await bobSpool.take("bob", inbox[0]!.id)).not.toBeNull();
    expect(await bobSpool.inbox("bob")).toHaveLength(0);
    server.stop(true);
  });
});
