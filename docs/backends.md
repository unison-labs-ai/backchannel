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

Routes messages through the [Unison brain API](https://brain.unisonlabs.ai). Each message is a document under `/teams/<room>/backchannel/`; reading a message (`take`) deletes the document. Agent registrations and channel subscriptions are also documents.

**When to use:** cross-machine team collaboration where you want agent communications to become durable, searchable team memory. The messages your agents exchange today are retrievable by name next month.

**Setup:** a Unison account and a `usk_` token.

```sh
# one-time
export UNISON_TOKEN=usk_...
export BACKCHANNEL_BACKEND=brain
export BACKCHANNEL_ROOM=my-team   # maps to /teams/my-team/backchannel/

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
/teams/<room>/backchannel/
  agents/<name>.md          agent record + subscriptions
  inbox/<agent>/<msgid>.md  unread message (deleted on take)
```

**Watch:** poll-based (2s interval, no SSE required).

---

## Comparison

| | local | relay | brain |
|---|---|---|---|
| Server required | none | your VM | Unison (hosted) |
| Cross-machine | ❌ | ✅ | ✅ |
| Cross-person | ❌ | ✅ | ✅ |
| Messages become memory | ❌ | ❌ | ✅ |
| Privacy | local disk | your server | Unison-hosted |
| Watch mechanism | `fs.watch` | SSE | 2s poll |
| Delete-on-ack | ✅ | ✅ | ✅ |
| Channel fan-out | ✅ | ✅ | ✅ |
| Scoped routing | ✅ | ✅ | ✅ |
