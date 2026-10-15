#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const home = process.env.HOME || '/home/ubuntu';

const formatDuration = (seconds) => {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return 'now';
  const s = Math.floor(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return h > 0 ? `${d}d${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${h}h`;
  if (m > 0) return sec > 0 && m < 10 ? `${m}m${String(sec).padStart(2, '0')}s` : `${m}m`;
  return `${sec}s`;
};

const resolveCmuxCli = () => {
  const candidates = [
    process.env.CMUX_BUNDLED_CLI_PATH,
    "/Applications/cmux.app/Contents/Resources/bin/cmux",
    "/opt/homebrew/bin/cmux",
    "/usr/local/bin/cmux",
    path.join(home, ".local/bin/cmux"),
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return "";
};

try {
  const input = fs.readFileSync(0, 'utf-8');
  if (!input.trim()) process.exit(0);

  const data = JSON.parse(input);

  if (process.env.AGY_STATUSLINE_DEBUG === '1') {
    try {
      fs.writeFileSync('/tmp/telemetry_dump.json', JSON.stringify(data, null, 2));
    } catch (e) {}
  }

  let model = data.model?.display_name || "Antigravity";
  const effort = data.model?.effort;
  if (effort && !model.toLowerCase().includes(effort.toLowerCase())) {
    model = `${model} (${effort.charAt(0).toUpperCase() + effort.slice(1)})`;
  }
  const agentKey = "agy";

  // Update CMUX sidebar status dynamically
  try {
    let value = "Ready";
    let icon = "checkmark.circle.fill";
    let color = "#34C759";

    if (data.tool_confirmation_pending) {
      value = "Pending Approval";
      icon = "exclamationmark.triangle.fill";
      color = "#FFB300";
    } else if (data.agent_state === "thinking") {
      value = "Thinking";
      icon = "brain.head.profile";
      color = "#4C8DFF";
    } else if (data.agent_state === "tool_use" || data.agent_state === "working") {
      value = "Working";
      icon = "gearshape.fill";
      color = "#4C8DFF";
    } else if (data.agent_state === "responding") {
      value = "Responding";
      icon = "bubble.left.and.bubble.right.fill";
      color = "#00E5FF";
    } else {
      value = "Idle";
      icon = "pause.circle.fill";
      color = "#8E8E93";
    }

    const cmuxCli = resolveCmuxCli();
    if (cmuxCli) {
      let socketPath = process.env.CMUX_SOCKET_PATH || "";
      if (!socketPath && home) {
        socketPath = path.join(home, ".local/state/cmux/cmux.sock");
      }
      const args = [];
      if (socketPath && fs.existsSync(socketPath)) {
        args.push("--socket", socketPath);
      }
      args.push("set-status", agentKey, value);
      const workspaceId = process.env.CMUX_WORKSPACE_ID || "";
      if (workspaceId) {
        args.push("--workspace", workspaceId);
      }
      const windowId = process.env.CMUX_WINDOW_ID || "";
      if (windowId) {
        args.push("--window", windowId);
      }
      args.push("--icon", icon, "--color", color);
      const child = spawn(cmuxCli, args, {
        detached: true,
        stdio: 'ignore'
      });
      child.unref();
    }
  } catch (e) {}

  const cwd = data.cwd || process.cwd();

  // Shorten CWD to home-relative path
  const cwdShort = cwd.startsWith(home) ? cwd.replace(home, '~') : cwd;

  // Retrieve context window data
  const ctx = data.context_window || {};
  const usedTokens = ctx.total_input_tokens || 0;
  const totalTokens = ctx.context_window_size || 1048576;
  const usedPercent = ctx.used_percentage ? ctx.used_percentage.toFixed(1) : "0.0";

  // Build the progress bar (based on used percentage)
  const barSize = 10;
  const filled = Math.min(barSize, Math.max(0, Math.round((parseFloat(usedPercent) * barSize) / 100)));
  const empty = barSize - filled;
  const bar = "█".repeat(filled);
  const barEmpty = "░".repeat(empty);

  // Helper to format numbers (e.g. 122953 -> 123k, 1048576 -> 1M)
  const formatTokens = (num) => {
    if (num >= 1000000) return (num / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    return num;
  };

  // Color Definitions (ANSI)
  const BLUE = "\x1b[1;34m";
  const GREEN = "\x1b[1;32m";
  const YELLOW = "\x1b[1;33m";
  const RED = "\x1b[1;31m";
  const CYAN = "\x1b[1;36m";
  const RESET = "\x1b[0m";
  const GRAY = "\x1b[90m";

  // Calculate Context Cache efficiency & freshness/TTL (5m implicit cache window)
  const cacheRead = ctx.current_usage?.cache_read_input_tokens || 0;
  let hitRate = usedTokens > 0 ? ((cacheRead / usedTokens) * 100) : 0;
  if (hitRate > 100) hitRate = 100.0; // Cap to 100% to handle race conditions in token count propagation
  const cacheHitRate = hitRate.toFixed(1);

  let cacheTtlStr = "";
  const isAgentBusy =
    data.agent_state === "thinking" ||
    data.agent_state === "tool_use" ||
    data.agent_state === "working" ||
    data.agent_state === "responding";

  if (usedTokens > 0 && data.transcript_path) {
    if (isAgentBusy) {
      cacheTtlStr = ` ${GRAY}(${GREEN}hot${GRAY})${RESET}`;
    } else {
      try {
        const stat = fs.statSync(data.transcript_path);
        const ageSec = Math.max(0, Math.floor((Date.now() - stat.mtimeMs) / 1000));
        const ttlTotal = 300;
        if (ageSec < ttlTotal) {
          const remSec = ttlTotal - ageSec;
          const ttlColor = remSec > 60 ? GREEN : YELLOW;
          cacheTtlStr = ` ${GRAY}(TTL ${ttlColor}${formatDuration(remSec)}${GRAY})${RESET}`;
        } else {
          cacheTtlStr = ` ${GRAY}(cold ${formatDuration(ageSec)})${RESET}`;
        }
      } catch (e) {}
    }
  }

  // Build Antigravity telemetry segments
  const cacheStr = ` ${GRAY}|${RESET} ⚡ Cache: ${BLUE}${cacheHitRate}%${RESET}${cacheTtlStr}`;

  let quotaStr = "";
  if (data.quota && typeof data.quota === "object") {
    const isGeminiModel = /gemini|gemma|antigravity/i.test(model);
    const prefix = isGeminiModel ? "gemini" : "3p";
    const q5h = data.quota[`${prefix}-5h`] || data.quota["gemini-5h"];
    const qWk = data.quota[`${prefix}-weekly`] || data.quota["gemini-weekly"];

    const formatBucket = (label, bucket) => {
      if (!bucket || typeof bucket.remaining_fraction !== "number") return "";
      const pct = Math.max(0, Math.min(100, Math.round(bucket.remaining_fraction * 100)));
      const color = pct >= 50 ? GREEN : pct >= 20 ? YELLOW : RED;
      const reset =
        typeof bucket.reset_in_seconds === "number" && bucket.reset_in_seconds > 0
          ? ` ${GRAY}↻${formatDuration(bucket.reset_in_seconds)}${RESET}`
          : "";
      return `${label}: ${color}${pct}%${RESET}${reset}`;
    };

    const parts = [formatBucket("5h", q5h), formatBucket("Wk", qWk)].filter(Boolean);
    if (parts.length > 0) {
      quotaStr = ` ${GRAY}|${RESET} 🔋 ${parts.join(` ${GRAY}·${RESET} `)}`;
    }
  }

  const outTokens = ctx.total_output_tokens || 0;
  const outStr = outTokens > 0 ? `, Out: ${formatTokens(outTokens)}` : "";

  // Mapping agent state and tool confirmation pending status
  let statusStr = "";
  if (data.tool_confirmation_pending) {
    statusStr = ` \x1b[90m[\x1b[0m\x1b[1;33m⚠️ Pending Approval\x1b[0m\x1b[90m]\x1b[0m`;
  } else if (data.agent_state === "thinking") {
    statusStr = ` \x1b[90m[\x1b[0m\x1b[1;34m🤔 Thinking\x1b[0m\x1b[90m]\x1b[0m`;
  } else if (data.agent_state === "tool_use" || data.agent_state === "working") {
    statusStr = ` \x1b[90m[\x1b[0m\x1b[1;34m⚙️ Working\x1b[0m\x1b[90m]\x1b[0m`;
  } else if (data.agent_state === "responding") {
    statusStr = ` \x1b[90m[\x1b[0m\x1b[1;36m💬 Responding\x1b[0m\x1b[90m]\x1b[0m`;
  } else {
    statusStr = ` \x1b[90m[\x1b[0m\x1b[1;32m🟢 Ready\x1b[0m\x1b[90m]\x1b[0m`;
  }

  if (typeof data.task_count === "number" && data.task_count > 0) {
    statusStr += ` ${GRAY}[${RESET}${CYAN}⏳ ${data.task_count} task${data.task_count > 1 ? "s" : ""}${RESET}${GRAY}]${RESET}`;
  }

  // Git branch, dirty status, and PR info
  let gitStr = "";
  try {
    const revOut = execFileSync(
      'git',
      ['--no-optional-locks', 'rev-parse', '--show-toplevel', '--abbrev-ref', 'HEAD'],
      { cwd, timeout: 200, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();
    if (revOut) {
      const lines = revOut.split('\n');
      if (lines.length >= 2) {
        const repoDir = lines[0].trim();
        const gitBranch = lines[1].trim();
        let isDirty = false;
        try {
          const dirtyOut = execFileSync(
            'git',
            ['--no-optional-locks', 'status', '--porcelain', '-uno'],
            { cwd: repoDir, timeout: 200, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
          ).trim();
          isDirty = dirtyOut.length > 0;
        } catch (e) {}

        if (repoDir && gitBranch) {
          const dirtyIndicator = isDirty ? "\x1b[1;31m●\x1b[0m" : "";

          // Retrieve cached PR info
          let pr = null;
          const geminiDir = path.join(home, '.gemini');
          const cacheFile = path.join(geminiDir, 'pr-cache.json');
          const cacheKey = `${repoDir}:${gitBranch}`;
          let cache = {};
          if (fs.existsSync(cacheFile)) {
            try {
              cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
            } catch (e) {}
          }

          const cachedEntry = cache[cacheKey];
          const now = Date.now();
          const isStale = !cachedEntry || (now - cachedEntry.updatedAt > 180000);
          const isFetching = cachedEntry?.fetchingAt && (now - cachedEntry.fetchingAt < 30000);

          // Trigger background cache update if missing or older than 3 minutes (180000ms)
          if (isStale && !isFetching) {
            try {
              cache[cacheKey] = Object.assign({}, cachedEntry || { state: 'NONE', updatedAt: 0 }, {
                fetchingAt: now
              });
              fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2), 'utf8');
              const child = spawn(process.execPath, [
                path.join(__dirname, 'update_pr_cache.js'),
                repoDir,
                gitBranch
              ], {
                detached: true,
                stdio: 'ignore'
              });
              child.unref();
            } catch (e) {}
          }

          if (cachedEntry && cachedEntry.state !== "NONE" && cachedEntry.number) {
            pr = cachedEntry;
          }

          // Build the PR badge
          let prStr = "";
          if (pr) {
            if (pr.state === "OPEN") {
              // Determine CI Status
              let ciStatus = 'NONE'; // 'SUCCESS', 'PENDING', 'FAILURE', 'NONE'
              const rollup = pr.statusCheckRollup || [];
              if (rollup.length > 0) {
                let hasFailure = false;
                let hasPending = false;
                let hasSuccess = false;
                for (const check of rollup) {
                  const state = check.state || check.conclusion;
                  const status = check.status;
                  
                  if (state === 'FAILURE' || state === 'ERROR' || state === 'CANCELLED' || state === 'TIMED_OUT') {
                    hasFailure = true;
                  } else if (state === 'PENDING' || status === 'IN_PROGRESS' || status === 'QUEUED' || !state) {
                    hasPending = true;
                  } else if (state === 'SUCCESS') {
                    hasSuccess = true;
                  }
                }
                if (hasFailure) {
                  ciStatus = 'FAILURE';
                } else if (hasPending) {
                  ciStatus = 'PENDING';
                } else if (hasSuccess) {
                  ciStatus = 'SUCCESS';
                }
              }

              const isMergeable = pr.mergeable === "MERGEABLE";
              const hasConflicts = pr.mergeable === "CONFLICTING";

              let prColor = "\x1b[1;32m"; // default to Green
              let prSuffix = "";

              if (ciStatus === 'FAILURE' || hasConflicts) {
                prColor = "\x1b[1;31m"; // Red for blockages
                if (hasConflicts) {
                  prSuffix = " ⚡Conflict";
                } else {
                  prSuffix = " ❌";
                }
              } else if (ciStatus === 'PENDING') {
                prColor = "\x1b[1;33m"; // Yellow for progress
                prSuffix = " ⏳";
              } else if (ciStatus === 'SUCCESS' && isMergeable) {
                prColor = "\x1b[1;32m"; // Green for ready to merge
                prSuffix = " ✅";
              } else {
                prColor = "\x1b[1;32m";
              }

              prStr = ` \x1b[90m(\x1b[0m${prColor}PR #${pr.number}${prSuffix}\x1b[0m\x1b[90m)\x1b[0m`;
            } else if (pr.state === "MERGED") {
              prStr = ` \x1b[90m(\x1b[0m\x1b[1;35mPR #${pr.number} 🟣\x1b[0m\x1b[90m)\x1b[0m`;
            } else if (pr.state === "CLOSED") {
              prStr = ` \x1b[90m(\x1b[0m\x1b[1;31mPR #${pr.number} 🔴\x1b[0m\x1b[90m)\x1b[0m`;
            }
          }

          gitStr = ` ${GRAY}|${RESET} 🌿 ${BLUE}${gitBranch}${dirtyIndicator}${prStr}${RESET}`;
        }
      }
    }
  } catch (e) {
    // Silent fail if git command errors or timeout
  }

  // Print to stdout (two lines)
  console.log(`${BLUE}🤖 ${model}${RESET}${statusStr} ${GRAY}|${RESET} 📂 ${cwdShort}${gitStr}\x1b[K\n${GRAY}└─▶${RESET} Context: [${BLUE}${bar}${GRAY}${barEmpty}${RESET}] ${usedPercent}% (${formatTokens(usedTokens)}/${formatTokens(totalTokens)}${outStr} t)${cacheStr}${quotaStr}\x1b[K`);
  process.exit(0);
} catch (e) {
  process.exit(0);
}
