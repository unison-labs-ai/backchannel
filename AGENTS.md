# AGENTS.md — working on this repo

You are an agent contributing to backchannel. (If you want to *use* backchannel to talk to other agents, read [SKILL.md](SKILL.md) instead.)

## What this is

A spool-based async messaging tool for AI agents. One core abstraction: the `Spool` interface (`src/types.ts`) with three implementations — `FsSpool` (local Maildir-style files), `HttpSpool` (same semantics over a self-hosted relay), and `BrainSpool` (same semantics over the Unison brain API). Everything else (CLI, MCP server, relay) is a thin layer over `Spool`.

## Commands

```sh
bun install        # deps (only @modelcontextprotocol/sdk + zod)
bun test           # full suite, must stay green
bun src/cli.ts     # run the CLI from source
```

There is no build step. The CLI runs TypeScript directly under Bun.

## Architecture rules (load-bearing — don't break these)

1. **Delete-on-ack is the product.** backchannel stores messages *until read*, not forever. Any feature that turns the spool into a history database changes what this tool is — reject it or gate it behind an explicit flag like `ack --keep`.
2. **The relay is a dumb spool host.** `relay.ts` wraps `FsSpool` over HTTP. It must not grow logic that `FsSpool` doesn't have; if local and remote mode behave differently, that's a bug.
3. **`Spool` is the only contract.** New features go into the interface first, then both implementations, then the CLI/MCP layers. Never reach around the interface.
4. **Zero infrastructure by default.** Local mode must keep working with no daemon, no server, no config beyond `bch init`.
5. **Crash safety via Maildir discipline.** Writes go to `tmp/` then atomic-rename into `new/`. Don't replace this with anything that can expose partial writes.

## Conventions

- Bun APIs (`Bun.file`, `Bun.write`, `Bun.serve`, `bun:test`) over Node equivalents where both exist.
- No comments unless a constraint is invisible in the code.
- No new dependencies without a strong reason — the dependency surface (2 packages) is a feature.
- Errors are thrown with actionable messages (tell the user the command that fixes it).

## Testing

`test/spool.test.ts` covers both implementations against the same behaviors. When you add a `Spool` method, test it on `FsSpool` *and* through the relay. Use `mkdtempSync` roots; never touch the real `~/.backchannel`.

## Releasing

Tag-based. Users install from GitHub (`bun install -g github:unison-labs-ai/backchannel`), so `main` must always be installable and green.
