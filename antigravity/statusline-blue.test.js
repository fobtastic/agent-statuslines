const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  formatDuration,
  formatTokens,
  resolveModelFamily,
  getResetSeconds,
  resolveQuotaSelection,
  readGitInfoSync,
  renderStatusLine,
} = require('./statusline-blue.js');

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

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

test('reset_time ISO fallback, disabled buckets, and remaining_amount credits', () => {
  const nowMs = Date.parse('2026-11-19T03:00:00Z');
  assert.equal(getResetSeconds({ reset_in_seconds: 0, reset_time: '2026-11-19T08:13:58Z' }, nowMs), 18838);
  assert.equal(getResetSeconds({ reset_time: '2026-11-19T04:00:00Z' }, nowMs), 3600);
  assert.equal(getResetSeconds({ reset_time: '2026-11-19T02:00:00Z' }, nowMs), 0);

  const out = stripAnsi(
    renderStatusLine(
      makeBasePayload({
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
  assert.match(out, /🔋 3P 5h: 15% ↻5h13m · 💳 450/);
  assert.doesNotMatch(out, /Wk:/);
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

test('narrow terminal_width keeps Line 2 compact and preserves 5h and Wk timers', () => {
  const out = stripAnsi(
    renderStatusLine(
      makeBasePayload({
        terminal_width: 88,
        cost: { total_usd: 2.5, estimated: false },
        quota: {
          'gemini-5h': { remaining_fraction: 0.92, reset_in_seconds: 12000 },
          'gemini-weekly': { remaining_fraction: 0.64, reset_in_seconds: 172800 },
        },
      }),
      { spawnRefresh: false }
    )
  );
  const line2 = out.split('\n')[1];
  assert.ok(line2.includes('Ctx ['));
  assert.ok(line2.includes('⚡ 80.0%'));
  assert.ok(!line2.includes('Out:'));
  assert.ok(!line2.includes('💵'));
  assert.ok(line2.includes('5h: 92% ↻3h20m'));
  assert.ok(line2.includes('Wk: 64% ↻2d'));
  assert.ok(line2.length <= 88, `expected Line 2 length <= 88, got ${line2.length}: ${line2}`);
});

test('readGitInfoSync handles standard repo, worktree .git file, and detached HEAD', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-sl-git-'));
  try {
    // 1. Standard .git directory + nested subdir
    const repoA = path.join(root, 'repo-a');
    const nested = path.join(repoA, 'src', 'nested');
    fs.mkdirSync(path.join(repoA, '.git'), { recursive: true });
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(repoA, '.git', 'HEAD'), 'ref: refs/heads/feat/statusline\n');
    assert.deepEqual(readGitInfoSync(nested), { repoDir: repoA, branch: 'feat/statusline' });

    // 2. Worktree .git file pointing to relative gitdir
    const worktree = path.join(root, 'wt-b');
    const wtGitDir = path.join(repoA, '.git', 'worktrees', 'wt-b');
    fs.mkdirSync(wtGitDir, { recursive: true });
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(path.join(wtGitDir, 'HEAD'), 'ref: refs/heads/main\n');
    fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ../repo-a/.git/worktrees/wt-b\n`);
    assert.deepEqual(readGitInfoSync(worktree), { repoDir: worktree, branch: 'main' });

    // 3. Detached HEAD
    const repoC = path.join(root, 'repo-c');
    fs.mkdirSync(path.join(repoC, '.git'), { recursive: true });
    fs.writeFileSync(path.join(repoC, '.git', 'HEAD'), '0123456789abcdef0123456789abcdef01234567\n');
    assert.deepEqual(readGitInfoSync(repoC), { repoDir: repoC, branch: '0123456' });
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

test('formatDuration and formatTokens edge cases', () => {
  assert.equal(formatDuration(0), 'now');
  assert.equal(formatDuration(45), '45s');
  assert.equal(formatDuration(315), '5m15s');
  assert.equal(formatDuration(17400), '4h50m');
  assert.equal(formatDuration(172800), '2d');
  assert.equal(formatTokens(950), 950);
  assert.equal(formatTokens(12500), '12.5k');
  assert.equal(formatTokens(1000000), '1M');
  assert.equal(resolveModelFamily(null).family, '3p');
});
