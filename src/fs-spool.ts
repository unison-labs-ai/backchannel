import { mkdirSync, readdirSync, renameSync, rmSync, watch as fsWatch, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { AgentRecord, Message, SendOpts, Spool } from "./types.ts";
import { isChannel, normalizeTarget } from "./types.ts";

export function defaultRoot(): string {
  return process.env.BACKCHANNEL_HOME ?? join(homedir(), ".backchannel");
}

export class FsSpool implements Spool {
  constructor(readonly root: string = defaultRoot()) {
    mkdirSync(join(root, "agents"), { recursive: true });
  }

  private agentFile(name: string): string {
    return join(this.root, "agents", `${name}.json`);
  }

  private spoolDir(agent: string, box: "tmp" | "new" | "cur"): string {
    const dir = join(this.root, "spool", agent, box);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  private async readAgent(name: string): Promise<AgentRecord | null> {
    const file = Bun.file(this.agentFile(name));
    if (!(await file.exists())) return null;
    return (await file.json()) as AgentRecord;
  }

  private async writeAgent(record: AgentRecord): Promise<void> {
    await Bun.write(this.agentFile(record.name), JSON.stringify(record, null, 2));
  }

  async register(name: string): Promise<AgentRecord> {
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) {
      throw new Error(`invalid agent name "${name}" (use letters, digits, . _ -)`);
    }
    const existing = await this.readAgent(name);
    const now = new Date().toISOString();
    const record: AgentRecord = existing ?? {
      name,
      subscriptions: [],
      createdAt: now,
      lastSeen: now,
    };
    record.lastSeen = now;
    await this.writeAgent(record);
    this.spoolDir(name, "new");
    return record;
  }

  async agents(): Promise<AgentRecord[]> {
    const dir = join(this.root, "agents");
    if (!existsSync(dir)) return [];
    const records: AgentRecord[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      records.push((await Bun.file(join(dir, f)).json()) as AgentRecord);
    }
    return records.sort((a, b) => a.name.localeCompare(b.name));
  }

  async touch(name: string): Promise<void> {
    const record = await this.readAgent(name);
    if (!record) return;
    record.lastSeen = new Date().toISOString();
    await this.writeAgent(record);
  }

  async subscribe(agent: string, channel: string): Promise<void> {
    const record = await this.readAgent(agent);
    if (!record) throw new Error(`unknown agent "${agent}" — run \`bch init ${agent}\` first`);
    const name = channel.startsWith("#") ? channel : `#${channel}`;
    if (!record.subscriptions.includes(name)) record.subscriptions.push(name);
    await this.writeAgent(record);
  }

  async unsubscribe(agent: string, channel: string): Promise<void> {
    const record = await this.readAgent(agent);
    if (!record) return;
    const name = channel.startsWith("#") ? channel : `#${channel}`;
    record.subscriptions = record.subscriptions.filter((c) => c !== name);
    await this.writeAgent(record);
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

    for (const rcpt of recipients) {
      const tmp = join(this.spoolDir(rcpt, "tmp"), `${msg.id}.json`);
      await Bun.write(tmp, JSON.stringify(msg));
      renameSync(tmp, join(this.spoolDir(rcpt, "new"), `${msg.id}.json`));
    }
    await this.touch(from);
    return msg;
  }

  async inbox(agent: string): Promise<Message[]> {
    const dir = this.spoolDir(agent, "new");
    const messages: Message[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        messages.push((await Bun.file(join(dir, f)).json()) as Message);
      } catch {
        // partial write from a concurrent sender; it will appear on the next read
      }
    }
    await this.touch(agent);
    return messages.sort((a, b) => a.ts.localeCompare(b.ts));
  }

  async ack(agent: string, id: string, keep = false): Promise<void> {
    const src = join(this.spoolDir(agent, "new"), `${id}.json`);
    if (!existsSync(src)) return;
    if (keep) renameSync(src, join(this.spoolDir(agent, "cur"), `${id}.json`));
    else rmSync(src);
  }

  watch(agent: string, onMessage: (msg: Message) => void): () => void {
    const dir = this.spoolDir(agent, "new");
    const seen = new Set<string>();
    const deliver = async () => {
      for (const msg of await this.inbox(agent)) {
        if (seen.has(msg.id)) continue;
        seen.add(msg.id);
        onMessage(msg);
      }
    };
    const watcher = fsWatch(dir, () => void deliver());
    void deliver();
    return () => watcher.close();
  }
}
