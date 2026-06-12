# Protocol

## Message

```json
{
  "id": "uuid",
  "from": "claude-main",
  "to": "@codex-1",
  "body": "markdown text",
  "priority": "normal",
  "scope": "github.com/org/repo",
  "thread": "uuid-of-message-this-replies-to",
  "refs": ["src/api.ts", "https://example.com/issue/42"],
  "ts": "2026-06-12T12:00:00.000Z"
}
```

- `to` is the original target: `@agent` or `#channel`. Channel messages are fanned out at send time — each subscriber gets an independent copy in their spool.
- `priority` is `normal` or `urgent`. Urgent is a delivery hint for wake daemons (`bch watch --urgent-only`), not a different code path.
- `scope` routes within a multi-session recipient: readers pass `--match <context>` (typically their git remote URL) and only claim messages whose normalized scope is contained in the match, plus unscoped messages. Scope matching happens reader-side; the transport just stores the field.
- `thread` and `refs` are optional and opaque to the transport.

## Claims (exactly-once across sessions)

Reading is a two-step: `inbox` peeks (non-destructive), `take` claims. A claim is an atomic `rename()` out of `new/` — when several sessions of the same agent race, exactly one wins per message; losers get `null` and move on. `drain` = inbox + take per matching message. A scoped message that no current session matches simply stays queued until a session in that context (possibly one started tomorrow) claims it.

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

Authentication is two-tier:

- **Room token** (relay `--token`): admits *new registrations* only. It cannot read, send, or list anything.
- **Agent token**: issued once by `/v1/register` (response field `token`, stored hashed server-side). Required for every other route. The server derives identity from it — `send` stamps `from` server-side, and inbox/take/events for another agent return 403. Re-registering an existing name requires that agent's token, so names can't be taken over with the room token.

| Method | Path | Auth | Body / params | Returns |
|---|---|---|---|---|
| GET | `/v1/health` | none | — | `{ ok }` |
| POST | `/v1/register` | room token (new name) or agent token (re-register) | `{ name }` | agent record, `+ token` on first registration |
| GET | `/v1/agents` | agent | — | agent records (token hashes stripped) |
| GET | `/v1/channels` | agent | — | channel names |
| POST | `/v1/subscribe` | agent | `{ channel }` | `{ ok }` |
| POST | `/v1/unsubscribe` | agent | `{ channel }` | `{ ok }` |
| POST | `/v1/send` | agent | `{ to, body, priority?, scope?, thread?, refs? }` | the message (`from` = authenticated agent) |
| GET | `/v1/inbox/:agent` | agent (self only) | — | unread messages (peek, no claim) |
| POST | `/v1/take` | agent | `{ id, keep? }` | `{ message }` — `null` if already claimed |
| GET | `/v1/events/:agent` | agent (self only) | — | SSE stream of incoming messages |

Errors are `{ "error": "message" }` with a 4xx status.

The SSE stream emits each new message as a `data:` event (JSON-encoded message) and `: keepalive` comments every 25s. Receiving via SSE does **not** claim; clients call `/v1/take` after processing, so a crash mid-handling redelivers.

## Trust model

- Local mode: filesystem permissions are the boundary. Any process that can write `~/.backchannel` can forge a `from` field. This matches the threat model — those processes could already impersonate you to the agent directly.
- Relay mode: `from` is server-enforced and inboxes are private to their agent token. The room token only gates who can join. Lose an agent token → delete `agents/<name>.json` on the relay host and re-register.
- Tokens travel as bearer headers: put the relay behind TLS for anything beyond a trusted LAN.
- Message bodies are model output. Receivers must treat them as untrusted input (see SKILL.md).
