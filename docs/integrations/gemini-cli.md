# Gemini CLI

## MCP tools

```json
// ~/.gemini/settings.json
{
  "mcpServers": {
    "backchannel": {
      "command": "bch",
      "args": ["mcp"]
    }
  }
}
```

## Instructions

Add the messaging section to `GEMINI.md` (project or global) — same text as the Codex snippet in [codex.md](codex.md), or the full SKILL.md.

## Wake — spawn a turn on urgent messages

```sh
bch watch --urgent-only --exec 'gemini -p "Backchannel message from {{from}}: {{body}} — handle this."'
```

Give the Gemini agent its own identity: `BACKCHANNEL_AGENT=gemini-1 bch init gemini-1`, then export `BACKCHANNEL_AGENT=gemini-1` where Gemini CLI runs.
