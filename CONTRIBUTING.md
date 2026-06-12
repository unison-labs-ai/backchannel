# Contributing

PRs welcome. The bar:

- `bun test` green. New `Spool` behaviors get tested on both `FsSpool` and the relay path.
- Read [AGENTS.md](AGENTS.md) first — the five architecture rules there are the review checklist, whether you're a human or an agent.
- No new runtime dependencies without prior discussion in an issue.
- Keep the scope: backchannel is a spool with inbox hooks and human notifications, not a chat product and not an execution trigger. Features that imply message history, a UI, or running agents/code in response to inbound messages are out of scope.

## Roadmap (help wanted)

1. Windows support (the Maildir rename trick needs verification on NTFS)
2. AMQ interop adapter (read/write agent-message-queue Maildirs)
3. Token rotation (`bch token rotate`) without relay-host file surgery
