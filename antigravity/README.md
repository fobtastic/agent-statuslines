# Antigravity CLI Statusline

Custom statusline for [Antigravity CLI](https://antigravity.google/docs/cli/statusline/).

## Files

- **`statusline-blue.js`** - Main statusline renderer. Reads JSON telemetry from stdin and outputs a two-line, width-adaptive statusline with:
  - Model name and effort level, extended `agent_state` (`idle`, `thinking`, `working`, `tool_use`, `responding`, `reviewing`, `initializing`, `authenticating`, `error`, `tool_confirmation_pending`), and optional badges (`cycle_mode`, `vim.mode`, `agent.name`, `pending_input_count`, running `subagents`, active `task_count`)
  - Workspace path, pure-JS `.git/HEAD` branch resolution (supporting worktrees and detached HEADs, plus native `vcs` telemetry and async reftable resolution), 5-second async per-repo dirty/reftable cache in `~/.gemini/cache/` (`--refresh-git`), PR status badge, and deduplicated CMUX sidebar status updates in `~/.gemini/cache/`
  - Context window bar with high-usage / `exceeds_200k_tokens` highlighting, input/output token counts, cache hit rate, 5-minute prompt cache TTL countdown, and session `cost` (`total_usd`)
  - Dynamic per-model-family quota (`Gem` / `Flash` / `Pro` / `Claude` / `GPT` / `3P`) without cross-family fallbacks, `reset_time` ISO fallback when `reset_in_seconds` is missing/zero, `disabled` bucket filtering, and G1/AI credits (`remaining_amount`) display
- **`update_pr_cache.js`** - Async PR cache updater. Spawned as a detached background process with a 30-second fetch lock, 3-minute TTL, per-key atomic JSON files under `~/.gemini/cache/pr/`, and 7-day pruning of stale cache and `.tmp` files under `~/.gemini/cache/`.
- **`statusline-blue.test.js`** - Unit tests using Node's built-in `node:test` runner (`node --test antigravity/statusline-blue.test.js`).

## Setup

1. Copy scripts to `~/.gemini/`:

```bash
cp statusline-blue.js update_pr_cache.js ~/.gemini/
chmod +x ~/.gemini/statusline-blue.js ~/.gemini/update_pr_cache.js
```

2. Add to `~/.gemini/antigravity-cli/settings.json` (and `~/.gemini/settings.json`):

```json
{
  "statusLine": {
    "type": "command",
    "command": "/Users/your-user/.gemini/statusline-blue.js",
    "enabled": true,
    "padding": 0,
    "stack_with_default": false
  }
}
```

Antigravity CLI also supports `"stack_with_default": true` inside `statusLine` (to render the custom statusline below the built-in one) and a sibling `"title"` object (`{ "type": "command", "command": "..." }`) for custom terminal window titles.

## Requirements

- Node.js v18+
- `gh` CLI (optional, for PR badges)
