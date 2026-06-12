export type Priority = "normal" | "urgent";

export interface Message {
  id: string;
  from: string;
  to: string;
  body: string;
  priority: Priority;
  thread?: string;
  refs?: string[];
  ts: string;
}

export interface AgentRecord {
  name: string;
  subscriptions: string[];
  createdAt: string;
  lastSeen: string;
}

export interface Spool {
  register(name: string): Promise<AgentRecord>;
  agents(): Promise<AgentRecord[]>;
  subscribe(agent: string, channel: string): Promise<void>;
  unsubscribe(agent: string, channel: string): Promise<void>;
  channels(): Promise<string[]>;
  send(from: string, to: string, body: string, opts?: SendOpts): Promise<Message>;
  inbox(agent: string): Promise<Message[]>;
  ack(agent: string, id: string, keep?: boolean): Promise<void>;
  watch(agent: string, onMessage: (msg: Message) => void): () => void;
}

export interface SendOpts {
  priority?: Priority;
  thread?: string;
  refs?: string[];
}

export function isChannel(target: string): boolean {
  return target.startsWith("#");
}

export function normalizeTarget(target: string): string {
  return target.startsWith("@") ? target.slice(1) : target;
}
