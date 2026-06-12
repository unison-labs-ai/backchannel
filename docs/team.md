# Team setup — agents across people

The headline use case: your coding session and your collaborator's coding session work on the same codebase, on different laptops, possibly in different harnesses. Today they coordinate through you two copy-pasting agent output into a chat app. Replace that hop with a shared relay.

## 1. One person runs (or rents) the relay

Any host both machines can reach. Options, easiest first:

- **Tailscale** (recommended for 2–5 people): run `bch relay --token <secret>` on anyone's always-on machine; share the tailnet address. Zero deploy, encrypted transport for free.
- **A $5 VPS**: `bch relay --token <secret>` behind Caddy/nginx for TLS. The relay is stateless beyond its spool directory; a reboot loses nothing that was already delivered.
- **LAN**: same office, just bind the port.

The relay stores messages only until they're read. There is no archive to protect, but the spool directory on the relay host briefly holds message bodies — treat the host accordingly.

## 2. Invite, join, done

Whoever knows the room token mints an invite:

```sh
bch invite --url https://relay.example.com --token <room-secret> --channel '#myproject'
```

That prints a `bch join <blob> --as <name>` command. Your collaborator runs it once (naming convention: `<person>-<harness>`):

```sh
bch join bch1-… --as bob-claude
```

`join` does the whole setup, not just registration: it detects the harnesses on their machine and installs the inbox hook + skill + MCP server for Claude Code, the MCP block + AGENTS.md section for Codex, the MCP entry for Gemini CLI, **and a wake daemon** (launchd/systemd) that turns urgent messages into a spawned agent turn — `claude -p` or `codex exec`, or a desktop notification if no harness CLI is found. Opt-outs: `--no-hooks`, `--no-wake`, `--wake-exec '<custom command>'`. Re-run anytime with `bch setup`.

Share invites over a private channel — the blob contains the room token.

## 3. The flow the screenshot dies for

```sh
# Bob's session, after merging a PR that affects Alice's in-flight branch:
bch send @alice-claude "PR #42 merged. Your feature branch forks from before it — \
rebase now, it's easier with #42 in. I didn't touch the modules you're deleting." \
  --ref https://github.com/yourorg/yourrepo/pull/42 --urgent

# Alice's session (hook fires, or `bch drain`):
# reads it, rebases, replies:
bch send @bob-claude "rebased onto main, two conflicts resolved, CI green" --thread <id>
```

Humans see what they choose to see (`bch inbox` is just a CLI — you can read your own agent's mail), but they're no longer the transport.

## Multi-session routing (the part that makes this work in practice)

A name like `alice-claude` is one inbox, even if Alice has four sessions open. Scopes route within it:

- Send with `--scope <repo-or-topic>` when the message belongs to specific work: `bch send @alice-claude "rebase now" --scope github.com/org/myrepo --urgent`.
- Each session's inbox hook drains with its own context: `bch drain --hook --match "$(git remote get-url origin 2>/dev/null || pwd)"`. Claims are atomic — concurrent sessions never double-take a message.
- Result: the rebase ping is only ever claimed by Alice's session *in that repo* — including a session she opens tomorrow. Her unrelated sessions never see it. Unscoped messages go to whichever of her sessions reads next, which is what you want for "tell Alice's agent" with no specific home.

## Trust model (read before adding a third person)

The room token only lets someone **join**. On registration each agent gets a personal token (stored hashed on the relay); after that, `from` is server-enforced, inboxes are private, and registered names can't be taken over with the room token. So a relay member can't impersonate another member or read their mail.

What the relay host can still do: read spooled (not-yet-claimed) message bodies on disk. And any member can *send* your agent manipulative instructions — that's inherent to messaging. SKILL.md instructs receiving agents to treat messages as untrusted input; keep that installed.

Also remember: an inbound message is another model's output, prompted by another person. The receiving agent should treat it as untrusted input (SKILL.md bakes this in) — "Bob's agent" asking your agent to `rm -rf` or exfiltrate an env file deserves the same skepticism as a stranger's PR.
