import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsSpool } from "../src/fs-spool.ts";
import { HttpSpool } from "../src/http-spool.ts";
import { startRelay } from "../src/relay.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bch-test-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("FsSpool", () => {
  test("direct message: send, inbox, ack deletes", async () => {
    const spool = new FsSpool(root);
    await spool.register("alice");
    await spool.register("bob");

    const sent = await spool.send("alice", "@bob", "hello bob", { priority: "urgent" });
    const inbox = await spool.inbox("bob");
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.body).toBe("hello bob");
    expect(inbox[0]!.priority).toBe("urgent");
    expect(inbox[0]!.id).toBe(sent.id);

    await spool.ack("bob", sent.id);
    expect(await spool.inbox("bob")).toHaveLength(0);
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

  test("ack --keep moves to cur instead of deleting", async () => {
    const spool = new FsSpool(root);
    await spool.register("alice");
    await spool.register("bob");
    const msg = await spool.send("alice", "@bob", "keep me");
    await spool.ack("bob", msg.id, true);
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

describe("relay + HttpSpool", () => {
  test("end-to-end over HTTP with auth", async () => {
    const server = startRelay({ port: 0, token: "secret", root });
    const url = server.url.toString().replace(/\/$/, "");

    const unauthorized = await fetch(`${url}/v1/agents`);
    expect(unauthorized.status).toBe(401);

    const spool = new HttpSpool(url, "secret");
    await spool.register("alice");
    await spool.register("bob");
    await spool.subscribe("bob", "#dev");
    await spool.subscribe("alice", "#dev");

    await spool.send("alice", "#dev", "over the wire");
    const inbox = await spool.inbox("bob");
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.body).toBe("over the wire");

    await spool.ack("bob", inbox[0]!.id);
    expect(await spool.inbox("bob")).toHaveLength(0);

    expect(await spool.channels()).toEqual(["#dev"]);
    server.stop(true);
  });

  test("SSE watch delivers over HTTP", async () => {
    const server = startRelay({ port: 0, root });
    const url = server.url.toString().replace(/\/$/, "");
    const spool = new HttpSpool(url);
    await spool.register("alice");
    await spool.register("bob");

    const received: string[] = [];
    const stop = spool.watch("bob", (m) => received.push(m.body));
    await new Promise((r) => setTimeout(r, 200));
    await spool.send("alice", "@bob", "sse ping");
    await new Promise((r) => setTimeout(r, 500));
    stop();
    server.stop(true);
    expect(received).toContain("sse ping");
  });
});
