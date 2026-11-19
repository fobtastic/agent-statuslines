const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  displayWidth,
  formatDuration,
  formatTokens,
  resolveModelFamily,
  getResetSeconds,
  resolveQuotaSelection,
  readGitInfoSync,
  updateCmuxStatus,
  renderStatusLine,
} = require('./statusline-blue.js');

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
const hashKey = (str) => crypto.createHash('sha1').update(str).digest('hex').slice(0, 12);

const makeBasePayload = (overrides = {}) => ({
  cwd: '/tmp/nonexistent-test-dir',
  model: {
    id: 'gemini-4-carbon-medium',
    display_name: 'Gemini 4 Carbon (Medium)',
    effort: 'medium',
  },
  agent_state: 'idle',
  context_window: {
    total_input_tokens: 50000,
    total_output_tokens: 2500,
    context_window_size: 1048576,
    used_percentage: 4.8,
    current_usage: { cache_read_input_tokens: 40000 },
  },
  terminal_width: 140,
  ...overrides,
});

const waitForFileLines = async (filePath, expectedCount, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) {
      const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
      if (lines.length >= expectedCount) return lines;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
};

test('model family quota routing for Gemini and Orchestrator', () => {
  const quota = {
    'gemini-5h': { remaining_fraction: 0.98, reset_in_seconds: 17400 },
    'gemini-weekly': { remaining_fraction: 0.84, reset_in_seconds: 406800 },
    '3p-5h': { remaining_fraction: 0.5, reset_in_seconds: 3600 },
    '3p-weekly': { remaining_fraction: 0.25, reset_in_seconds: 86400 },
  };

  const gem = resolveQuotaSelection(
    { id: 'gemini-4-carbon-medium', display_name: 'Gemini 4 Carbon (Medium)' },
    quota
  );
  assert.equal(gem.poolLabel, 'Gem');
  assert.equal(gem.q5h.key, 'gemini-5h');
  assert.equal(gem.qWk.key, 'gemini-weekly');

  const orch = resolveQuotaSelection(
    { id: 'gemini-pro-orchestrator-neon', display_name: 'Orchestrator (Neon)' },
    quota
  );
  assert.equal(orch.poolLabel, 'Gem');
  assert.equal(orch.q5h.key, 'gemini-5h');
  assert.equal(orch.qWk.key, 'gemini-weekly');
});

test('prevents sibling Gemini pool bleed and labels mixed prefixes separately', () => {
  const proModel = { id: 'gemini-4-carbon-medium', display_name: 'Gemini 4 Carbon (Medium)' };
  const bleedQuota = {
    'gemini-flash-5h': { remaining_fraction: 0.99, reset_in_seconds: 3600 },
    'gemini-pro-weekly': { remaining_fraction: 0.72, reset_in_seconds: 86400 },
  };
  const selected = resolveQuotaSelection(proModel, bleedQuota);
  assert.equal(selected.q5h, null);
  assert.equal(selected.qWk.key, 'gemini-pro-weekly');

  const mixedOut = stripAnsi(
    renderStatusLine(
      makeBasePayload({
        model: { id: 'claude-opus-5-5-high', display_name: 'Claude Opus 5.5 (High)' },
        quota: {
          'claude-5h': { remaining_fraction: 0.9, reset_in_seconds: 7200 },
          '3p-weekly': { remaining_fraction: 0.55, reset_in_seconds: 172800 },
        },
      }),
      { spawnRefresh: false }
    )
  );
  assert.match(mixedOut, /Claude 5h: 90% ↻2h · 3P Wk: 55% ↻2d/);
});

test('model family quota routing for Claude and GPT without cross-family fallback', () => {
  const shared3pQuota = {
    'gemini-5h': { remaining_fraction: 0.98, reset_in_seconds: 17400 },
    'gemini-weekly': { remaining_fraction: 0.84, reset_in_seconds: 406800 },
    '3p-5h': { remaining_fraction: 0.77, reset_in_seconds: 14400 },
    '3p-weekly': { remaining_fraction: 0.68, reset_in_seconds: 216000 },
  };

  const claude = resolveQuotaSelection(
    { id: 'claude-opus-5-5-high', display_name: 'Claude Opus 5.5 (High)' },
    shared3pQuota
  );
  assert.equal(claude.poolLabel, '3P');
  assert.equal(claude.q5h.key, '3p-5h');
  assert.equal(claude.qWk.key, '3p-weekly');

  const gpt = resolveQuotaSelection(
    { id: 'gpt-oss-120b-medium', display_name: 'GPT-OSS 120B (Medium)' },
    shared3pQuota
  );
  assert.equal(gpt.poolLabel, '3P');
  assert.equal(gpt.q5h.key, '3p-5h');
  assert.equal(gpt.qWk.key, '3p-weekly');

  const missingWeekly = resolveQuotaSelection(
    { id: 'claude-opus-5-5-high', display_name: 'Claude Opus 5.5 (High)' },
    {
      'gemini-5h': { remaining_fraction: 0.98, reset_in_seconds: 17400 },
      'gemini-weekly': { remaining_fraction: 0.84, reset_in_seconds: 406800 },
      '3p-5h': { remaining_fraction: 0.77, reset_in_seconds: 14400 },
    }
  );
  assert.equal(missingWeekly.q5h.key, '3p-5h');
  assert.equal(missingWeekly.qWk, null);

  const dedicatedOverrides = resolveQuotaSelection(
    { id: 'claude-opus-5-5-high', display_name: 'Claude Opus 5.5 (High)' },
    {
      ...shared3pQuota,
      'claude-5h': { remaining_fraction: 0.91, reset_in_seconds: 7200 },
      'claude-weekly': { remaining_fraction: 0.62, reset_in_seconds: 172800 },
    }
  );
  assert.equal(dedicatedOverrides.poolLabel, 'Claude');
  assert.equal(dedicatedOverrides.q5h.key, 'claude-5h');
  assert.equal(dedicatedOverrides.qWk.key, 'claude-weekly');

  const dedicatedGpt = resolveQuotaSelection(
    { id: 'gpt-oss-120b-medium', display_name: 'GPT-OSS 120B (Medium)' },
    {
      ...shared3pQuota,
      'gpt-5h': { remaining_fraction: 0.55, reset_in_seconds: 3600 },
      'gpt-7d': { remaining_fraction: 0.4, reset_in_seconds: 86400 },
    }
  );
  assert.equal(dedicatedGpt.poolLabel, 'GPT');
  assert.equal(dedicatedGpt.q5h.key, 'gpt-5h');
  assert.equal(dedicatedGpt.qWk.key, 'gpt-7d');
});

test('reset_time ISO fallback, disabled buckets, and credits gating below 120 columns', () => {
  const nowMs = Date.parse('2026-11-19T03:00:00Z');
  assert.equal(getResetSeconds({ reset_in_seconds: 0, reset_time: '2026-11-19T08:13:58Z' }, nowMs), 18838);
  assert.equal(getResetSeconds({ reset_time: '2026-11-19T04:00:00Z' }, nowMs), 3600);
  assert.equal(getResetSeconds({ reset_time: '2026-11-19T02:00:00Z' }, nowMs), 0);

  const lowQuotaOut = stripAnsi(
    renderStatusLine(
      makeBasePayload({
        terminal_width: 100,
        model: { id: 'claude-opus-5-5-high', display_name: 'Claude Opus 5.5 (High)' },
        quota: {
          '3p-5h': { remaining_fraction: 0.15, reset_in_seconds: 0, reset_time: '2026-11-19T08:13:58Z' },
          '3p-weekly': { remaining_fraction: 0.8, reset_in_seconds: 1000, disabled: true },
          'g1-credits': { remaining_amount: 450 },
        },
      }),
      { nowMs, spawnRefresh: false }
    )
  );
  assert.match(lowQuotaOut, /🔋 3P 5h: 15% ↻5h13m · 💳 450/);
  assert.doesNotMatch(lowQuotaOut, /Wk:/);

  const healthyQuotaOut = stripAnsi(
    renderStatusLine(
      makeBasePayload({
        terminal_width: 100,
        model: { id: 'claude-opus-5-5-high', display_name: 'Claude Opus 5.5 (High)' },
        quota: {
          '3p-5h': { remaining_fraction: 0.8, reset_in_seconds: 3600 },
          'g1-credits': { remaining_amount: 450 },
        },
      }),
      { nowMs, spawnRefresh: false }
    )
  );
  assert.doesNotMatch(healthyQuotaOut, /💳/);
});

test('extended agent states, optional Line 1 badges, cost, and exceeds_200k_tokens', () => {
  for (const [state, expected] of [
    ['reviewing', '👀 Reviewing'],
    ['initializing', '🚀 Init'],
    ['authenticating', '🔑 Auth'],
    ['error', '❌ Error'],
  ]) {
    const text = stripAnsi(
      renderStatusLine(makeBasePayload({ agent_state: state }), { spawnRefresh: false })
    );
    assert.ok(text.includes(expected), `expected ${expected} for ${state}`);
  }

  const out = renderStatusLine(
    makeBasePayload({
      agent_state: 'working',
      cycle_mode: 'plan',
      vim: { mode: 'NORMAL' },
      agent: { name: 'reviewer' },
      pending_input_count: 2,
      subagents: [{ name: 's1', status: 'running' }, { name: 's2', status: 'completed' }],
      task_count: 3,
      exceeds_200k_tokens: true,
      cost: { total_usd: 1.254, estimated: true },
    }),
    { spawnRefresh: false }
  );
  const plain = stripAnsi(out);
  assert.match(plain, /\[📋 Plan\]/);
  assert.match(plain, /\[NORMAL\]/);
  assert.match(plain, /\[@reviewer\]/);
  assert.match(plain, /\[📥 2q\]/);
  assert.match(plain, /\[🤖 1 sub\]/);
  assert.match(plain, /\[⏳ 3 tasks\]/);
  assert.match(plain, /💵 ~\$1\.25/);
  assert.ok(out.includes('\x1b[1;33m4.8%\x1b[0m'), 'exceeds_200k_tokens highlights pct in yellow');
});

test('narrow widths fit displayWidth with idle transcript_path TTL and keep 5h and Wk timers', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-sl-ttl-'));
  try {
    const transcript = path.join(root, 'transcript.jsonl');
    fs.writeFileSync(transcript, '{}\n');
    const stat = fs.statSync(transcript);
    const nowMs = Math.floor(stat.mtimeMs) + 48 * 1000;

    for (const width of [88, 80]) {
      const raw = renderStatusLine(
        makeBasePayload({
          terminal_width: width,
          transcript_path: transcript,
          model: { id: 'gemini-4-carbon-medium', display_name: 'Gemini 4 Carbon (Medium)' },
          context_window: {
            total_input_tokens: 475100,
            total_output_tokens: 2500,
            context_window_size: 1048576,
            used_percentage: 45.3,
            current_usage: { cache_read_input_tokens: 438992 },
          },
          cost: { total_usd: 2.5, estimated: false },
          quota: {
            'gemini-pro-5h': { remaining_fraction: 0.92, reset_in_seconds: 12000 },
            'gemini-pro-weekly': { remaining_fraction: 0.64, reset_in_seconds: 601200 },
          },
        }),
        { nowMs, spawnRefresh: false }
      );
      const line2 = raw.split('\n')[1];
      const line2Plain = stripAnsi(line2);
      const line2Cols = displayWidth(line2);
      assert.ok(line2Plain.includes('5h: 92% ↻3h20m'), `missing 5h timer at width ${width}: ${line2Plain}`);
      assert.ok(line2Plain.includes('Wk: 64% ↻6d23h'), `missing Wk timer at width ${width}: ${line2Plain}`);
      assert.ok(line2Cols <= width, `width ${width}: expected <= ${width} cols, got ${line2Cols}: ${line2Plain}`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readGitInfoSync handles repo, worktree, detached HEAD PR skip, and reftable stubs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-sl-git-'));
  const cacheDir = path.join(root, 'cache');
  try {
    const repoA = path.join(root, 'repo-a');
    const nested = path.join(repoA, 'src', 'nested');
    fs.mkdirSync(path.join(repoA, '.git'), { recursive: true });
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(repoA, '.git', 'HEAD'), 'ref: refs/heads/feat/statusline\n');
    assert.deepEqual(readGitInfoSync(nested), { repoDir: repoA, branch: 'feat/statusline', detached: false });

    const worktree = path.join(root, 'wt-b');
    const wtGitDir = path.join(repoA, '.git', 'worktrees', 'wt-b');
    fs.mkdirSync(wtGitDir, { recursive: true });
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(path.join(wtGitDir, 'HEAD'), 'ref: refs/heads/main\n');
    fs.writeFileSync(path.join(worktree, '.git'), 'gitdir: ../repo-a/.git/worktrees/wt-b\n');
    assert.deepEqual(readGitInfoSync(worktree), { repoDir: worktree, branch: 'main', detached: false });

    // Detached HEAD skips PR lookup even when a PR cache entry exists for the short SHA
    const repoC = path.join(root, 'repo-c');
    fs.mkdirSync(path.join(repoC, '.git'), { recursive: true });
    fs.writeFileSync(path.join(repoC, '.git', 'HEAD'), '123456789abcdef0123456789abcdef012345678\n');
    assert.deepEqual(readGitInfoSync(repoC), { repoDir: repoC, branch: '1234567', detached: true });

    const prDir = path.join(cacheDir, 'pr');
    fs.mkdirSync(prDir, { recursive: true });
    fs.writeFileSync(
      path.join(prDir, `${hashKey(`${repoC}:1234567`)}.json`),
      JSON.stringify({ number: 1234567, state: 'OPEN', updatedAt: Date.now() })
    );
    const detachedOut = stripAnsi(renderStatusLine(makeBasePayload({ cwd: repoC }), { spawnRefresh: false, cacheDir }));
    assert.match(detachedOut, /🌿 1234567/);
    assert.doesNotMatch(detachedOut, /PR #1234567/);

    // Reftable stub `.invalid`
    const repoD = path.join(root, 'repo-d');
    fs.mkdirSync(path.join(repoD, '.git'), { recursive: true });
    fs.writeFileSync(path.join(repoD, '.git', 'HEAD'), 'ref: refs/heads/.invalid\n');
    assert.deepEqual(readGitInfoSync(repoD), { repoDir: repoD, branch: '', detached: false });

    const reftableNoVcs = stripAnsi(
      renderStatusLine(makeBasePayload({ cwd: repoD }), { spawnRefresh: false, cacheDir })
    );
    assert.doesNotMatch(reftableNoVcs, /\.invalid/);
    assert.doesNotMatch(reftableNoVcs, /🌿/);

    const reftableWithVcs = stripAnsi(
      renderStatusLine(makeBasePayload({ cwd: repoD, vcs: { type: 'git', branch: 'main', dirty: false } }), {
        spawnRefresh: false,
        cacheDir,
      })
    );
    assert.match(reftableWithVcs, /🌿 main/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('--refresh-git writes dirty cache end-to-end and renderStatusLine reads pre-seeded cache without spawning', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-sl-refresh-'));
  try {
    const repo = path.join(root, 'repo');
    const cacheDir = path.join(root, 'cache');
    fs.mkdirSync(repo, { recursive: true });
    fs.mkdirSync(cacheDir, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo, stdio: 'ignore' });
    fs.writeFileSync(path.join(repo, 'a.txt'), 'clean\n');
    execFileSync('git', ['add', 'a.txt'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init', '--no-gpg-sign'], { cwd: repo, stdio: 'ignore' });

    const cachePath = path.join(cacheDir, `git-${hashKey(repo)}.json`);
    const scriptPath = path.join(__dirname, 'statusline-blue.js');

    execFileSync(process.execPath, [scriptPath, '--refresh-git', repo, cachePath], { stdio: 'ignore' });
    const cleanEntry = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    assert.equal(cleanEntry.dirty, false);

    const cleanRender = stripAnsi(
      renderStatusLine(makeBasePayload({ cwd: repo }), { nowMs: cleanEntry.updatedAt + 1000, spawnRefresh: false, cacheDir })
    );
    assert.match(cleanRender, /🌿 main/);
    assert.doesNotMatch(cleanRender, /●/);

    fs.writeFileSync(path.join(repo, 'a.txt'), 'modified\n');
    execFileSync(process.execPath, [scriptPath, '--refresh-git', repo, cachePath], { stdio: 'ignore' });
    const dirtyEntry = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    assert.equal(dirtyEntry.dirty, true);

    const dirtyRender = stripAnsi(
      renderStatusLine(makeBasePayload({ cwd: repo }), { nowMs: dirtyEntry.updatedAt + 1000, spawnRefresh: false, cacheDir })
    );
    assert.match(dirtyRender, /🌿 main●/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('per-key PR cache files for two branches coexist without overwriting each other', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-sl-pr-'));
  try {
    const repo = path.join(root, 'repo');
    const prCacheDir = path.join(root, 'cache', 'pr');
    fs.mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' });

    const updater = path.join(__dirname, 'update_pr_cache.js');
    execFileSync(process.execPath, [updater, repo, 'main', prCacheDir], { stdio: 'ignore' });
    execFileSync(process.execPath, [updater, repo, 'feat/other', prCacheDir], { stdio: 'ignore' });

    const mainFile = path.join(prCacheDir, `${hashKey(`${repo}:main`)}.json`);
    const featFile = path.join(prCacheDir, `${hashKey(`${repo}:feat/other`)}.json`);
    assert.equal(fs.existsSync(mainFile), true);
    assert.equal(fs.existsSync(featFile), true);
    assert.equal(JSON.parse(fs.readFileSync(mainFile, 'utf8')).key, `${repo}:main`);
    assert.equal(JSON.parse(fs.readFileSync(featFile, 'utf8')).key, `${repo}:feat/other`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('updateCmuxStatus deduplicates identical calls within 60s and fires on state change', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-sl-cmux-'));
  try {
    const cacheDir = path.join(root, 'cache');
    const logFile = path.join(root, 'cmux.log');
    const mockCmux = path.join(root, 'mock-cmux.js');
    fs.writeFileSync(
      mockCmux,
      `#!/usr/bin/env node\nconst fs = require('fs');\nfs.appendFileSync(${JSON.stringify(logFile)}, process.argv.slice(2).join(' ') + '\\n');\n`,
      { mode: 0o755 }
    );

    const payload = { conversation_id: 'conv-1' };
    const working = { cmuxValue: 'Working', cmuxIcon: 'gearshape.fill', cmuxColor: '#4C8DFF' };
    const idle = { cmuxValue: 'Idle', cmuxIcon: 'pause.circle.fill', cmuxColor: '#8E8E93' };
    const t0 = 1_700_000_000_000;

    updateCmuxStatus(payload, working, t0, { hasCmux: true, cmuxCli: mockCmux, cacheDir });
    updateCmuxStatus(payload, working, t0 + 1000, { hasCmux: true, cmuxCli: mockCmux, cacheDir });
    const afterDedupe = await waitForFileLines(logFile, 1);
    assert.equal(afterDedupe.length, 1);

    updateCmuxStatus(payload, idle, t0 + 2000, { hasCmux: true, cmuxCli: mockCmux, cacheDir });
    const afterChange = await waitForFileLines(logFile, 2);
    assert.equal(afterChange.length, 2);
    assert.match(afterChange[0], /set-status agy Working/);
    assert.match(afterChange[1], /set-status agy Idle/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('native vcs.branch/vcs.dirty and non-git vcs.type', () => {
  const gitNative = stripAnsi(
    renderStatusLine(
      makeBasePayload({ vcs: { type: 'git', branch: 'fix/quota', dirty: true } }),
      { spawnRefresh: false }
    )
  );
  assert.match(gitNative, /🌿 fix\/quota●/);

  const jjNative = stripAnsi(
    renderStatusLine(
      makeBasePayload({ vcs: { type: 'jj', branch: 'main@123', dirty: false } }),
      { spawnRefresh: false }
    )
  );
  assert.match(jjNative, /🌿 main@123/);
  assert.doesNotMatch(jjNative, /●/);
});

test('formatDuration, formatTokens, and displayWidth edge cases', () => {
  assert.equal(formatDuration(0), 'now');
  assert.equal(formatDuration(45), '45s');
  assert.equal(formatDuration(315), '5m15s');
  assert.equal(formatDuration(17400), '4h50m');
  assert.equal(formatDuration(172800), '2d');
  assert.equal(formatTokens(950), 950);
  assert.equal(formatTokens(12500), '12.5k');
  assert.equal(formatTokens(1000000), '1M');
  assert.equal(resolveModelFamily(null).family, '3p');
  assert.equal(displayWidth('\x1b[1;34m⚡ 92%\x1b[0m'), 6);
  assert.equal(displayWidth('⚙️'), 2);
});
