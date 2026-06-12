import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import { BrainSpool } from "../src/brain-spool.ts";

// In-process fake brain store
type DocStore = Map<string, string>;

interface FakeOpts {
  listBodies?: boolean; // include bodyMd in list responses (the real API does)
  failPut?: (path: string) => boolean;
}

function makeFakeBrain(store: DocStore, opts: FakeOpts = {}) {
  const { listBodies = true, failPut } = opts;
  const requests: string[] = [];
  const fakeFetch = mock(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? new URL(input) : input instanceof URL ? input : new URL(input.url);
    const method = init?.method?.toUpperCase() ?? "GET";
    const path = url.pathname;
    requests.push(`${method} ${path}`);

    if (method === "PUT" && path === "/v1/brain/doc") {
      const body = JSON.parse((init?.body as string) ?? "{}") as { path: string; bodyMd: string };
      if (failPut?.(body.path)) {
        return Response.json({ error: { code: "internal", message: "injected write failure" } }, { status: 500 });
      }
      store.set(body.path, body.bodyMd);
      return Response.json({ path: body.path, bodyMd: body.bodyMd }, { status: 200 });
    }

    if (method === "GET" && path === "/v1/brain/doc") {
      const docPath = url.searchParams.get("path")!;
      const content = store.get(docPath);
      if (content === undefined)
        return Response.json({ error: { code: "not_found", message: "not found" } }, { status: 404 });
      return Response.json({ path: docPath, bodyMd: content });
    }

    if (method === "GET" && path === "/v1/brain/list") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const docs = [...store.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((k) => (listBodies ? { path: k, bodyMd: store.get(k)! } : { path: k }));
      return Response.json({ documents: docs });
    }

    if (method === "DELETE" && path === "/v1/brain/doc") {
      const docPath = url.searchParams.get("path")!;
      store.delete(docPath);
      return Response.json({ deleted: true });
    }

    return Response.json({ error: { code: "not_found", message: "unknown route" } }, { status: 404 });
  });

  return { store, fakeFetch, requests };
}

function makeSpool(store: DocStore, opts: FakeOpts = {}, room = "test-room") {
  const fake = makeFakeBrain(store, opts);
  globalThis.fetch = fake.fakeFetch as unknown as typeof fetch;
  const spool = new BrainSpool({ token: "usk_test_1234", room, baseUrl: "https://brain.unisonlabs.ai" });
  return { spool, requests: fake.requests };
}

const ROOT = "/private/backchannel/test-room";

describe("BrainSpool", () => {
  let store: DocStore;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    store = new Map();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("register writes agent doc under /private/backchannel/<room>/", async () => {
    const { spool } = makeSpool(store);
    const record = await spool.register("alice");
    expect(record.name).toBe("alice");
    expect(record.subscriptions).toEqual([]);
    const agentPath = `${ROOT}/agents/alice.md`;
    expect(store.has(agentPath)).toBe(true);
    const content = store.get(agentPath)!;
    expect(content).toContain("# Agent: alice");
    expect(content).toContain("subscriptions:");
  });

  test("invalid room is rejected at construction", () => {
    expect(() => new BrainSpool({ token: "usk_x", room: "bad room!" })).toThrow("invalid room");
  });

  test("register preserves existing subscriptions on re-register", async () => {
    const { spool } = makeSpool(store);
    await spool.register("alice");
    await spool.subscribe("alice", "#dev");
    const record2 = await spool.register("alice");
    expect(record2.subscriptions).toContain("#dev");
  });

  test("DM send + inbox + take (delete-on-ack)", async () => {
    const { spool } = makeSpool(store);
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

    const taken = await spool.take("bob", sent.id);
    expect(taken?.body).toBe("hello bob");
    expect(await spool.inbox("bob")).toHaveLength(0);
  });

  test("every send leaves a durable archive copy under log/", async () => {
    const { spool } = makeSpool(store);
    await spool.register("alice");
    await spool.register("bob");
    const sent = await spool.send("alice", "@bob", "remember me");
    await spool.take("bob", sent.id);
    // inbox copy gone, log copy survives
    expect(store.has(`${ROOT}/inbox/bob/${sent.id}.md`)).toBe(false);
    expect(store.has(`${ROOT}/log/${sent.id}.md`)).toBe(true);
  });

  test("body survives roundtrip: quotes, backslashes, newlines, ---", async () => {
    const { spool } = makeSpool(store);
    await spool.register("alice");
    await spool.register("bob");
    const evil = 'say "hi" to c:\\temp\\dir\nline2\n---\nbody: "injected"';
    const sent = await spool.send("alice", "@bob", evil);
    const inbox = await spool.inbox("bob");
    expect(inbox[0]!.body).toBe(evil);
    const taken = await spool.take("bob", sent.id);
    expect(taken!.body).toBe(evil);
  });

  test("empty-string body survives roundtrip", async () => {
    const { spool } = makeSpool(store);
    await spool.register("alice");
    await spool.register("bob");
    await spool.send("alice", "@bob", "");
    const inbox = await spool.inbox("bob");
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.body).toBe("");
  });

  test("channel names with commas survive subscription roundtrip", async () => {
    const { spool } = makeSpool(store);
    await spool.register("alice");
    await spool.subscribe("alice", "#a,b");
    expect(await spool.channels()).toEqual(["#a,b"]);
  });

  test("take returns null for already-claimed message", async () => {
    const { spool } = makeSpool(store);
    await spool.register("alice");
    await spool.register("bob");
    const msg = await spool.send("alice", "@bob", "once");

    const first = await spool.take("bob", msg.id);
    expect(first).not.toBeNull();
    const second = await spool.take("bob", msg.id);
    expect(second).toBeNull();
  });

  test("take with keep leaves the inbox copy", async () => {
    const { spool } = makeSpool(store);
    await spool.register("alice");
    await spool.register("bob");
    const msg = await spool.send("alice", "@bob", "peek");
    const peeked = await spool.take("bob", msg.id, true);
    expect(peeked?.body).toBe("peek");
    expect(await spool.inbox("bob")).toHaveLength(1);
  });

  test("channel fan-out: message goes to all subscribers except sender", async () => {
    const { spool } = makeSpool(store);
    await spool.register("alice");
    await spool.register("bob");
    await spool.register("carol");
    await spool.subscribe("alice", "#dev");
    await spool.subscribe("bob", "#dev");

    await spool.send("alice", "#dev", "channel msg");

    expect(await spool.inbox("alice")).toHaveLength(0);
    expect(await spool.inbox("bob")).toHaveLength(1);
    expect(await spool.inbox("carol")).toHaveLength(0);
  });

  test("channel with no other subscribers throws", async () => {
    const { spool } = makeSpool(store);
    await spool.register("alice");
    await spool.subscribe("alice", "#solo");
    await expect(spool.send("alice", "#solo", "anyone?")).rejects.toThrow("no other subscribers");
  });

  test("partial fan-out failure names failed and delivered recipients", async () => {
    const { spool } = makeSpool(store, {
      failPut: (p) => p.includes("/inbox/carol/"),
    });
    await spool.register("alice");
    await spool.register("bob");
    await spool.register("carol");
    await spool.subscribe("bob", "#dev");
    await spool.subscribe("carol", "#dev");

    await expect(spool.send("alice", "#dev", "half")).rejects.toThrow(/carol.*delivered to bob/s);
    expect(await spool.inbox("bob")).toHaveLength(1);
    expect(await spool.inbox("carol")).toHaveLength(0);
  });

  test("scope is preserved on messages", async () => {
    const { spool } = makeSpool(store);
    await spool.register("alice");
    await spool.register("bob");
    const sent = await spool.send("alice", "@bob", "scoped msg", { scope: "org/myrepo" });
    expect(sent.scope).toBe("org/myrepo");

    const inbox = await spool.inbox("bob");
    expect(inbox[0]!.scope).toBe("org/myrepo");
  });

  test("thread and refs are preserved on messages", async () => {
    const { spool } = makeSpool(store);
    await spool.register("alice");
    await spool.register("bob");
    await spool.send("alice", "@bob", "meta", { thread: "T1", refs: ["/tmp/a", "/tmp/b"] });
    const inbox = await spool.inbox("bob");
    expect(inbox[0]!.thread).toBe("T1");
    expect(inbox[0]!.refs).toEqual(["/tmp/a", "/tmp/b"]);
  });

  test("send to unknown agent fails", async () => {
    const { spool } = makeSpool(store);
    await spool.register("alice");
    await expect(spool.send("alice", "@nobody", "hi")).rejects.toThrow("unknown agent");
  });

  test("agents() returns registered agents", async () => {
    const { spool } = makeSpool(store);
    await spool.register("alice");
    await spool.register("bob");
    const agents = await spool.agents();
    expect(agents.map((a) => a.name).sort()).toEqual(["alice", "bob"]);
  });

  test("channels() aggregates subscriptions", async () => {
    const { spool } = makeSpool(store);
    await spool.register("alice");
    await spool.register("bob");
    await spool.subscribe("alice", "#dev");
    await spool.subscribe("bob", "#general");
    const channels = await spool.channels();
    expect(channels).toContain("#dev");
    expect(channels).toContain("#general");
  });

  test("inbox is read-only: no writes during inbox/watch polling", async () => {
    const { spool, requests } = makeSpool(store);
    await spool.register("alice");
    await spool.register("bob");
    await spool.send("alice", "@bob", "hi");
    const before = requests.length;
    await spool.inbox("bob");
    await spool.inbox("bob");
    const newRequests = requests.slice(before);
    expect(newRequests.every((r) => r.startsWith("GET "))).toBe(true);
  });

  test("inbox is a single request when list returns bodies", async () => {
    const { spool, requests } = makeSpool(store);
    await spool.register("alice");
    await spool.register("bob");
    await spool.send("alice", "@bob", "one");
    await spool.send("alice", "@bob", "two");
    const before = requests.length;
    expect(await spool.inbox("bob")).toHaveLength(2);
    expect(requests.length - before).toBe(1);
  });

  test("inbox falls back to per-doc reads when list omits bodies", async () => {
    const { spool } = makeSpool(store, { listBodies: false });
    await spool.register("alice");
    await spool.register("bob");
    await spool.send("alice", "@bob", "no-body-list");
    const inbox = await spool.inbox("bob");
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.body).toBe("no-body-list");
  });

  test("watch delivers messages via polling", async () => {
    const { spool } = makeSpool(store);
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
