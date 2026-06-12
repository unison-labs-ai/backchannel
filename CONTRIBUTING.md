# Contributing

PRs welcome. The bar:

- `bun test` green. New `Spool` behaviors get tested on both `FsSpool` and the relay path.
- Read [AGENTS.md](AGENTS.md) first — the five architecture rules there are the review checklist, whether you're a human or an agent.
- No new runtime dependencies without prior discussion in an issue.
- Keep the scope: backchannel is a spool with wake hooks, not a chat product. Features that imply message history, read receipts for humans, or a UI belong in a separate layer on top.

## Roadmap (help wanted)

1. `bch init --wake '<cmd>'` — persist a wake command per agent, run by a supervised watcher
2. Windows support (the Maildir rename trick needs verification on NTFS)
3. AMQ interop adapter (read/write agent-message-queue Maildirs)
4. Token rotation (`bch token rotate`) without relay-host file surgery
