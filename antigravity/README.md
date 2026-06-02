# Antigravity CLI Statusline

Custom statusline for [Antigravity CLI](https://github.com/google-deepmind/antigravity).

## Files

- **`statusline-blue.js`** — Main statusline renderer. Reads JSON from stdin, outputs a color-coded statusline with model, CWD, git branch, PR status, context window bar, and cache hit rate.
- **`update_pr_cache.js`** — Async PR cache updater. Spawned as a detached background process by `statusline-blue.js` to keep the cursor responsive. Caches PR status to `~/.gemini/gh-pr-status-cache.json`.

## Setup

1. Copy scripts to `~/.gemini/`:

```bash
cp statusline-blue.js update_pr_cache.js ~/.gemini/
chmod +x ~/.gemini/statusline-blue.js ~/.gemini/update_pr_cache.js
```

2. Add to `~/.gemini/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "/home/ubuntu/.gemini/statusline-blue.js",
    "enabled": true,
    "padding": 0
  }
}
```

Replace `/home/ubuntu/` with your actual home directory path.

## Requirements

- Node.js v16+
- `gh` CLI (optional, for PR badges)
