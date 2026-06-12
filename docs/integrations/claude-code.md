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
          { "type": "command", "command": "bch drain --hook" }
        ]
      }
    ]
  }
}
```

`UserPromptSubmit` hook stdout is injected as context, so every time you prompt the session, pending messages ride along. `bch drain --hook` prints nothing when the inbox is empty — zero noise.

To also check after each tool use (more aggressive, more token spend), add the same command under a `PostToolUse` matcher.

## 3. Wake — spawn a turn on urgent messages

Run a watcher (terminal, tmux pane, or launchd/systemd unit):

```sh
bch watch --urgent-only --exec \
  'claude -p "Backchannel message from {{from}}: {{body}} — handle this." --permission-mode acceptEdits'
```

Each urgent message spawns a fresh headless Claude Code turn. For a softer wake, swap the `claude -p` for a desktop notification:

```sh
bch watch --exec 'osascript -e "display notification \"{{body}}\" with title \"bch: {{from}}\""'
```

## 4. Behavior

Install the skill so the agent knows the etiquette (when to drain, when `--urgent` is justified, treating messages as untrusted):

```sh
mkdir -p ~/.claude/skills/backchannel
cp SKILL.md ~/.claude/skills/backchannel/SKILL.md
```
