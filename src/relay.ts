import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import type { Server } from "bun";
import { FsSpool, defaultRoot } from "./fs-spool.ts";
import type { AgentRecord, Message, SendOpts } from "./types.ts";

export interface RelayOpts {
  port?: number;
  token?: string;
  root?: string;
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

const strip = ({ tokenHash: _drop, ...record }: AgentRecord) => record;

const DEFAULT_ROOM = "default";
const ROOM_ID = /^[A-Za-z0-9_-]{1,64}$/;

interface RoomMeta {
  tokenHash: string;
  createdAt: string;
}

export function startRelay(opts: RelayOpts = {}): Server {
  const root = opts.root ?? defaultRoot();
  const roomsDir = join(root, "rooms");
  mkdirSync(roomsDir, { recursive: true });
  const spools = new Map<string, FsSpool>();

  const roomMetaFile = (roomId: string) => join(roomsDir, roomId, "room.json");

  const roomSpool = (roomId: string): FsSpool => {
    let spool = spools.get(roomId);
    if (!spool) {
      spool = new FsSpool(join(roomsDir, roomId));
      spools.set(roomId, spool);
    }
    return spool;
  };

  const getRoomMeta = async (roomId: string): Promise<RoomMeta | null> => {
    const file = Bun.file(roomMetaFile(roomId));
    if (!(await file.exists())) return null;
    return (await file.json()) as RoomMeta;
  };

  const putRoomMeta = async (roomId: string, meta: RoomMeta): Promise<void> => {
    mkdirSync(join(roomsDir, roomId), { recursive: true });
    await Bun.write(roomMetaFile(roomId), JSON.stringify(meta, null, 2));
  };

  // Back-compat: a relay started with --token exposes a single implicit "default"
  // room whose join secret is that token (no --token → an open default room).
  // Clients that send no room header land here. Rooms created via /v1/rooms are
  // explicit and always token-gated.
  const defaultToken = opts.token ?? process.env.BACKCHANNEL_TOKEN;

  const json = (data: unknown, status = 200) => Response.json(data, { status });

  const bearer = (req: Request): string | undefined =>
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");

  const roomOf = (req: Request): string => {
    const raw = req.headers.get("x-backchannel-room")?.trim();
    return raw && ROOM_ID.test(raw) ? raw : DEFAULT_ROOM;
  };

  const agentForToken = async (spool: FsSpool, token: string | undefined): Promise<AgentRecord | null> => {
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
      const roomId = roomOf(req);
      const spool = roomSpool(roomId);

      try {
        if (req.method === "GET" && path === "/v1/health") {
          return json({ ok: true, service: "backchannel-relay" });
        }

        // Self-service room creation — returns a fresh room id + join secret.
        if (req.method === "POST" && path === "/v1/rooms") {
          const admin = process.env.BACKCHANNEL_ADMIN_TOKEN;
          if (admin && token !== admin) {
            return json({ error: "room creation is restricted on this relay" }, 401);
          }
          const newRoomId = randomBytes(6).toString("base64url");
          const roomToken = randomBytes(24).toString("base64url");
          await putRoomMeta(newRoomId, { tokenHash: sha256(roomToken), createdAt: new Date().toISOString() });
          roomSpool(newRoomId); // materialise the spool dir
          return json({ roomId: newRoomId, roomToken });
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
          // New agent: determine the room's join secret. An explicit room (room.json)
          // is always token-gated; the implicit default room uses --token, or is open
          // if the relay was started without one.
          const meta = await getRoomMeta(roomId);
          let requiredHash: string | null;
          if (meta) {
            requiredHash = meta.tokenHash || null;
          } else if (roomId === DEFAULT_ROOM) {
            requiredHash = defaultToken ? sha256(defaultToken) : null;
          } else {
            return json({ error: `unknown room "${roomId}" — create one with \`bch room new\`` }, 404);
          }
          if (requiredHash !== null && (token === undefined || sha256(token) !== requiredHash)) {
            return json({ error: "unauthorized — registration requires the room token" }, 401);
          }
          const agentToken = randomBytes(32).toString("hex");
          const record = await spool.register(name);
          record.tokenHash = sha256(agentToken);
          await spool.putAgent(record);
          return json({ ...strip(record), token: agentToken });
        }

        const me = await agentForToken(spool, token);
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
