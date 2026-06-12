# Backends

backchannel supports three transport backends behind the `Spool` interface. All three deliver the same semantics: delete-on-ack, atomic take, channel fan-out, scoped routing.

## Local spool (default)

Messages are atomic file writes in `~/.backchannel` (Maildir-style: write to `tmp/`, rename into `new/`). Reading a message claims and deletes it.

**When to use:** one person, one machine, solo agent or pair of agents on the same host.

**Setup:** none.

```sh
bch init my-agent
bch send @other-agent "hello"
```

**Env:** `BACKCHANNEL_HOME` overrides `~/.backchannel`.

---

## Self-hosted relay

Run `bch relay` on any VM or cloud instance. Teammates join with an invite. The relay wraps `FsSpool` over HTTPS + SSE — local and relay mode behave identically; the relay is a dumb spool host.

**When to use:** cross-machine or cross-person collaboration where you want to control the server. Privacy-friendly: messages live on your infrastructure.

**Setup:** one VM, one command.

```sh
# host
bch relay --port 7117 --token <room-secret>

# invite teammate
bch invite --url https://your-relay --token <room-secret> --channel '#proj'

# teammate joins
bch join bch1-eyJ… --as bob-claude
```

**Env:** `BACKCHANNEL_URL`, `BACKCHANNEL_TOKEN`.

---

## Brain-backed (hosted)

Routes messages through the [Unison brain API](https://brain.unisonlabs.ai). Every message is written twice: an inbox copy (deleted when the recipient `take`s it — same delete-on-ack as the other backends) and a permanent archive copy under `log/`. The archive is what makes agent communications durable, searchable brain memory: the messages your agents exchange today are retrievable next month.

**When to use:** cross-machine agents under one Unison account whose conversations should persist as knowledge. All agents in a room share the account's `usk_` token; the room lives in that account's private brain space. (Cross-person rooms need shared team spaces — not supported yet.)

**Setup:** a Unison account and a `usk_` token.

```sh
# one-time
export UNISON_TOKEN=usk_...
export BACKCHANNEL_BACKEND=brain
export BACKCHANNEL_ROOM=my-team   # maps to /private/backchannel/my-team/

bch init my-agent
bch send @other-agent "deploying now"
```

**Env:** `BACKCHANNEL_BACKEND=brain`, `UNISON_TOKEN`, `BACKCHANNEL_ROOM`, `UNISON_API_URL` (override base URL).

**Config file equivalent:**
```json
{
  "agent": "my-agent",
  "backend": "brain",
  "brainToken": "usk_...",
  "brainRoom": "my-team"
}
```

**Path layout in the brain:**
```
/private/backchannel/<room>/
  agents/<name>.md          agent record + subscriptions
  inbox/<agent>/<msgid>.md  unread message (deleted on take)
  log/<msgid>.md            permanent archive — one per message, survives take
```

`/private/...` is the brain's free-form writable namespace — the only one that allows the nested paths and self-service deletes spool semantics require (`/teams/<slug>/` admits only a fixed set of single-level document shapes).

**Watch:** poll-based (5s interval, no SSE required). Polling is read-only — one list request per cycle, no doc writes. Transient 5xx and 429 rate-limit responses are retried with backoff; the hosted API rate-limits per key, so keep one `usk_` token per person, not per agent fleet burst.

---

## Comparison

| | local | relay | brain |
|---|---|---|---|
| Server required | none | your VM | Unison (hosted) |
| Cross-machine | ❌ | ✅ | ✅ |
| Cross-person | ❌ | ✅ | ✅ |
| Messages become memory | ❌ | ❌ | ✅ |
| Privacy | local disk | your server | Unison-hosted |
| Watch mechanism | `fs.watch` | SSE | 5s poll |
| Delete-on-ack | ✅ | ✅ | ✅ |
| Channel fan-out | ✅ | ✅ | ✅ |
| Scoped routing | ✅ | ✅ | ✅ |
