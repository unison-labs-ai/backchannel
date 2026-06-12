import type { Server } from "bun";
import { FsSpool } from "./fs-spool.ts";
import type { Message, SendOpts } from "./types.ts";

export interface RelayOpts {
  port?: number;
  token?: string;
  root?: string;
}

export function startRelay(opts: RelayOpts = {}): Server {
  const spool = new FsSpool(opts.root);
  const token = opts.token ?? process.env.BACKCHANNEL_TOKEN;

  const json = (data: unknown, status = 200) =>
    Response.json(data, { status });

  return Bun.serve({
    port: opts.port ?? 7117,
    idleTimeout: 0,
    async fetch(req) {
      if (token) {
        const auth = req.headers.get("authorization");
        if (auth !== `Bearer ${token}`) return json({ error: "unauthorized" }, 401);
      }

      const url = new URL(req.url);
      const path = url.pathname;

      try {
        if (req.method === "GET" && path === "/v1/health") {
          return json({ ok: true, service: "backchannel-relay" });
        }
        if (req.method === "POST" && path === "/v1/register") {
          const { name } = (await req.json()) as { name: string };
          return json(await spool.register(name));
        }
        if (req.method === "GET" && path === "/v1/agents") {
          return json(await spool.agents());
        }
        if (req.method === "GET" && path === "/v1/channels") {
          return json(await spool.channels());
        }
        if (req.method === "POST" && path === "/v1/subscribe") {
          const { agent, channel } = (await req.json()) as { agent: string; channel: string };
          await spool.subscribe(agent, channel);
          return json({ ok: true });
        }
        if (req.method === "POST" && path === "/v1/unsubscribe") {
          const { agent, channel } = (await req.json()) as { agent: string; channel: string };
          await spool.unsubscribe(agent, channel);
          return json({ ok: true });
        }
        if (req.method === "POST" && path === "/v1/send") {
          const { from, to, body, ...opts } = (await req.json()) as {
            from: string;
            to: string;
            body: string;
          } & SendOpts;
          return json(await spool.send(from, to, body, opts));
        }
        if (req.method === "GET" && path.startsWith("/v1/inbox/")) {
          const agent = decodeURIComponent(path.slice("/v1/inbox/".length));
          return json(await spool.inbox(agent));
        }
        if (req.method === "POST" && path === "/v1/ack") {
          const { agent, id, keep } = (await req.json()) as {
            agent: string;
            id: string;
            keep?: boolean;
          };
          await spool.ack(agent, id, keep);
          return json({ ok: true });
        }
        if (req.method === "GET" && path.startsWith("/v1/events/")) {
          const agent = decodeURIComponent(path.slice("/v1/events/".length));
          let stop: (() => void) | undefined;
          let heartbeat: ReturnType<typeof setInterval> | undefined;
          const stream = new ReadableStream({
            start(controller) {
              const push = (line: string) => {
                try {
                  controller.enqueue(new TextEncoder().encode(line));
                } catch {
                  stop?.();
                  if (heartbeat) clearInterval(heartbeat);
                }
              };
              stop = spool.watch(agent, (msg: Message) => {
                push(`data: ${JSON.stringify(msg)}\n\n`);
              });
              heartbeat = setInterval(() => push(": keepalive\n\n"), 25_000);
            },
            cancel() {
              stop?.();
              if (heartbeat) clearInterval(heartbeat);
            },
          });
          return new Response(stream, {
            headers: {
              "content-type": "text/event-stream",
              "cache-control": "no-cache",
              connection: "keep-alive",
            },
          });
        }
        return json({ error: "not found" }, 404);
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    },
  });
}
