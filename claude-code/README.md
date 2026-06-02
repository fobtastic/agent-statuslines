# Claude Code Statusline

Statusline layout config for [ccstatusline](https://www.npmjs.com/package/ccstatusline) — the Claude Code statusline renderer.

## Files

- **`settings.json`** — ccstatusline layout config. Two-line statusline: model + thinking effort + CWD + git branch + git changes on line 1; context length + token totals + cache + reset timer + weekly usage on line 2. TokyoNight powerline theme.

## Setup

1. Install ccstatusline config:

```bash
mkdir -p ~/.config/ccstatusline
cp settings.json ~/.config/ccstatusline/settings.json
```

2. Add to `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "npx -y ccstatusline@latest",
    "padding": 0
  }
}
```

## Requirements

- Node.js + npx (ccstatusline is fetched automatically via npx)
