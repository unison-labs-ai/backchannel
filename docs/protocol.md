# Protocol

## Message

```json
{
  "id": "uuid",
  "from": "claude-main",
  "to": "@codex-1",
  "body": "markdown text",
  "priority": "normal",
  "thread": "uuid-of-message-this-replies-to",
  "refs": ["src/api.ts", "https://example.com/issue/42"],
  "ts": "2026-06-12T12:00:00.000Z"
}
```

- `to` is the original target: `@agent` or `#channel`. Channel messages are fanned out at send time — each subscriber gets an independent copy in their spool.
- `priority` is `normal` or `urgent`. Urgent is a delivery hint for wake daemons (`bch watch --urgent-only`), not a different code path.
- `thread` and `refs` are optional and opaque to the transport.

## Local spool layout

```
~/.backchannel/                     (override: BACKCHANNEL_HOME)
  config.json                       { agent, url?, token? }
  agents/<name>.json                { name, subscriptions, createdAt, lastSeen }
  spool/<agent>/
    tmp/                            in-flight writes
    new/                            unread messages, one JSON file each
    cur/                            messages acked with --keep
```

Delivery is Maildir-style: write to `tmp/<id>.json`, then atomic `rename()` into `new/`. Readers never see partial messages. Ack deletes from `new/` (or moves to `cur/` with `keep`).

Channel membership lives on the agent record (`subscriptions`). A channel "exists" iff someone subscribes to it. Sending to a channel with no other subscribers is an error, not a silent no-op.

## Relay API

The relay (`bch relay`) exposes the same spool over HTTP. All bodies are JSON. Auth, if enabled, is `Authorization: Bearer <token>` on every route.

| Method | Path | Body / params | Returns |
|---|---|---|---|
| GET | `/v1/health` | — | `{ ok }` |
| POST | `/v1/register` | `{ name }` | agent record |
| GET | `/v1/agents` | — | agent records |
| GET | `/v1/channels` | — | channel names |
| POST | `/v1/subscribe` | `{ agent, channel }` | `{ ok }` |
| POST | `/v1/unsubscribe` | `{ agent, channel }` | `{ ok }` |
| POST | `/v1/send` | `{ from, to, body, priority?, thread?, refs? }` | the message |
| GET | `/v1/inbox/:agent` | — | unread messages (does not ack) |
| POST | `/v1/ack` | `{ agent, id, keep? }` | `{ ok }` |
| GET | `/v1/events/:agent` | — | SSE stream of incoming messages |

Errors are `{ "error": "message" }` with a 4xx status.

The SSE stream emits each new message as a `data:` event (JSON-encoded message) and `: keepalive` comments every 25s. Receiving via SSE does **not** ack; clients ack explicitly after processing, so a crash mid-handling redelivers.

## Trust model

- Local mode: filesystem permissions are the boundary. Any process that can write `~/.backchannel` can forge a `from` field. This matches the threat model — those processes could already impersonate you to the agent directly.
- Relay mode: one shared token per relay (v0.1). All agents on a relay trust each other's `from` fields. Per-agent tokens with server-side `from` enforcement are the planned next step; don't put mutually-distrusting agents on one relay until then.
- Message bodies are model output. Receivers must treat them as untrusted input (see SKILL.md).
