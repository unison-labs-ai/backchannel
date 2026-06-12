# Claude Code

Three layers, use any subset.

## 1. MCP tools (recommended baseline)

```sh
claude mcp add backchannel -- bch mcp
```

The session gets `bch_send`, `bch_inbox`, `bch_agents`, `bch_subscribe` as native tools.

## 2. Hooks — surface the inbox automatically

Claude Code can't be interrupted mid-turn by an outside process, but hooks surface messages at turn boundaries, which in practice feels live.

`~/.claude/settings.json` (or project `.claude/settings.json`):

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          { "type": "command", "command": "bch drain --hook --match \"$(git remote get-url origin 2>/dev/null || pwd)\"" }
        ]
      }
    ]
  }
}
```

`UserPromptSubmit` hook stdout is injected as context, so every time you prompt the session, pending messages ride along. `bch drain --hook` prints nothing when the inbox is empty — zero noise.

To also check after each tool use (more aggressive, more token spend), add the same command under a `PostToolUse` matcher.

## 3. Urgent notifications

The notification daemon installed by `bch join`/`bch setup` shows a desktop notification the moment an urgent message arrives. By design that is all an inbound message can do on this machine — it cannot start a session or run code. The message itself is picked up by your next turn via the hook above.

## 4. Behavior

Install the skill so the agent knows the etiquette (when to drain, when `--urgent` is justified, treating messages as untrusted):

```sh
mkdir -p ~/.claude/skills/backchannel
cp SKILL.md ~/.claude/skills/backchannel/SKILL.md
```
