#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');

const home = process.env.HOME || os.homedir() || '/home/ubuntu';

const BLUE = '\x1b[1;34m';
const GREEN = '\x1b[1;32m';
const YELLOW = '\x1b[1;33m';
const RED = '\x1b[1;31m';
const MAGENTA = '\x1b[1;35m';
const CYAN = '\x1b[1;36m';
const GRAY = '\x1b[90m';
const RESET = '\x1b[0m';

const GIT_DIRTY_TTL_MS = 5000;
const GIT_REFRESH_LOCK_MS = 10000;
const CMUX_DEDUPE_TTL_MS = 60000;
const PR_CACHE_TTL_MS = 180000;
const PR_FETCH_LOCK_MS = 30000;
const CACHE_TTL_SECONDS = 300;

const hashKey = (str) => crypto.createHash('sha1').update(str).digest('hex').slice(0, 12);
const getCacheDir = (overrideDir) => overrideDir || path.join(home, '.gemini', 'cache');

const readJsonSafe = (filePath) => {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (_) {}
  return null;
};

const writeJsonAtomic = (filePath, obj) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    fs.renameSync(tmp, filePath);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw e;
  }
};

const WIDE_SYMBOLS = new Set([0x23f3, 0x2699, 0x26a0, 0x26a1, 0x2705, 0x270f, 0x274c]);

const displayWidth = (str) => {
  const plain = String(str).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  let width = 0;
  for (const ch of plain) {
    const cp = ch.codePointAt(0);
    if (cp === 0xfe0e || cp === 0xfe0f || cp === 0x200d) continue;
    if (
      (cp >= 0x1f300 && cp <= 0x1faff) ||
      WIDE_SYMBOLS.has(cp) ||
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0x9fff) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xff01 && cp <= 0xff60)
    ) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
};

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

const formatTokens = (num) => {
  if (num >= 1000000) return (num / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return num;
};

const resolveCmuxCli = () => {
  const candidates = [
    process.env.CMUX_BUNDLED_CLI_PATH,
    '/Applications/cmux.app/Contents/Resources/bin/cmux',
    '/opt/homebrew/bin/cmux',
    '/usr/local/bin/cmux',
    path.join(home, '.local/bin/cmux'),
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return '';
};

const STATE_TABLE = {
  thinking: { badge: `${BLUE}🤔 Thinking${RESET}`, busy: true, cmuxValue: 'Thinking', cmuxIcon: 'brain.head.profile', cmuxColor: '#4C8DFF' },
  tool_use: { badge: `${BLUE}⚙️ Working${RESET}`, busy: true, cmuxValue: 'Working', cmuxIcon: 'gearshape.fill', cmuxColor: '#4C8DFF' },
  working: { badge: `${BLUE}⚙️ Working${RESET}`, busy: true, cmuxValue: 'Working', cmuxIcon: 'gearshape.fill', cmuxColor: '#4C8DFF' },
  responding: { badge: `${CYAN}💬 Responding${RESET}`, busy: true, cmuxValue: 'Responding', cmuxIcon: 'bubble.left.and.bubble.right.fill', cmuxColor: '#00E5FF' },
  reviewing: { badge: `${MAGENTA}👀 Reviewing${RESET}`, busy: true, cmuxValue: 'Reviewing', cmuxIcon: 'eye.fill', cmuxColor: '#AF52DE' },
  initializing: { badge: `${GRAY}🚀 Init${RESET}`, busy: false, cmuxValue: 'Initializing', cmuxIcon: 'hourglass', cmuxColor: '#8E8E93' },
  authenticating: { badge: `${YELLOW}🔑 Auth${RESET}`, busy: false, cmuxValue: 'Authenticating', cmuxIcon: 'key.fill', cmuxColor: '#FFB300' },
  error: { badge: `${RED}❌ Error${RESET}`, busy: false, cmuxValue: 'Error', cmuxIcon: 'xmark.octagon.fill', cmuxColor: '#FF3B30' },
  idle: { badge: `${GREEN}🟢 Ready${RESET}`, busy: false, cmuxValue: 'Idle', cmuxIcon: 'pause.circle.fill', cmuxColor: '#8E8E93' },
};

const PENDING_APPROVAL_STATE = {
  badge: `${YELLOW}⚠️ Pending Approval${RESET}`,
  busy: false,
  cmuxValue: 'Pending Approval',
  cmuxIcon: 'exclamationmark.triangle.fill',
  cmuxColor: '#FFB300',
};

const resolveAgentState = (data) => {
  if (data.tool_confirmation_pending) return PENDING_APPROVAL_STATE;
  return STATE_TABLE[data.agent_state] || STATE_TABLE.idle;
};

const updateCmuxStatus = (data, stateMeta, nowMs = Date.now(), opts = {}) => {
  try {
    const socketPath = process.env.CMUX_SOCKET_PATH || '';
    const workspaceId = process.env.CMUX_WORKSPACE_ID || '';
    const hasCmux =
      opts.hasCmux !== undefined
        ? opts.hasCmux
        : Boolean(
            socketPath ||
              workspaceId ||
              fs.existsSync(path.join(home, '.local/state/cmux/cmux.sock')) ||
              fs.existsSync(path.join(home, '.cmux/socket_addr'))
          );
    if (!hasCmux) return;

    const cmuxCli = opts.cmuxCli !== undefined ? opts.cmuxCli : resolveCmuxCli();
    if (!cmuxCli) return;

    const windowId = process.env.CMUX_WINDOW_ID || '';
    const scope = `${windowId}:${workspaceId}:${process.env.CMUX_SURFACE_ID || data.conversation_id || 'default'}`;
    const dedupePath = path.join(getCacheDir(opts.cacheDir), `cmux-${hashKey(scope)}.json`);
    const cached = readJsonSafe(dedupePath);

    if (
      cached &&
      cached.value === stateMeta.cmuxValue &&
      cached.icon === stateMeta.cmuxIcon &&
      cached.color === stateMeta.cmuxColor &&
      typeof cached.updatedAt === 'number' &&
      nowMs - cached.updatedAt < CMUX_DEDUPE_TTL_MS
    ) {
      return;
    }

    writeJsonAtomic(dedupePath, {
      value: stateMeta.cmuxValue,
      icon: stateMeta.cmuxIcon,
      color: stateMeta.cmuxColor,
      updatedAt: nowMs,
    });

    const resolvedSock = socketPath || path.join(home, '.local/state/cmux/cmux.sock');
    const args = [];
    if (resolvedSock && fs.existsSync(resolvedSock)) {
      args.push('--socket', resolvedSock);
    }
    args.push('set-status', 'agy', stateMeta.cmuxValue);
    if (workspaceId) args.push('--workspace', workspaceId);
    if (windowId) args.push('--window', windowId);
    args.push('--icon', stateMeta.cmuxIcon, '--color', stateMeta.cmuxColor);

    const child = spawn(cmuxCli, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {
      try { fs.unlinkSync(dedupePath); } catch (_) {}
    });
    child.unref();
  } catch (_) {}
};

const readGitInfoSync = (startDir) => {
  if (!startDir) return null;
  try {
    let dir = path.resolve(startDir);
    while (true) {
      const dotGit = path.join(dir, '.git');
      let stat = null;
      try {
        stat = fs.statSync(dotGit);
      } catch (_) {}

      if (!stat) {
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
        continue;
      }

      let gitDir = '';
      if (stat.isDirectory()) {
        gitDir = dotGit;
      } else if (stat.isFile()) {
        const match = fs.readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+)$/m);
        if (match) gitDir = path.resolve(dir, match[1].trim());
      }
      if (!gitDir) break;

      const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
      let branch = '';
      let detached = false;
      if (head.startsWith('ref: refs/heads/')) {
        branch = head.slice('ref: refs/heads/'.length).trim();
      } else if (head.startsWith('ref: ')) {
        branch = head.slice('ref: '.length).trim();
      } else if (head) {
        branch = head.slice(0, 7);
        detached = true;
      }
      if (branch === '.invalid') branch = '';
      return { repoDir: dir, branch, detached };
    }
  } catch (_) {}
  return null;
};

const refreshGitDirty = (repoDir, cachePath) => {
  if (!repoDir || !cachePath) return;
  try {
    const out = execFileSync(
      'git',
      ['--no-optional-locks', 'status', '--porcelain', '-uno'],
      { cwd: repoDir, timeout: 3000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }
    ).trim();
    writeJsonAtomic(cachePath, { repoDir, dirty: out.length > 0, updatedAt: Date.now() });
  } catch (_) {}
};

const getGitDirtyCached = (repoDir, nowMs, spawnRefresh = true, cacheDirOverride = '') => {
  const cachePath = path.join(getCacheDir(cacheDirOverride), `git-${hashKey(repoDir)}.json`);
  const entry = readJsonSafe(cachePath);
  const isStale = !entry || typeof entry.updatedAt !== 'number' || nowMs - entry.updatedAt >= GIT_DIRTY_TTL_MS;
  const isRefreshing = entry && typeof entry.refreshingAt === 'number' && nowMs - entry.refreshingAt < GIT_REFRESH_LOCK_MS;

  if (spawnRefresh && isStale && !isRefreshing) {
    try {
      writeJsonAtomic(cachePath, {
        repoDir,
        dirty: Boolean(entry?.dirty),
        updatedAt: entry?.updatedAt || 0,
        refreshingAt: nowMs,
      });
      const child = spawn(process.execPath, [__filename, '--refresh-git', repoDir, cachePath], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.on('error', () => {});
      child.unref();
    } catch (_) {}
  }

  return Boolean(entry?.dirty);
};

const formatPrBadge = (pr) => {
  if (!pr || pr.state === 'NONE' || !pr.number) return '';
  if (pr.state === 'MERGED') {
    return ` ${GRAY}(${RESET}${MAGENTA}PR #${pr.number} 🟣${RESET}${GRAY})${RESET}`;
  }
  if (pr.state === 'CLOSED') {
    return ` ${GRAY}(${RESET}${RED}PR #${pr.number} 🔴${RESET}${GRAY})${RESET}`;
  }
  if (pr.state !== 'OPEN') return '';

  let ciStatus = 'NONE';
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
    if (hasFailure) ciStatus = 'FAILURE';
    else if (hasPending) ciStatus = 'PENDING';
    else if (hasSuccess) ciStatus = 'SUCCESS';
  }

  const hasConflicts = pr.mergeable === 'CONFLICTING';
  const isMergeable = pr.mergeable === 'MERGEABLE';
  let prColor = GREEN;
  let prSuffix = '';

  if (ciStatus === 'FAILURE' || hasConflicts) {
    prColor = RED;
    prSuffix = hasConflicts ? ' ⚡Conflict' : ' ❌';
  } else if (ciStatus === 'PENDING') {
    prColor = YELLOW;
    prSuffix = ' ⏳';
  } else if (ciStatus === 'SUCCESS' && isMergeable) {
    prSuffix = ' ✅';
  }

  return ` ${GRAY}(${RESET}${prColor}PR #${pr.number}${prSuffix}${RESET}${GRAY})${RESET}`;
};

const getPrBadgeCached = (repoDir, gitBranch, nowMs, opts = {}) => {
  const spawnRefresh = opts.spawnRefresh !== false;
  const prCacheDir = path.join(getCacheDir(opts.cacheDir), 'pr');
  const cacheKey = `${repoDir}:${gitBranch}`;
  const entryPath = path.join(prCacheDir, `${hashKey(cacheKey)}.json`);
  const cachedEntry = readJsonSafe(entryPath);
  const isStale = !cachedEntry || typeof cachedEntry.updatedAt !== 'number' || nowMs - cachedEntry.updatedAt > PR_CACHE_TTL_MS;
  const isFetching = cachedEntry?.fetchingAt && nowMs - cachedEntry.fetchingAt < PR_FETCH_LOCK_MS;

  if (spawnRefresh && isStale && !isFetching) {
    try {
      writeJsonAtomic(entryPath, Object.assign({}, cachedEntry || { key: cacheKey, state: 'NONE', updatedAt: 0 }, { fetchingAt: nowMs }));
      const child = spawn(
        process.execPath,
        [path.join(__dirname, 'update_pr_cache.js'), repoDir, gitBranch, prCacheDir],
        { detached: true, stdio: 'ignore', windowsHide: true }
      );
      child.on('error', () => {});
      child.unref();
    } catch (_) {}
  }

  return formatPrBadge(cachedEntry);
};

const resolveModelFamily = (modelObj) => {
  const ident = `${modelObj?.id || ''} ${modelObj?.display_name || ''}`.toLowerCase();
  if (/\b(claude|opus|sonnet|haiku)\b/.test(ident)) {
    return { family: 'claude', prefixes: ['claude', 'anthropic', '3p'], excludeSubPrefixes: [] };
  }
  if (/\b(gpt|openai|codex|o1|o3|o4)\b/.test(ident)) {
    return { family: 'gpt', prefixes: ['gpt', 'openai', '3p'], excludeSubPrefixes: [] };
  }
  if (/\b(gemini|gemma|antigravity|orchestrator)\b/.test(ident)) {
    if (/\bflash\b/.test(ident)) {
      return { family: 'gemini', prefixes: ['gemini-flash', 'flash', 'gemini'], excludeSubPrefixes: ['gemini-pro'] };
    }
    if (/\b(pro|argon|carbon|hydrogen|neon|orchestrator)\b/.test(ident)) {
      return { family: 'gemini', prefixes: ['gemini-pro', 'pro', 'gemini'], excludeSubPrefixes: ['gemini-flash'] };
    }
    return { family: 'gemini', prefixes: ['gemini'], excludeSubPrefixes: [] };
  }
  return { family: '3p', prefixes: ['3p'], excludeSubPrefixes: [] };
};

const getResetSeconds = (bucket, nowMs = Date.now()) => {
  if (typeof bucket?.reset_in_seconds === 'number' && Number.isFinite(bucket.reset_in_seconds) && bucket.reset_in_seconds > 0) {
    return bucket.reset_in_seconds;
  }
  if (typeof bucket?.reset_time === 'string' && bucket.reset_time) {
    const parsed = Date.parse(bucket.reset_time);
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.floor((parsed - nowMs) / 1000));
    }
  }
  return 0;
};

const POOL_LABELS = {
  'gemini-flash': 'Flash',
  flash: 'Flash',
  'gemini-pro': 'Pro',
  pro: 'Pro',
  gemini: 'Gem',
  claude: 'Claude',
  anthropic: 'Claude',
  gpt: 'GPT',
  openai: 'GPT',
  '3p': '3P',
};

const isFractionBucket = (bucket) =>
  Boolean(bucket) &&
  bucket.disabled !== true &&
  typeof bucket.remaining_fraction === 'number' &&
  Number.isFinite(bucket.remaining_fraction);

const findQuotaBucket = (quotaObj, prefixes, exactSuffixes, fuzzyRegex, excludeSubPrefixes = []) => {
  const keys = Object.keys(quotaObj);
  for (const prefix of prefixes) {
    for (const suffix of exactSuffixes) {
      const k = prefix + suffix;
      if (isFractionBucket(quotaObj[k])) {
        return { key: k, prefix, bucket: quotaObj[k] };
      }
    }
    for (const k of keys) {
      const isSiblingSub = excludeSubPrefixes.some(
        (ex) => k.startsWith(`${ex}-`) || k.startsWith(`${ex}_`) || k === ex
      );
      if (isSiblingSub) continue;
      if ((k.startsWith(`${prefix}-`) || k.startsWith(`${prefix}_`)) && fuzzyRegex.test(k.slice(prefix.length + 1))) {
        if (isFractionBucket(quotaObj[k])) {
          return { key: k, prefix, bucket: quotaObj[k] };
        }
      }
    }
  }
  return null;
};

const resolveQuotaSelection = (modelObj, quotaObj, nowMs = Date.now()) => {
  if (!quotaObj || typeof quotaObj !== 'object') {
    return { poolLabel: '', q5h: null, qWk: null, credits: null };
  }

  const { prefixes, excludeSubPrefixes } = resolveModelFamily(modelObj);
  const q5h = findQuotaBucket(quotaObj, prefixes, ['-5h', '_5h', '-session', '_session'], /(?:5h|hour)/i, excludeSubPrefixes);
  const qWk = findQuotaBucket(quotaObj, prefixes, ['-weekly', '-7d', '_weekly', '_7d'], /(?:week|7d)/i, excludeSubPrefixes);
  const matchedPrefix = q5h?.prefix || qWk?.prefix || prefixes[0] || '';
  const poolLabel = POOL_LABELS[matchedPrefix] || '';

  let credits = null;
  for (const [key, bucket] of Object.entries(quotaObj)) {
    if (
      bucket &&
      bucket.disabled !== true &&
      typeof bucket.remaining_amount === 'number' &&
      Number.isFinite(bucket.remaining_amount) &&
      bucket.remaining_amount > 0 &&
      typeof bucket.remaining_fraction !== 'number'
    ) {
      credits = { key, amount: bucket.remaining_amount, bucket };
      break;
    }
  }

  return { poolLabel, q5h, qWk, credits };
};

const formatQuotaSegment = (modelObj, quotaObj, nowMs, width, { includePoolLabel = true } = {}) => {
  const { poolLabel, q5h, qWk, credits } = resolveQuotaSelection(modelObj, quotaObj, nowMs);

  const formatBucket = (label, entry, perWindowPrefix = '') => {
    if (!entry) return '';
    const pct = Math.max(0, Math.min(100, Math.round(entry.bucket.remaining_fraction * 100)));
    const color = pct >= 50 ? GREEN : pct >= 20 ? YELLOW : RED;
    const resetSec = getResetSeconds(entry.bucket, nowMs);
    const reset = resetSec > 0 ? ` ${GRAY}↻${formatDuration(resetSec)}${RESET}` : '';
    const prefixStr = perWindowPrefix ? `${GRAY}${perWindowPrefix}${RESET} ` : '';
    return `${prefixStr}${label}: ${color}${pct}%${RESET}${reset}`;
  };

  const label5h = q5h ? POOL_LABELS[q5h.prefix] || '' : '';
  const labelWk = qWk ? POOL_LABELS[qWk.prefix] || '' : '';
  const hasMixedPools = Boolean(q5h && qWk && label5h && labelWk && label5h !== labelWk);

  const parts = [
    formatBucket('5h', q5h, hasMixedPools ? label5h : ''),
    formatBucket('Wk', qWk, hasMixedPools ? labelWk : ''),
  ].filter(Boolean);

  const minFrac = Math.min(
    ...[q5h?.bucket.remaining_fraction, qWk?.bucket.remaining_fraction].filter((v) => typeof v === 'number')
  );
  const showCredits = Boolean(credits) && (parts.length === 0 || (Number.isFinite(minFrac) && minFrac <= 0.2) || width >= 120);

  if (parts.length === 0 && !showCredits) return '';

  const creditPart = showCredits ? `${CYAN}💳 ${credits.amount}${RESET}` : '';
  if (parts.length === 0) {
    return ` ${GRAY}|${RESET} 🔋 ${creditPart}`;
  }

  const sharedLabel = !hasMixedPools && includePoolLabel && poolLabel ? `${GRAY}${poolLabel}${RESET} ` : '';
  const joined = showCredits ? [...parts, creditPart].join(` ${GRAY}·${RESET} `) : parts.join(` ${GRAY}·${RESET} `);
  return ` ${GRAY}|${RESET} 🔋 ${sharedLabel}${joined}`;
};

const CYCLE_MODE_BADGES = {
  plan: `${GRAY}[${RESET}${YELLOW}📋 Plan${RESET}${GRAY}]${RESET}`,
  auto: `${GRAY}[${RESET}${CYAN}⚡ Auto${RESET}${GRAY}]${RESET}`,
  'accept-edits': `${GRAY}[${RESET}${BLUE}✏️ Edits${RESET}${GRAY}]${RESET}`,
};

const renderStatusLine = (data, opts = {}) => {
  const nowMs = typeof opts.nowMs === 'number' ? opts.nowMs : Date.now();
  const spawnRefresh = opts.spawnRefresh !== false;
  const cacheDir = opts.cacheDir;
  const width = typeof data.terminal_width === 'number' && data.terminal_width > 0 ? data.terminal_width : 140;

  let model = data.model?.display_name || 'Antigravity';
  const effort = data.model?.effort;
  if (effort && !model.toLowerCase().includes(effort.toLowerCase())) {
    model = `${model} (${effort.charAt(0).toUpperCase() + effort.slice(1)})`;
  }

  const stateMeta = resolveAgentState(data);
  const runningSubagents = Array.isArray(data.subagents)
    ? data.subagents.filter((s) => !s.status || s.status === 'running').length
    : 0;
  const isAgentBusy = stateMeta.busy || runningSubagents > 0;

  let statusStr = ` ${GRAY}[${RESET}${stateMeta.badge}${GRAY}]${RESET}`;
  if (data.cycle_mode && CYCLE_MODE_BADGES[data.cycle_mode]) {
    statusStr += ` ${CYCLE_MODE_BADGES[data.cycle_mode]}`;
  }
  if (typeof data.vim?.mode === 'string' && data.vim.mode) {
    statusStr += ` ${GRAY}[${RESET}${MAGENTA}${data.vim.mode}${RESET}${GRAY}]${RESET}`;
  }
  if (typeof data.agent?.name === 'string' && data.agent.name) {
    statusStr += ` ${GRAY}[${RESET}${CYAN}@${data.agent.name}${RESET}${GRAY}]${RESET}`;
  }
  if (typeof data.pending_input_count === 'number' && data.pending_input_count > 0) {
    statusStr += ` ${GRAY}[${RESET}${YELLOW}📥 ${data.pending_input_count}q${RESET}${GRAY}]${RESET}`;
  }
  if (runningSubagents > 0) {
    statusStr += ` ${GRAY}[${RESET}${CYAN}🤖 ${runningSubagents} sub${RESET}${GRAY}]${RESET}`;
  }
  if (typeof data.task_count === 'number' && data.task_count > 0) {
    statusStr += ` ${GRAY}[${RESET}${CYAN}⏳ ${data.task_count} task${data.task_count > 1 ? 's' : ''}${RESET}${GRAY}]${RESET}`;
  }

  const cwd = data.cwd || process.cwd();
  const cwdShort = home && (cwd === home || cwd.startsWith(home + path.sep)) ? '~' + cwd.slice(home.length) : cwd;

  let gitStr = '';
  if (data.vcs && data.vcs.type && data.vcs.type !== 'git') {
    const label = data.vcs.branch || data.vcs.type;
    const dirtyIndicator = data.vcs.dirty === true ? `${RED}●${RESET}` : '';
    gitStr = ` ${GRAY}|${RESET} 🌿 ${BLUE}${label}${dirtyIndicator}${RESET}`;
  } else {
    const gitInfo = readGitInfoSync(cwd);
    const hasNativeBranch = typeof data.vcs?.branch === 'string' && data.vcs.branch.trim().length > 0;
    const gitBranch = hasNativeBranch ? data.vcs.branch.trim() : gitInfo?.branch || '';
    const repoDir = gitInfo?.repoDir || (gitBranch && data.workspace?.project_dir) || '';
    if (gitBranch) {
      let isDirty = false;
      if (typeof data.vcs?.dirty === 'boolean') {
        isDirty = data.vcs.dirty;
      } else if (repoDir) {
        isDirty = getGitDirtyCached(repoDir, nowMs, spawnRefresh, cacheDir);
      }
      const dirtyIndicator = isDirty ? `${RED}●${RESET}` : '';
      const skipDetachedPr = Boolean(gitInfo?.detached && !hasNativeBranch);
      const prStr = repoDir && !skipDetachedPr ? getPrBadgeCached(repoDir, gitBranch, nowMs, { spawnRefresh, cacheDir }) : '';
      gitStr = ` ${GRAY}|${RESET} 🌿 ${BLUE}${gitBranch}${dirtyIndicator}${prStr}${RESET}`;
    }
  }

  const ctx = data.context_window || {};
  const usedTokens = ctx.total_input_tokens || 0;
  const totalTokens = ctx.context_window_size || 1048576;
  const usedPctNum = typeof ctx.used_percentage === 'number' && Number.isFinite(ctx.used_percentage) ? ctx.used_percentage : 0;
  const usedPercent = usedPctNum.toFixed(1);

  let pctColor = '';
  if (usedPctNum >= 85) pctColor = RED;
  else if (data.exceeds_200k_tokens || usedPctNum >= 70) pctColor = YELLOW;
  const pctStr = pctColor ? `${pctColor}${usedPercent}%${RESET}` : `${usedPercent}%`;

  const cacheRead = ctx.current_usage?.cache_read_input_tokens || 0;
  let hitRate = usedTokens > 0 ? (cacheRead / usedTokens) * 100 : 0;
  if (hitRate > 100) hitRate = 100.0;
  const cacheHitRate = hitRate.toFixed(1);

  let cacheTtlStr = '';
  if (usedTokens > 0 && data.transcript_path) {
    if (isAgentBusy) {
      cacheTtlStr = ` ${GRAY}(${GREEN}hot${GRAY})${RESET}`;
    } else {
      try {
        let tp = data.transcript_path;
        if (!fs.existsSync(tp) && tp.includes('/.gemini/antigravity/')) {
          tp = tp.replace('/.gemini/antigravity/', '/.gemini/antigravity-cli/');
        }
        const stat = fs.statSync(tp);
        const ageSec = Math.max(0, Math.floor((nowMs - stat.mtimeMs) / 1000));
        if (ageSec < CACHE_TTL_SECONDS) {
          const remSec = CACHE_TTL_SECONDS - ageSec;
          const ttlColor = remSec > 60 ? GREEN : YELLOW;
          cacheTtlStr = ` ${GRAY}(TTL ${ttlColor}${formatDuration(remSec)}${GRAY})${RESET}`;
        } else {
          cacheTtlStr = ` ${GRAY}(cold ${formatDuration(ageSec)})${RESET}`;
        }
      } catch (_) {}
    }
  }

  const outTokens = ctx.total_output_tokens || 0;
  const quotaWithPool = formatQuotaSegment(data.model, data.quota, nowMs, width, { includePoolLabel: true });
  const quotaCompact = formatQuotaSegment(data.model, data.quota, nowMs, width, { includePoolLabel: false });
  const costStr =
    width >= 115 && data.cost && typeof data.cost.total_usd === 'number' && data.cost.total_usd > 0
      ? ` ${GRAY}|${RESET} 💵 ${data.cost.estimated ? '~' : ''}$${data.cost.total_usd.toFixed(2)}`
      : '';

  const buildBar = (barSize) => {
    const filled = Math.min(barSize, Math.max(0, Math.round((usedPctNum * barSize) / 100)));
    return `${'█'.repeat(filled)}${GRAY}${'░'.repeat(barSize - filled)}`;
  };

  const buildLine2 = (tier) => {
    const compact = tier >= 2;
    const barSize = compact ? 6 : 10;
    const ctxLabel = compact ? 'Ctx' : 'Context:';
    const outStr = !compact && outTokens > 0 ? `, Out: ${formatTokens(outTokens)}` : '';
    const tokenPart = tier >= 5 ? '' : ` (${formatTokens(usedTokens)}/${formatTokens(totalTokens)}${outStr} t)`;

    let cachePart = '';
    if (tier <= 1) {
      cachePart = ` ${GRAY}|${RESET} ⚡ Cache: ${BLUE}${cacheHitRate}%${RESET}${cacheTtlStr}`;
    } else if (tier === 2) {
      cachePart = ` ${GRAY}|${RESET} ⚡ ${BLUE}${cacheHitRate}%${RESET}${cacheTtlStr}`;
    } else if (tier === 3) {
      cachePart = ` ${GRAY}|${RESET} ⚡ ${BLUE}${cacheHitRate}%${RESET}`;
    }

    const quotaPart = tier >= 5 ? quotaCompact : quotaWithPool;
    const tierCost = tier === 0 ? costStr : '';
    return `${GRAY}└─▶${RESET} ${ctxLabel} [${BLUE}${buildBar(barSize)}${RESET}] ${pctStr}${tokenPart}${cachePart}${quotaPart}${tierCost}\x1b[K`;
  };

  const startTier = width >= 105 ? 0 : 2;
  let line2 = '';
  for (let tier = startTier; tier <= 5; tier++) {
    line2 = buildLine2(tier);
    if (displayWidth(line2) <= width) break;
  }

  const line1 = `${BLUE}🤖 ${model}${RESET}${statusStr} ${GRAY}|${RESET} 📂 ${cwdShort}${gitStr}\x1b[K`;
  return `${line1}\n${line2}`;
};

const main = () => {
  if (process.argv[2] === '--refresh-git') {
    refreshGitDirty(process.argv[3], process.argv[4]);
    return;
  }

  try {
    const input = fs.readFileSync(0, 'utf-8');
    if (!input.trim()) return;

    const data = JSON.parse(input);
    if (process.env.AGY_STATUSLINE_DEBUG === '1') {
      try {
        fs.writeFileSync(path.join(os.tmpdir(), 'telemetry_dump.json'), JSON.stringify(data, null, 2));
      } catch (_) {}
    }

    const nowMs = Date.now();
    updateCmuxStatus(data, resolveAgentState(data), nowMs);
    process.stdout.write(renderStatusLine(data, { nowMs, spawnRefresh: true }) + '\n');
  } catch (_) {}
};

if (require.main === module) {
  main();
}

module.exports = {
  displayWidth,
  formatDuration,
  formatTokens,
  resolveModelFamily,
  getResetSeconds,
  resolveQuotaSelection,
  readGitInfoSync,
  getGitDirtyCached,
  refreshGitDirty,
  updateCmuxStatus,
  getPrBadgeCached,
  renderStatusLine,
};
