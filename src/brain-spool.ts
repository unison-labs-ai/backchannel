import type { AgentRecord, Message, Registration, SendOpts, Spool } from "./types.ts";
import { isChannel, normalizeTarget } from "./types.ts";

export interface BrainSpoolOpts {
  token: string;
  baseUrl?: string;
  room: string;
  pathPrefix?: string;
}

interface BrainDoc {
  path: string;
  bodyMd?: string;
}

interface BrainListResult {
  documents: BrainDoc[];
}

const SLUG_RE = /^[a-z0-9][a-z0-9._-]*$/i;

// Error bodies are usually {error:{message}}, but transient gateway errors
// can be plain text or literal JSON null — never let those crash the parse.
async function errorMessage(res: Response, fallback: string): Promise<string> {
  const data = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  return data?.error?.message ?? fallback;
}

// Frontmatter values are JSON-encoded on write and JSON-decoded on read, so
// quotes, backslashes, newlines and "---" in message bodies survive the trip.
function parseFrontmatter(content: string): { meta: Record<string, unknown>; body: string } {
  if (!content.startsWith("---\n")) return { meta: {}, body: content };
  const end = content.indexOf("\n---\n", 4);
  if (end === -1) return { meta: {}, body: content };
  const raw = content.slice(4, end);
  const body = content.slice(end + 5);
  const meta: Record<string, unknown> = {};
  for (const line of raw.split("\n")) {
    const colon = line.indexOf(": ");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const val = line.slice(colon + 2).trim();
    try {
      meta[key] = JSON.parse(val);
    } catch {
      meta[key] = val;
    }
  }
  return { meta, body };
}

function fmLine(key: string, value: unknown): string {
  return `${key}: ${JSON.stringify(value)}`;
}

function serializeAgentDoc(record: AgentRecord): string {
  const lines = [
    fmLine("subscriptions", record.subscriptions),
    fmLine("createdAt", record.createdAt),
    fmLine("lastSeen", record.lastSeen),
  ];
  return `---\n${lines.join("\n")}\n---\n# Agent: ${record.name}\n`;
}

function serializeMessageDoc(msg: Message): string {
  const lines = [
    fmLine("id", msg.id),
    fmLine("from", msg.from),
    fmLine("to", msg.to),
    fmLine("priority", msg.priority),
    fmLine("ts", msg.ts),
  ];
  if (msg.scope) lines.push(fmLine("scope", msg.scope));
  if (msg.thread) lines.push(fmLine("thread", msg.thread));
  if (msg.refs?.length) lines.push(fmLine("refs", msg.refs));
  lines.push(fmLine("body", msg.body));
  return `---\n${lines.join("\n")}\n---\n# ${msg.from} → ${msg.to}\n\n${msg.body}\n`;
}

function parseMessageDoc(content: string): Message | null {
  const { meta } = parseFrontmatter(content);
  if (
    typeof meta.id !== "string" ||
    typeof meta.from !== "string" ||
    typeof meta.to !== "string" ||
    typeof meta.ts !== "string"
  ) {
    return null;
  }
  // The frontmatter is the source of truth for the body too: the markdown
  // section below it is presentation for humans browsing the brain.
  if (typeof meta.body !== "string") return null;
  return {
    id: meta.id,
    from: meta.from,
    to: meta.to,
    body: meta.body,
    priority: meta.priority === "urgent" ? "urgent" : "normal",
    ts: meta.ts,
    ...(typeof meta.scope === "string" ? { scope: meta.scope } : {}),
    ...(typeof meta.thread === "string" ? { thread: meta.thread } : {}),
    ...(Array.isArray(meta.refs) ? { refs: meta.refs.map(String) } : {}),
  };
}

export class BrainSpool implements Spool {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly prefix: string;

  constructor(opts: BrainSpoolOpts) {
    this.token = opts.token;
    this.baseUrl = (opts.baseUrl ?? "https://brain.unisonlabs.ai").replace(/\/$/, "");
    if (!opts.pathPrefix && !SLUG_RE.test(opts.room)) {
      throw new Error(`invalid room "${opts.room}" (use letters, digits, . _ -)`);
    }
    // /private/<...> is the brain's free-form writable namespace: nested
    // paths are allowed, and the caller can delete their own docs — both
    // required for spool semantics. /teams/<slug>/ only admits a fixed set
    // of single-level shapes, so it cannot host the spool layout.
    this.prefix = opts.pathPrefix ?? `/private/backchannel/${opts.room}/`;
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      authorization: `Bearer ${this.token}`,
    };
  }

  // The hosted service rate-limits per API key (429) and occasionally answers
  // a request burst with a transient 5xx (sometimes with a literal `null`
  // JSON body). Every spool request is idempotent — same-doc PUT, DELETE,
  // GET — so retry a couple of times before surfacing the error.
  private async brainFetch(url: string, init?: RequestInit): Promise<Response> {
    let lastError: unknown;
    let backoffMs = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise<void>((r) => setTimeout(r, backoffMs));
      try {
        const res = await fetch(url, init);
        if (res.status === 429) {
          const retryAfter = Number(res.headers.get("retry-after"));
          backoffMs = Math.min(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1_000 * (attempt + 1), 5_000);
          lastError = new Error(await errorMessage(res, "brain rate limit exceeded (429)"));
          continue;
        }
        if (res.status >= 500) {
          backoffMs = 300 * (attempt + 1);
          lastError = new Error(await errorMessage(res, `brain error ${res.status}`));
          continue;
        }
        return res;
      } catch (err) {
        backoffMs = 300 * (attempt + 1);
        lastError = err;
      }
    }
    throw lastError;
  }

  private async brainWrite(path: string, bodyMd: string, title?: string): Promise<void> {
    const res = await this.brainFetch(`${this.baseUrl}/v1/brain/doc`, {
      method: "PUT",
      headers: this.headers(),
      body: JSON.stringify({ path, bodyMd, ...(title ? { title } : {}) }),
    });
    if (!res.ok) throw new Error(await errorMessage(res, `brain write error ${res.status}`));
  }

  private async brainRead(path: string): Promise<string | null> {
    const res = await this.brainFetch(`${this.baseUrl}/v1/brain/doc?path=${encodeURIComponent(path)}`, {
      headers: this.headers(),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(await errorMessage(res, `brain read error ${res.status}`));
    const data = (await res.json()) as BrainDoc | null;
    return data?.bodyMd ?? null;
  }

  private async brainDelete(path: string): Promise<void> {
    const res = await this.brainFetch(`${this.baseUrl}/v1/brain/doc?path=${encodeURIComponent(path)}`, {
      method: "DELETE",
      headers: this.headers(),
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(await errorMessage(res, `brain delete error ${res.status}`));
    }
  }

  // The brain's list endpoint returns full documents (bodyMd inline), so one
  // request covers what would otherwise be a list + N reads. Falls back to
  // per-doc reads if a server omits bodies.
  private async brainListDocs(prefix: string): Promise<{ path: string; bodyMd: string }[]> {
    const res = await this.brainFetch(`${this.baseUrl}/v1/brain/list?prefix=${encodeURIComponent(prefix)}`, {
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(await errorMessage(res, `brain list error ${res.status}`));
    const data = ((await res.json()) ?? {}) as BrainListResult;
    const docs: { path: string; bodyMd: string }[] = [];
    for (const d of data.documents ?? []) {
      if (!d.path.endsWith(".md")) continue;
      const bodyMd = d.bodyMd ?? (await this.brainRead(d.path));
      if (bodyMd !== null) docs.push({ path: d.path, bodyMd });
    }
    return docs;
  }

  private agentPath(name: string): string {
    return `${this.prefix}agents/${name}.md`;
  }

  private msgPath(recipient: string, id: string): string {
    return `${this.prefix}inbox/${recipient}/${id}.md`;
  }

  private logPath(id: string): string {
    return `${this.prefix}log/${id}.md`;
  }

  async register(name: string): Promise<Registration> {
    if (!SLUG_RE.test(name)) {
      throw new Error(`invalid agent name "${name}" (use letters, digits, . _ -)`);
    }
    const now = new Date().toISOString();
    const existing = await this.readAgent(name);
    const record: AgentRecord = existing ?? {
      name,
      subscriptions: [],
      createdAt: now,
      lastSeen: now,
    };
    record.lastSeen = now;
    await this.brainWrite(this.agentPath(name), serializeAgentDoc(record), `bch agent: ${name}`);
    return record;
  }

  private parseAgentDoc(name: string, content: string): AgentRecord {
    const { meta } = parseFrontmatter(content);
    return {
      name,
      subscriptions: Array.isArray(meta.subscriptions) ? meta.subscriptions.map(String) : [],
      createdAt: typeof meta.createdAt === "string" ? meta.createdAt : new Date().toISOString(),
      lastSeen: typeof meta.lastSeen === "string" ? meta.lastSeen : new Date().toISOString(),
    };
  }

  private async readAgent(name: string): Promise<AgentRecord | null> {
    const content = await this.brainRead(this.agentPath(name));
    if (!content) return null;
    return this.parseAgentDoc(name, content);
  }

  async agents(): Promise<AgentRecord[]> {
    const docs = await this.brainListDocs(`${this.prefix}agents/`);
    return docs
      .map((d) => this.parseAgentDoc(d.path.split("/").pop()!.replace(/\.md$/, ""), d.bodyMd))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async subscribe(agent: string, channel: string): Promise<void> {
    const record = await this.readAgent(agent);
    if (!record) throw new Error(`unknown agent "${agent}" — run \`bch init ${agent}\` first`);
    const name = channel.startsWith("#") ? channel : `#${channel}`;
    if (!record.subscriptions.includes(name)) record.subscriptions.push(name);
    record.lastSeen = new Date().toISOString();
    await this.brainWrite(this.agentPath(agent), serializeAgentDoc(record), `bch agent: ${agent}`);
  }

  async unsubscribe(agent: string, channel: string): Promise<void> {
    const record = await this.readAgent(agent);
    if (!record) return;
    const name = channel.startsWith("#") ? channel : `#${channel}`;
    record.subscriptions = record.subscriptions.filter((c) => c !== name);
    record.lastSeen = new Date().toISOString();
    await this.brainWrite(this.agentPath(agent), serializeAgentDoc(record), `bch agent: ${agent}`);
  }

  async channels(): Promise<string[]> {
    const all = new Set<string>();
    for (const a of await this.agents()) for (const c of a.subscriptions) all.add(c);
    return [...all].sort();
  }

  async send(from: string, to: string, body: string, opts: SendOpts = {}): Promise<Message> {
    const msg: Message = {
      id: crypto.randomUUID(),
      from,
      to,
      body,
      priority: opts.priority ?? "normal",
      ...(opts.scope ? { scope: opts.scope } : {}),
      ...(opts.thread ? { thread: opts.thread } : {}),
      ...(opts.refs?.length ? { refs: opts.refs } : {}),
      ts: new Date().toISOString(),
    };

    let recipients: string[];
    let sender: AgentRecord | null = null;
    if (isChannel(to)) {
      const all = await this.agents();
      sender = all.find((a) => a.name === from) ?? null;
      recipients = all
        .filter((a) => a.subscriptions.includes(to) && a.name !== from)
        .map((a) => a.name);
      if (recipients.length === 0) {
        throw new Error(`channel ${to} has no other subscribers — nothing to deliver`);
      }
    } else {
      const name = normalizeTarget(to);
      if (!(await this.readAgent(name))) {
        throw new Error(`unknown agent "${name}" — they must \`bch init ${name}\` first`);
      }
      recipients = [name];
    }

    // Archive copy first: every message becomes a durable brain doc under
    // log/, independent of inbox lifecycle (inbox copies are deleted on take).
    const docBody = serializeMessageDoc(msg);
    const title = `bch: ${from} → ${to}`;
    await this.brainWrite(this.logPath(msg.id), docBody, title);

    const delivered: string[] = [];
    const failed: string[] = [];
    let lastError = "";
    for (const rcpt of recipients) {
      try {
        await this.brainWrite(this.msgPath(rcpt, msg.id), docBody, title);
        delivered.push(rcpt);
      } catch (err) {
        failed.push(rcpt);
        lastError = err instanceof Error ? err.message : String(err);
      }
    }
    if (failed.length > 0) {
      const got = delivered.length > 0 ? ` (already delivered to ${delivered.join(", ")})` : "";
      throw new Error(`delivery to ${failed.join(", ")} failed: ${lastError}${got}`);
    }

    await this.touchAgent(from, sender);
    return msg;
  }

  // Best-effort: lastSeen is cosmetic, and by the time it runs the message is
  // already delivered — a failed touch must not turn a successful send into
  // an error.
  private async touchAgent(name: string, cached: AgentRecord | null = null): Promise<void> {
    try {
      const record = cached ?? (await this.readAgent(name));
      if (!record) return;
      record.lastSeen = new Date().toISOString();
      await this.brainWrite(this.agentPath(name), serializeAgentDoc(record), `bch agent: ${name}`);
    } catch {
      // delivery already succeeded; stale lastSeen is the lesser evil
    }
  }

  // Read-only: one list request, no lastSeen write — watch polls this every
  // couple of seconds and must not churn doc versions in the brain.
  async inbox(agent: string): Promise<Message[]> {
    const docs = await this.brainListDocs(`${this.prefix}inbox/${agent}/`);
    const messages: Message[] = [];
    for (const d of docs) {
      const msg = parseMessageDoc(d.bodyMd);
      if (msg) messages.push(msg);
    }
    return messages.sort((a, b) => a.ts.localeCompare(b.ts));
  }

  async take(agent: string, id: string, keep = false): Promise<Message | null> {
    const path = this.msgPath(agent, id);
    const content = await this.brainRead(path);
    if (!content) return null;
    const msg = parseMessageDoc(content);
    if (!msg) return null;
    if (!keep) await this.brainDelete(path);
    return msg;
  }

  // 5s poll: the hosted API rate-limits per key, and a watching agent holds
  // the poll open indefinitely — 12 read requests/min leaves headroom for
  // the actual sends.
  watch(agent: string, onMessage: (msg: Message) => void, pollMs = 5_000): () => void {
    const seen = new Set<string>();
    let stopped = false;

    const poll = async () => {
      while (!stopped) {
        try {
          for (const msg of await this.inbox(agent)) {
            if (seen.has(msg.id)) continue;
            seen.add(msg.id);
            onMessage(msg);
          }
        } catch {
          // network hiccup — retry next cycle
        }
        await new Promise<void>((r) => setTimeout(r, pollMs));
      }
    };

    void poll();
    return () => {
      stopped = true;
    };
  }
}
