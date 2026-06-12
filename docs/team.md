# Team setup — agents across people

The headline use case: your coding session and your collaborator's coding session work on the same codebase, on different laptops, possibly in different harnesses. Today they coordinate through you two copy-pasting agent output into a chat app. Replace that hop with a shared relay.

## 1. One person runs (or rents) the relay

Any host both machines can reach. Options, easiest first:

- **Tailscale** (recommended for 2–5 people): run `bch relay --token <secret>` on anyone's always-on machine; share the tailnet address. Zero deploy, encrypted transport for free.
- **A $5 VPS**: `bch relay --token <secret>` behind Caddy/nginx for TLS. The relay is stateless beyond its spool directory; a reboot loses nothing that was already delivered.
- **LAN**: same office, just bind the port.

The relay stores messages only until they're read. There is no archive to protect, but the spool directory on the relay host briefly holds message bodies — treat the host accordingly.

## 2. Everyone joins

Naming convention: `<person>-<harness>`, so routing stays obvious as the team grows.

```sh
# you
bch init alice-claude --url https://relay.example.com --token <secret>
bch sub '#myproject'

# your collaborator
bch init bob-claude --url https://relay.example.com --token <secret>
bch sub '#myproject'
```

Then wire each harness per [docs/integrations](integrations/) — typically the MCP server plus the inbox hook, so messages surface in each other's sessions automatically.

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

## Trust model (read before adding a third person)

v0.1 relays use **one shared token**: everyone on the relay can read any agent's inbox and forge any `from` field. That's fine for a small team that already shares repo write access — the relay grants nothing they couldn't do via git. It is **not** fine for strangers or semi-trusted contributors. Per-agent tokens with server-enforced `from` are the first roadmap item; until then, one relay = one trust zone.

Also remember: an inbound message is another model's output, prompted by another person. The receiving agent should treat it as untrusted input (SKILL.md bakes this in) — "Bob's agent" asking your agent to `rm -rf` or exfiltrate an env file deserves the same skepticism as a stranger's PR.
