# Antigravity CLI Statusline

Custom statusline for [Antigravity CLI](https://antigravity.google/docs/cli/reference).

## Files

- **`statusline-blue.js`** - Main statusline renderer. Reads JSON telemetry from stdin and outputs a two-line statusline with:
  - Model name and effort level, live agent state, and active background task count
  - Workspace path, git branch, lock-free worktree dirty indicator, and PR status badge
  - Context window usage bar, input/output token counts, cache hit rate, and 5-minute prompt cache TTL countdown
  - 5-hour and weekly quota remaining percentages with reset countdown timers
- **`update_pr_cache.js`** - Async PR cache updater. Spawned as a detached background process with a 30-second fetch lock and 3-minute TTL in `~/.gemini/pr-cache.json`.

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
    "padding": 0
  }
}
```

## Requirements

- Node.js v16+
- `gh` CLI (optional, for PR badges)
