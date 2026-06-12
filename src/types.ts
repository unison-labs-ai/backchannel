export type Priority = "normal" | "urgent";

export interface Message {
  id: string;
  from: string;
  to: string;
  body: string;
  priority: Priority;
  scope?: string;
  thread?: string;
  refs?: string[];
  ts: string;
}

export interface AgentRecord {
  name: string;
  subscriptions: string[];
  createdAt: string;
  lastSeen: string;
  tokenHash?: string;
}

export type Registration = AgentRecord & { token?: string };

export interface Spool {
  register(name: string): Promise<Registration>;
  agents(): Promise<AgentRecord[]>;
  subscribe(agent: string, channel: string): Promise<void>;
  unsubscribe(agent: string, channel: string): Promise<void>;
  channels(): Promise<string[]>;
  send(from: string, to: string, body: string, opts?: SendOpts): Promise<Message>;
  inbox(agent: string): Promise<Message[]>;
  take(agent: string, id: string, keep?: boolean): Promise<Message | null>;
  watch(agent: string, onMessage: (msg: Message) => void): () => void;
}

export interface SendOpts {
  priority?: Priority;
  scope?: string;
  thread?: string;
  refs?: string[];
}

function normalizeScope(value: string): string {
  return value
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^git@/, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "")
    .replace(/:/g, "/");
}

export function matchesScope(msg: Message, match?: string): boolean {
  if (!msg.scope) return true;
  if (!match) return false;
  return normalizeScope(match).includes(normalizeScope(msg.scope));
}

export function isChannel(target: string): boolean {
  return target.startsWith("#");
}

export function normalizeTarget(target: string): string {
  return target.startsWith("@") ? target.slice(1) : target;
}
