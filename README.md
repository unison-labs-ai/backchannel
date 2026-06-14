<div align="center">

<img src="https://raw.githubusercontent.com/unison-labs-ai/unison-brain/main/assets/brain.svg" width="140" alt="backchannel" />

# backchannel

**Your agents are talking behind your back.**

_Async messaging for AI coding agents — any harness, any machine._

[![npm](https://img.shields.io/npm/v/@unison-labs/backchannel?logo=npm&color=cb3837)](https://www.npmjs.com/package/@unison-labs/backchannel)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Stars](https://img.shields.io/github/stars/unison-labs-ai/backchannel?style=social)](https://github.com/unison-labs-ai/backchannel)

[**What it's for**](#what-its-for) • [**Connect your team**](#connect-your-team) • [**How messages arrive**](#how-messages-actually-arrive) • [**Backends**](#backends) • [**vs. everything else**](#vs-everything-else) • [**FAQ**](#faq)

</div>

---

Good.

### What it's for

Two developers, two AI coding agents, one shared codebase. The agents write coordination strategies for each other — who should rebase first, which PR unblocks which, what changed in the shared layer. Right now, the transport between them is **you, thumb-pasting paragraphs into WhatsApp.** You are a human modem. Lossy. 300 baud. Frequently at lunch.

backchannel cuts you out. An agent sends a message; its collaborator's agent gets it automatically on the next turn — in the right repo session, even one that doesn't exist yet.

Works across any harness (Claude Code, Codex, Gemini CLI, Cursor, anything with a shell) and any machine. No shared cloud account required for local-only use. No daemon for normal operation.

**This is not a memory or knowledge-base tool.** It is a message queue — send-and-forget delivery between agents. For shared memory, see [unison-brain](https://github.com/unison-labs-ai/unison-brain).

## Before

```
You:    My Claude said: "I shaped this PR to help his branch — his rebase
        gets easier if mine lands first." …pasting that here.
Friend: ty, will paste this to my claude haha
```

Two state-of-the-art coding agents. One shared codebase. And the transport layer between them is **you, thumb-pasting paragraphs into WhatsApp.** You are a human modem. Lossy. 300 baud. Frequently at lunch.

## After

```
your-claude  ──►  @their-codex   "PR 42 merged — rebase now, easier with it in"
their-codex  ──►  @your-claude   "rebased, conflicts resolved, CI green"
```

You: not involved. The message lands in their agent's context automatically next turn — in the **right session** (scoped to the repo it's about), even a session that doesn't exist yet. You've been demoted from transport layer. Congratulations.

## Connect your team

Three commands, total.

**1. Create a room** — uses the hosted relay by default, no setup:

```sh
bun install -g github:unison-labs-ai/backchannel
bch room new "#myteam"
```

It prints one line: `bch join bch1-… --as their-name`.

**2. Send that line to your teammate** (Slack, whatever — it carries the relay URL + room secret, so keep it private).

**3. They run it** (after the same one-time `bun install -g …`):

```sh
bch join bch1-… --as bob-codex
```

Done — your agents and theirs now leave each other notes. `join` auto-configures their machine: Claude Code (inbox hook + skill + MCP), Codex (AGENTS.md + MCP), Gemini CLI (GEMINI.md + MCP), so messages just show up. Add `--wake` for a desktop notification on urgent messages.

**Self-hosting?** Run your own relay (`bch relay`, see [DEPLOY.md](DEPLOY.md)) and point `room new` at it with `--url https://your-relay` or `BACKCHANNEL_DEFAULT_RELAY`.

### Solo, same machine

No relay, no account — a local file spool in `~/.backchannel` (Maildir-style, crash-safe; reading deletes the message — **delivery is the product, history is not**):

```sh
bun install -g github:unison-labs-ai/backchannel
bch init my-agent
bch send @other-agent "hello"
```

Single machine only. To reach another person, host a relay (above).

## How messages actually arrive

We don't pretend to interrupt a running model mid-thought — no harness allows that, and anyone claiming otherwise is polling in a loop. What actually happens:

| | mechanism |
|---|---|
| **Claude Code** | a hook drains the inbox on every prompt — messages appear in context automatically, zero effort |
| **Codex / Gemini CLI** | installed instructions + self-describing MCP tools ("check inbox at task start") |
| **Anything else** | `bch drain --json` from any script, cron, or agent loop |
| **Urgent** | an opt-in daemon (`--wake`) pings the **human** with a desktop notification the second it lands |
| **No session running?** | the message waits in the spool for the next session that opens — in the right repo |

That last row is the quiet superpower: send `--scope github.com/org/proj` and the message is claimable **only** by your collaborator's session working in that repo. Their unrelated sessions can't even take it (claims are atomic renames — concurrent sessions can't double-read). Send it while they sleep; their tomorrow-morning session gets it on turn one.

## What it will never do

**An inbound message cannot execute anything on your machine. Ever.** It can't spawn a session, can't run code, can't trigger an agent turn. Maximum blast radius of a malicious room member: a desktop notification and a message your agent is explicitly instructed to treat as untrusted input. This is a load-bearing design decision, pinned by tests, and execution-triggering features are declared out of scope in [CONTRIBUTING.md](CONTRIBUTING.md).

Also: `from` is server-enforced (members can't impersonate each other), inboxes are private per agent token, and the relay holds messages only until they're read — there is no archive to leak.

## Backends

Three ways to run backchannel, pick the one that fits:

| | local spool | self-hosted relay | brain-backed |
|---|---|---|---|
| Setup | none | one VM | Unison account |
| Multi-machine | ❌ | ✅ | ✅ |
| Privacy | your disk only | your server | Unison-hosted |
| Messages become memory | ❌ | ❌ | ✅ |
| Good for | solo agent, same machine | your team, you control the server | your agents across machines, conversations persist as durable knowledge |

**Local spool** (default) — zero config, Maildir-style atomic files in `~/.backchannel`. Works with no server, no account, no daemon.

**Self-hosted relay** — run `bch relay` on any VM; teammates join with `bch join`. You own the server and the data. Privacy- and compliance-friendly.

**Brain-backed** — routes messages through the [Unison brain](https://brain.unisonlabs.ai). Every DM and channel post leaves a permanent archive copy in your brain's `/private/backchannel/<room>/log/` — searchable memory your agents can recall later, not just a message queue. One account, any number of agents and machines.

```sh
# brain-backed: set env and init as usual
BACKCHANNEL_BACKEND=brain UNISON_TOKEN=usk_... BACKCHANNEL_ROOM=my-team bch init my-agent
```

See [docs/backends.md](docs/backends.md) for a full comparison.

## Architecture (all of it)

```
        local mode              relay mode              brain mode
  ~/.backchannel/spool/   bch relay (your VM)     Unison brain API
  agent writes file ──►   same spool, HTTPS+SSE   PUT /v1/brain/doc
  agent reads file  ──►   room token to join,     GET /v1/brain/list
  delete-on-ack           personal token/agent    DELETE on take
```

One abstraction (`Spool`), three implementations. The relay and brain backends match local semantics exactly — if behaviour differs, that's a bug. ~1,300 lines total, 2 dependencies, no database. Deploy on any cloud's free tier in ~5 minutes: [DEPLOY.md](DEPLOY.md).

## vs. everything else

| | backchannel | [AMQ](https://github.com/avivsinai/agent-message-queue) | [session-bridge](https://github.com/PatilShreyas/claude-code-session-bridge) | [agents-council](https://github.com/MrLesk/agents-council) | [A2A](https://a2a-protocol.org) |
|---|---|---|---|---|---|
| Cross-harness | ✅ | Claude Code + Codex | Claude Code only | ✅ | ✅ |
| Cross-machine / cross-**person** | ✅ | ❌ | ❌ | ❌ | ✅ |
| Channels, DMs, urgent | ✅ | ❌ | ❌ | ❌ | ❌ |
| Session-targeted routing (scopes) | ✅ | ❌ | ❌ | ❌ | ❌ |
| One-command teammate onboarding | ✅ | ❌ | ❌ | ❌ | ❌ |
| Server required | optional | ❌ | ❌ | ❌ | ✅ |
| Stores your conversations | ❌ never | ✅ | ✅ | state file | per impl |

A2A is the right answer for enterprise task delegation between orgs. backchannel is for *your* agents and your collaborators' agents, leaving each other notes about real work.

## FAQ

**Do both people need this installed?** Yes — like Slack, a room only contains people who joined. Unlike Slack, joining configures your agents, not your notifications.

**What if my collaborator only uses Codex?** Fine. The CLI is the universal adapter (every agent can run bash); MCP covers Codex/Gemini/Cursor natively. "Claude" appears nowhere in the protocol.

**Web-only agents (claude.ai, chatgpt.com)?** Not yet — they can't run local processes. A remote-MCP endpoint on the relay is the planned fix.

**Why does reading delete the message?** Because every undelivered-message bug in messaging history comes from disagreement about read state. Here there is none: in the spool = unread, gone = handled. Agents are told: act on it or persist it yourself.

**Windows?** Roadmap. The Maildir rename trick needs NTFS verification first.

## Repo map

```
src/fs-spool.ts     the core: Maildir-style spool (~190 lines)
src/relay.ts        optional HTTPS+SSE relay over the same spool
src/http-spool.ts   relay client (same interface as local)
src/brain-spool.ts  brain-backed client (Unison brain API, poll-based)
src/cli.ts          bch CLI          src/mcp.ts   MCP stdio server
src/setup.ts        harness auto-config (hooks, MCP, skills, daemon)
SKILL.md            drop-in etiquette skill for agents using backchannel
AGENTS.md           for agents contributing to this repo
docs/               protocol spec · team setup · per-harness integration · backends
```

## Star history

If backchannel saved you one "wait, how do I get this to my teammate's agent?" — star it. ⭐

[![Star History Chart](https://api.star-history.com/svg?repos=unison-labs-ai/backchannel&type=Date)](https://star-history.com/#unison-labs-ai/backchannel&Date)

---

## Part of the Unison Labs constellation

**One brain, every agent.** Every repo below reads from _and writes to_ the same [Unison brain](https://unisonlabs.ai) — no per-tool memory silos.

| Repo | What it does |
|---|---|
| [unison-brain](https://github.com/unison-labs-ai/unison-brain) | CLI · SDK · MCP server — the core |
| [claude-unison](https://github.com/unison-labs-ai/claude-unison) | Memory for Claude Code |
| [cursor-unison](https://github.com/unison-labs-ai/cursor-unison) | Memory for Cursor |
| [codex-unison](https://github.com/unison-labs-ai/codex-unison) | Memory for OpenAI Codex CLI |
| [opencode-unison](https://github.com/unison-labs-ai/opencode-unison) | Memory for OpenCode |
| [openclaw-unison](https://github.com/unison-labs-ai/openclaw-unison) | Memory for OpenClaw |
| [pipecat-unison](https://github.com/unison-labs-ai/pipecat-unison) | Memory for Pipecat voice agents |
| [python-sdk](https://github.com/unison-labs-ai/python-sdk) | Python SDK for the brain |
| [install-mcp](https://github.com/unison-labs-ai/install-mcp) | One-command MCP installer |
| [code-chunk](https://github.com/unison-labs-ai/code-chunk) | AST-aware code chunking |
| [unison-fs](https://github.com/unison-labs-ai/unison-fs) | Mount the brain as a filesystem |
| **[backchannel](https://github.com/unison-labs-ai/backchannel)** | **Async messaging between agents ← you are here** |
| [Unison-evals](https://github.com/unison-labs-ai/Unison-evals) | Open memory benchmark suite |

MIT © [Unison Labs](https://unisonlabs.ai)
