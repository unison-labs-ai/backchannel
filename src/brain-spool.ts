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
  bodyMd: string;
}

interface BrainListResult {
  documents: { path: string }[];
}

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
    if (val.startsWith("[") && val.endsWith("]")) {
      meta[key] = val
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    } else if (val.startsWith('"') && val.endsWith('"')) {
      meta[key] = val.slice(1, -1);
    } else if (!isNaN(Number(val)) && val !== "") {
      meta[key] = Number(val);
    } else {
      meta[key] = val;
    }
  }
  return { meta, body };
}

function serializeAgentDoc(record: AgentRecord): string {
  const subs = JSON.stringify(record.subscriptions);
  return `---\nsubscriptions: ${subs}\ncreatedAt: "${record.createdAt}"\nlastSeen: "${record.lastSeen}"\n---\n# Agent: ${record.name}\n`;
}

function serializeMessageDoc(msg: Message): string {
  const refsLine = msg.refs?.length ? `\nrefs: ${JSON.stringify(msg.refs)}` : "";
  const threadLine = msg.thread ? `\nthread: "${msg.thread}"` : "";
  const scopeLine = msg.scope ? `\nscope: "${msg.scope}"` : "";
  return (
    `---\nid: "${msg.id}"\nfrom: "${msg.from}"\nto: "${msg.to}"\npriority: "${msg.priority}"\nts: "${msg.ts}"` +
    `${scopeLine}${threadLine}${refsLine}\nbody: ${JSON.stringify(msg.body)}\n---\n# Message from ${msg.from}\n${msg.body}\n`
  );
}

function parseMessageDoc(content: string): Message | null {
  const { meta } = parseFrontmatter(content);
  if (!meta.id || !meta.from || !meta.to || !meta.body) return null;
  return {
    id: meta.id as string,
    from: meta.from as string,
    to: meta.to as string,
    body: meta.body as string,
    priority: (meta.priority as "normal" | "urgent") ?? "normal",
    ts: meta.ts as string,
    ...(meta.scope ? { scope: meta.scope as string } : {}),
    ...(meta.thread ? { thread: meta.thread as string } : {}),
    ...(meta.refs ? { refs: meta.refs as string[] } : {}),
  };
}

export class BrainSpool implements Spool {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly prefix: string;

  constructor(opts: BrainSpoolOpts) {
    this.token = opts.token;
    this.baseUrl = (opts.baseUrl ?? "https://brain.unisonlabs.ai").replace(/\/$/, "");
    this.prefix = opts.pathPrefix ?? `/teams/${opts.room}/backchannel/`;
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      authorization: `Bearer ${this.token}`,
    };
  }

  private async brainWrite(path: string, bodyMd: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/v1/brain/doc`, {
      method: "PUT",
      headers: this.headers(),
      body: JSON.stringify({ path, bodyMd }),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      throw new Error(data.error?.message ?? `brain write error ${res.status}`);
    }
  }

  private async brainRead(path: string): Promise<string | null> {
    const res = await fetch(`${this.baseUrl}/v1/brain/doc?path=${encodeURIComponent(path)}`, {
      headers: this.headers(),
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      throw new Error(data.error?.message ?? `brain read error ${res.status}`);
    }
    const data = (await res.json()) as BrainDoc;
    return data.bodyMd;
  }

  private async brainDelete(path: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/v1/brain/doc?path=${encodeURIComponent(path)}`, {
      method: "DELETE",
      headers: this.headers(),
    });
    if (!res.ok && res.status !== 404) {
      const data = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      throw new Error(data.error?.message ?? `brain delete error ${res.status}`);
    }
  }

  private async brainList(prefix: string): Promise<string[]> {
    const res = await fetch(`${this.baseUrl}/v1/brain/list?prefix=${encodeURIComponent(prefix)}`, {
      headers: this.headers(),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      throw new Error(data.error?.message ?? `brain list error ${res.status}`);
    }
    const data = (await res.json()) as BrainListResult;
    return (data.documents ?? []).map((d) => d.path);
  }

  private agentPath(name: string): string {
    return `${this.prefix}agents/${name}.md`;
  }

  private msgPath(recipient: string, id: string): string {
    return `${this.prefix}inbox/${recipient}/${id}.md`;
  }

  async register(name: string): Promise<Registration> {
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) {
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
    await this.brainWrite(this.agentPath(name), serializeAgentDoc(record));
    return record;
  }

  private async readAgent(name: string): Promise<AgentRecord | null> {
    const content = await this.brainRead(this.agentPath(name));
    if (!content) return null;
    const { meta } = parseFrontmatter(content);
    return {
      name,
      subscriptions: (meta.subscriptions as string[]) ?? [],
      createdAt: (meta.createdAt as string) ?? new Date().toISOString(),
      lastSeen: (meta.lastSeen as string) ?? new Date().toISOString(),
    };
  }

  async agents(): Promise<AgentRecord[]> {
    const paths = await this.brainList(`${this.prefix}agents/`);
    const records: AgentRecord[] = [];
    for (const p of paths) {
      if (!p.endsWith(".md")) continue;
      const name = p.split("/").pop()!.replace(/\.md$/, "");
      const record = await this.readAgent(name);
      if (record) records.push(record);
    }
    return records.sort((a, b) => a.name.localeCompare(b.name));
  }

  async subscribe(agent: string, channel: string): Promise<void> {
    const record = await this.readAgent(agent);
    if (!record) throw new Error(`unknown agent "${agent}" — run \`bch init ${agent}\` first`);
    const name = channel.startsWith("#") ? channel : `#${channel}`;
    if (!record.subscriptions.includes(name)) record.subscriptions.push(name);
    await this.brainWrite(this.agentPath(agent), serializeAgentDoc(record));
  }

  async unsubscribe(agent: string, channel: string): Promise<void> {
    const record = await this.readAgent(agent);
    if (!record) return;
    const name = channel.startsWith("#") ? channel : `#${channel}`;
    record.subscriptions = record.subscriptions.filter((c) => c !== name);
    await this.brainWrite(this.agentPath(agent), serializeAgentDoc(record));
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
    if (isChannel(to)) {
      recipients = (await this.agents())
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

    const docBody = serializeMessageDoc(msg);
    for (const rcpt of recipients) {
      await this.brainWrite(this.msgPath(rcpt, msg.id), docBody);
    }
    await this.touchAgent(from);
    return msg;
  }

  private async touchAgent(name: string): Promise<void> {
    const record = await this.readAgent(name);
    if (!record) return;
    record.lastSeen = new Date().toISOString();
    await this.brainWrite(this.agentPath(name), serializeAgentDoc(record));
  }

  async inbox(agent: string): Promise<Message[]> {
    const paths = await this.brainList(`${this.prefix}inbox/${agent}/`);
    const messages: Message[] = [];
    for (const p of paths) {
      if (!p.endsWith(".md")) continue;
      const content = await this.brainRead(p);
      if (!content) continue;
      const msg = parseMessageDoc(content);
      if (msg) messages.push(msg);
    }
    await this.touchAgent(agent);
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

  watch(agent: string, onMessage: (msg: Message) => void, pollMs = 2_000): () => void {
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
