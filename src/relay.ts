import { createHash, randomBytes } from "node:crypto";
import type { Server } from "bun";
import { FsSpool } from "./fs-spool.ts";
import type { AgentRecord, Message, SendOpts } from "./types.ts";

export interface RelayOpts {
  port?: number;
  token?: string;
  root?: string;
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

const strip = ({ tokenHash: _drop, ...record }: AgentRecord) => record;

export function startRelay(opts: RelayOpts = {}): Server {
  const spool = new FsSpool(opts.root);
  const roomToken = opts.token ?? process.env.BACKCHANNEL_TOKEN;

  const json = (data: unknown, status = 200) => Response.json(data, { status });

  const bearer = (req: Request): string | undefined =>
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");

  const agentForToken = async (token: string | undefined): Promise<AgentRecord | null> => {
    if (!token) return null;
    const hash = sha256(token);
    return (await spool.agents()).find((a) => a.tokenHash === hash) ?? null;
  };

  return Bun.serve({
    port: opts.port ?? 7117,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      const token = bearer(req);

      try {
        if (req.method === "GET" && path === "/v1/health") {
          return json({ ok: true, service: "backchannel-relay" });
        }

        if (req.method === "POST" && path === "/v1/register") {
          const { name } = (await req.json()) as { name: string };
          const existing = await spool.getAgent(name);
          if (existing?.tokenHash) {
            if (!token || sha256(token) !== existing.tokenHash) {
              return json({ error: `agent name "${name}" is registered — present its token to re-register` }, 409);
            }
            return json(strip(await spool.register(name)));
          }
          if (roomToken && token !== roomToken) {
            return json({ error: "unauthorized — registration requires the room token" }, 401);
          }
          const agentToken = randomBytes(32).toString("hex");
          const record = await spool.register(name);
          record.tokenHash = sha256(agentToken);
          await spool.putAgent(record);
          return json({ ...strip(record), token: agentToken });
        }

        const me = await agentForToken(token);
        if (!me) return json({ error: "unauthorized — agent token required (get one via /v1/register)" }, 401);

        if (req.method === "GET" && path === "/v1/agents") {
          return json((await spool.agents()).map(strip));
        }
        if (req.method === "GET" && path === "/v1/channels") {
          return json(await spool.channels());
        }
        if (req.method === "POST" && path === "/v1/subscribe") {
          const { channel } = (await req.json()) as { channel: string };
          await spool.subscribe(me.name, channel);
          return json({ ok: true });
        }
        if (req.method === "POST" && path === "/v1/unsubscribe") {
          const { channel } = (await req.json()) as { channel: string };
          await spool.unsubscribe(me.name, channel);
          return json({ ok: true });
        }
        if (req.method === "POST" && path === "/v1/send") {
          const { to, body, ...sendOpts } = (await req.json()) as {
            to: string;
            body: string;
          } & SendOpts;
          return json(await spool.send(me.name, to, body, sendOpts));
        }
        if (req.method === "GET" && path.startsWith("/v1/inbox/")) {
          const agent = decodeURIComponent(path.slice("/v1/inbox/".length));
          if (agent !== me.name) return json({ error: `token is for "${me.name}", not "${agent}"` }, 403);
          return json(await spool.inbox(me.name));
        }
        if (req.method === "POST" && path === "/v1/take") {
          const { id, keep } = (await req.json()) as { id: string; keep?: boolean };
          return json({ message: await spool.take(me.name, id, keep) });
        }
        if (req.method === "GET" && path.startsWith("/v1/events/")) {
          const agent = decodeURIComponent(path.slice("/v1/events/".length));
          if (agent !== me.name) return json({ error: `token is for "${me.name}", not "${agent}"` }, 403);
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
              stop = spool.watch(me.name, (msg: Message) => {
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
