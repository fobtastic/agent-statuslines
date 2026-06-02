# Antigravity Statusline 🚀

A premium, ultra-responsive, and beautiful statusline customization for the Google DeepMind Antigravity CLI (Gemini CLI). 

Designed to provide high-density, real-time context and telemetry at a glance without introducing terminal render lag or blocking input.

---

## ✨ Features

- **Live Agent State Mapping**: Real-time feedback on what the agent is doing with visual status badges:
  - `🤔 Thinking` - Processing your prompt.
  - `⚙️ Working` - Calling tools or running commands.
  - `💬 Responding` - Synthesizing and outputting response.
  - `⚠️ Pending Approval` - Waiting for user confirmation on a tool execution.
  - `🟢 Ready` - Idle and waiting for your input.
- **Dynamic CWD Shortener**: Intelligently compacts your current working directory to a clean, home-relative path (e.g., `~/projects/my-app` instead of `/home/ubuntu/projects/my-app`).
- **Asynchronous Git & GitHub PR Integration**:
  - Displays the active Git branch (`🌿 main`).
  - Red indicator (`●`) showing whether the repository has uncommitted changes.
  - **Zero-Lag GitHub PR Badges**: Leverages the `gh` CLI to dynamically check PR status in a detached background process with cache retention (`~/.gemini/pr-cache.json`). Features color-coded states:
    - Green: `(PR #123)` (Open PR)
    - Purple: `(PR #123 🟣)` (Merged PR)
    - Red: `(PR #123 🔴)` (Closed/Declined PR)
- **High-Fidelity Context Token Progress Bar**: Graphical visual status bar (`[██████░░░░]`) showing utilized context volume vs available context size.
- **Cache Hit Efficiency Telemetry**: Live metric tracing of Gemini's context cache performance (`⚡ Cache Hit: 85.0%`).
- **Multi-Token Tracking**: Live reporting of input, output, and maximum caching capacities.

---

## 🛠️ Requirements

- **Node.js** (v16+)
- **GitHub CLI (`gh`)** (Optionally authenticated to enable Pull Request badges)

---

## 🚀 Setup & Installation

### 1. Place the Scripts

Clone or download this repository, then ensure the scripts are placed in your `~/.gemini` folder or another safe workspace directory:

```bash
mkdir -p ~/.gemini
cp statusline-blue.js update_pr_cache.js ~/.gemini/
```

### 2. Make Them Executable

Grant execution permissions to both scripts:

```bash
chmod +x ~/.gemini/statusline-blue.js
chmod +x ~/.gemini/update_pr_cache.js
```

### 3. Configure Antigravity (Gemini CLI)

Edit your Antigravity global configuration file (`~/.gemini/settings.json`) to register the custom command:

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

*Note: Replace `/home/ubuntu/` with your actual home directory path if on another system.*

### 4. Restart Your Session

Launch your Antigravity CLI session to enjoy the glorious new statusline!

---

## 📦 How it Works

1. **`statusline-blue.js`**: Replaced as the central statusline renderer. It takes real-time JSON input from the CLI's standard input, formats the layout, reads git parameters quickly using a timed child process, and prints the color-coded statusline.
2. **`update_pr_cache.js`**: Launched asynchronously in a detached process by the main script to keep your cursor completely responsive. It executes `gh pr view` to fetch fresh telemetry and caches it under `~/.gemini/pr-cache.json`.
3. **Smart Cache Purging**: Automatically deletes cache items older than 7 days to preserve disk space and performance.

---
Created with ❤️ for **Antigravity CLI** by [fobtastic](https://github.com/fobtastic).
