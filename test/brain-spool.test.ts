import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import { BrainSpool } from "../src/brain-spool.ts";

// In-process fake brain store
type DocStore = Map<string, string>;

function makeFakeBrain(store: DocStore = new Map()) {
  // Replace global fetch with a fake that simulates the brain API
  const fakeFetch = mock(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? new URL(input) : input instanceof URL ? input : new URL(input.url);
    const method = init?.method?.toUpperCase() ?? "GET";
    const path = url.pathname;

    // PUT /v1/brain/doc — write
    if (method === "PUT" && path === "/v1/brain/doc") {
      const body = JSON.parse(init?.body as string ?? "{}") as { path: string; bodyMd: string };
      store.set(body.path, body.bodyMd);
      return Response.json({ path: body.path, bodyMd: body.bodyMd }, { status: 200 });
    }

    // GET /v1/brain/doc — read
    if (method === "GET" && path === "/v1/brain/doc") {
      const docPath = url.searchParams.get("path")!;
      const content = store.get(docPath);
      if (!content) return Response.json({ error: { code: "not_found", message: "not found" } }, { status: 404 });
      return Response.json({ path: docPath, bodyMd: content });
    }

    // GET /v1/brain/list — list by prefix
    if (method === "GET" && path === "/v1/brain/list") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const docs = [...store.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((k) => ({ path: k }));
      return Response.json({ documents: docs });
    }

    // DELETE /v1/brain/doc — delete
    if (method === "DELETE" && path === "/v1/brain/doc") {
      const docPath = url.searchParams.get("path")!;
      store.delete(docPath);
      return Response.json({ deleted: true });
    }

    return Response.json({ error: { code: "not_found", message: "unknown route" } }, { status: 404 });
  });

  return { store, fakeFetch };
}

function makeSpool(store: DocStore, room = "test-room") {
  const { fakeFetch } = makeFakeBrain(store);
  globalThis.fetch = fakeFetch as unknown as typeof fetch;
  return new BrainSpool({ token: "usk_test_1234", room, baseUrl: "https://brain.unisonlabs.ai" });
}

describe("BrainSpool", () => {
  let store: DocStore;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    store = new Map();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("register writes agent doc", async () => {
    const spool = makeSpool(store);
    const record = await spool.register("alice");
    expect(record.name).toBe("alice");
    expect(record.subscriptions).toEqual([]);
    // doc was written to brain
    const agentPath = "/teams/test-room/backchannel/agents/alice.md";
    expect(store.has(agentPath)).toBe(true);
    const content = store.get(agentPath)!;
    expect(content).toContain("# Agent: alice");
    expect(content).toContain("subscriptions:");
  });

  test("register preserves existing subscriptions on re-register", async () => {
    const spool = makeSpool(store);
    await spool.register("alice");
    await spool.subscribe("alice", "#dev");
    const record2 = await spool.register("alice");
    expect(record2.subscriptions).toContain("#dev");
  });

  test("DM send + inbox + take (delete-on-ack)", async () => {
    const spool = makeSpool(store);
    await spool.register("alice");
    await spool.register("bob");

    const sent = await spool.send("alice", "@bob", "hello bob", { priority: "urgent" });
    expect(sent.id).toBeDefined();
    expect(sent.from).toBe("alice");
    expect(sent.to).toBe("@bob");

    const inbox = await spool.inbox("bob");
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.body).toBe("hello bob");
    expect(inbox[0]!.priority).toBe("urgent");

    // take removes the message
    const taken = await spool.take("bob", sent.id);
    expect(taken?.body).toBe("hello bob");
    expect(await spool.inbox("bob")).toHaveLength(0);
  });

  test("take returns null for already-claimed message", async () => {
    const spool = makeSpool(store);
    await spool.register("alice");
    await spool.register("bob");
    const msg = await spool.send("alice", "@bob", "once");

    const first = await spool.take("bob", msg.id);
    expect(first).not.toBeNull();
    const second = await spool.take("bob", msg.id);
    expect(second).toBeNull();
  });

  test("channel fan-out: message goes to all subscribers except sender", async () => {
    const spool = makeSpool(store);
    await spool.register("alice");
    await spool.register("bob");
    await spool.register("carol");
    await spool.subscribe("alice", "#dev");
    await spool.subscribe("bob", "#dev");

    await spool.send("alice", "#dev", "channel msg");

    // alice (sender) gets nothing; bob gets it; carol (not subscribed) gets nothing
    expect(await spool.inbox("alice")).toHaveLength(0);
    expect(await spool.inbox("bob")).toHaveLength(1);
    expect(await spool.inbox("carol")).toHaveLength(0);
  });

  test("channel with no other subscribers throws", async () => {
    const spool = makeSpool(store);
    await spool.register("alice");
    await spool.subscribe("alice", "#solo");
    await expect(spool.send("alice", "#solo", "anyone?")).rejects.toThrow("no other subscribers");
  });

  test("scope is preserved on messages", async () => {
    const spool = makeSpool(store);
    await spool.register("alice");
    await spool.register("bob");
    const sent = await spool.send("alice", "@bob", "scoped msg", { scope: "org/myrepo" });
    expect(sent.scope).toBe("org/myrepo");

    const inbox = await spool.inbox("bob");
    expect(inbox[0]!.scope).toBe("org/myrepo");
  });

  test("send to unknown agent fails", async () => {
    const spool = makeSpool(store);
    await spool.register("alice");
    await expect(spool.send("alice", "@nobody", "hi")).rejects.toThrow("unknown agent");
  });

  test("agents() returns registered agents", async () => {
    const spool = makeSpool(store);
    await spool.register("alice");
    await spool.register("bob");
    const agents = await spool.agents();
    expect(agents.map((a) => a.name).sort()).toEqual(["alice", "bob"]);
  });

  test("channels() aggregates subscriptions", async () => {
    const spool = makeSpool(store);
    await spool.register("alice");
    await spool.register("bob");
    await spool.subscribe("alice", "#dev");
    await spool.subscribe("bob", "#general");
    const channels = await spool.channels();
    expect(channels).toContain("#dev");
    expect(channels).toContain("#general");
  });

  test("watch delivers messages via polling", async () => {
    const spool = makeSpool(store);
    await spool.register("alice");
    await spool.register("bob");

    const received: string[] = [];
    const stop = spool.watch("bob", (m) => received.push(m.body), 50);
    await spool.send("alice", "@bob", "watch msg");
    await new Promise((r) => setTimeout(r, 300));
    stop();
    expect(received).toContain("watch msg");
  });
});
