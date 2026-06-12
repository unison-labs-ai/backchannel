import type { AgentRecord, Message, SendOpts, Spool } from "./types.ts";

export class HttpSpool implements Spool {
  constructor(
    readonly url: string,
    readonly token?: string,
  ) {}

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
    };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.url}${path}`, {
      method,
      headers: this.headers(),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const data = (await res.json()) as T & { error?: string };
    if (!res.ok) throw new Error(data.error ?? `relay error ${res.status}`);
    return data;
  }

  register(name: string): Promise<AgentRecord> {
    return this.request("POST", "/v1/register", { name });
  }

  agents(): Promise<AgentRecord[]> {
    return this.request("GET", "/v1/agents");
  }

  channels(): Promise<string[]> {
    return this.request("GET", "/v1/channels");
  }

  async subscribe(agent: string, channel: string): Promise<void> {
    await this.request("POST", "/v1/subscribe", { agent, channel });
  }

  async unsubscribe(agent: string, channel: string): Promise<void> {
    await this.request("POST", "/v1/unsubscribe", { agent, channel });
  }

  send(from: string, to: string, body: string, opts: SendOpts = {}): Promise<Message> {
    return this.request("POST", "/v1/send", { from, to, body, ...opts });
  }

  inbox(agent: string): Promise<Message[]> {
    return this.request("GET", `/v1/inbox/${encodeURIComponent(agent)}`);
  }

  async ack(agent: string, id: string, keep = false): Promise<void> {
    await this.request("POST", "/v1/ack", { agent, id, keep });
  }

  watch(agent: string, onMessage: (msg: Message) => void): () => void {
    const controller = new AbortController();
    const connect = async () => {
      while (!controller.signal.aborted) {
        try {
          const res = await fetch(`${this.url}/v1/events/${encodeURIComponent(agent)}`, {
            headers: this.headers(),
            signal: controller.signal,
          });
          if (!res.body) throw new Error("no event stream");
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const events = buffer.split("\n\n");
            buffer = events.pop() ?? "";
            for (const event of events) {
              const data = event
                .split("\n")
                .filter((l) => l.startsWith("data: "))
                .map((l) => l.slice(6))
                .join("\n");
              if (data) onMessage(JSON.parse(data) as Message);
            }
          }
        } catch {
          if (controller.signal.aborted) return;
        }
        await new Promise((r) => setTimeout(r, 2_000));
      }
    };
    void connect();
    return () => controller.abort();
  }
}
