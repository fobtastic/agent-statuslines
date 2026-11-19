const test = require('node:test');
const assert = require('node:assert/strict');
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

const waitFor = async (fn, timeoutMs = 2500) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = fn();
    if (res) return res;
    await new Promise((r) => setTimeout(r, 25));
  }
  return fn();
};

const makeStubBin = (root, scripts) => {
  const binDir = path.join(root, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  for (const [name, content] of Object.entries(scripts)) {
    fs.writeFileSync(path.join(binDir, name), content, { mode: 0o755 });
  }
  return binDir;
};

const withPatchedEnv = async (patch, fn) => {
  const saved = new Map();
  for (const [k, v] of Object.entries(patch)) {
    saved.set(k, Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined);
    if (v === undefined || v === null) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  try {
    return await fn();
  } finally {
    for (const [k, prev] of saved.entries()) {
      if (prev === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = prev;
      }
    }
  }
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

  // Generic Gemini / Gemma models must not bleed into Flash/Pro sub-pools
  for (const genericModel of [
    { id: 'gemma-4-27b-it', display_name: 'Gemma 4 27B' },
    { id: 'antigravity', display_name: 'Antigravity' },
  ]) {
    const dashBleed = resolveQuotaSelection(genericModel, bleedQuota);
    assert.equal(dashBleed.q5h, null);
    assert.equal(dashBleed.qWk, null);

    const underscoreBleed = resolveQuotaSelection(genericModel, {
      gemini_flash_5h: { remaining_fraction: 0.99, reset_in_seconds: 3600 },
      gemini_pro_weekly: { remaining_fraction: 0.72, reset_in_seconds: 86400 },
    });
    assert.equal(underscoreBleed.q5h, null);
    assert.equal(underscoreBleed.qWk, null);

    const sharedGem = resolveQuotaSelection(genericModel, {
      'gemini-5h': { remaining_fraction: 0.88, reset_in_seconds: 3600 },
      'gemini-weekly': { remaining_fraction: 0.61, reset_in_seconds: 86400 },
    });
    assert.equal(sharedGem.poolLabel, 'Gem');
    assert.equal(sharedGem.q5h.key, 'gemini-5h');
    assert.equal(sharedGem.qWk.key, 'gemini-weekly');
  }

  // Per-window labels distinguish Flash 5h from generic Gem Wk
  const mixedGemOut = stripAnsi(
    renderStatusLine(
      makeBasePayload({
        model: { id: 'gemini-3-flash', display_name: 'Gemini 3 Flash' },
        quota: {
          'gemini-flash-5h': { remaining_fraction: 0.99, reset_in_seconds: 3600 },
          'gemini-weekly': { remaining_fraction: 0.72, reset_in_seconds: 86400 },
        },
      }),
      { spawnRefresh: false }
    )
  );
  assert.match(mixedGemOut, /Flash 5h: 99% ↻1h · Gem Wk: 72% ↻1d/);

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

test('model family quota routing for Claude, GPT, and id-only hints without cross-family fallback', () => {
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

  // model.id alone picks family even when display_name is generic
  const idOnlyClaude = { id: 'claude-opus-5-5-high', display_name: 'Custom Model' };
  assert.equal(resolveModelFamily(idOnlyClaude).family, 'claude');
  const idOnlyClaudeQuota = resolveQuotaSelection(idOnlyClaude, {
    ...shared3pQuota,
    'claude-5h': { remaining_fraction: 0.91, reset_in_seconds: 7200 },
    'claude-weekly': { remaining_fraction: 0.62, reset_in_seconds: 172800 },
  });
  assert.equal(idOnlyClaudeQuota.poolLabel, 'Claude');
  assert.equal(idOnlyClaudeQuota.q5h.key, 'claude-5h');

  const idOnlyFlash = { id: 'gemini-2-flash', display_name: 'Fast Model' };
  assert.equal(resolveModelFamily(idOnlyFlash).prefixes[0], 'gemini-flash');
  const idOnlyFlashQuota = resolveQuotaSelection(idOnlyFlash, {
    'gemini-flash-5h': { remaining_fraction: 0.95, reset_in_seconds: 3600 },
    'gemini-pro-weekly': { remaining_fraction: 0.7, reset_in_seconds: 86400 },
  });
  assert.equal(idOnlyFlashQuota.poolLabel, 'Flash');
  assert.equal(idOnlyFlashQuota.q5h.key, 'gemini-flash-5h');
  assert.equal(idOnlyFlashQuota.qWk, null);

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

test('extended agent states, optional Line 1 badges, cost threshold, and exceeds_200k_tokens', () => {
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

  const belowCostWidth = stripAnsi(
    renderStatusLine(
      makeBasePayload({
        terminal_width: 110,
        cost: { total_usd: 1.254, estimated: true },
      }),
      { spawnRefresh: false }
    )
  );
  assert.doesNotMatch(belowCostWidth, /💵/);
});

test('narrow width tiering matches exact expected Line 2 strings and column counts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-sl-ttl-'));
  try {
    const transcript = path.join(root, 'transcript.jsonl');
    fs.writeFileSync(transcript, '{}\n');
    const stat = fs.statSync(transcript);
    const nowMs = Math.ceil(stat.mtimeMs) + 48 * 1000;

    const makeNarrowPayload = (width) =>
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
      });

    const line2At110 = stripAnsi(
      renderStatusLine(makeNarrowPayload(110), { nowMs, spawnRefresh: false }).split('\n')[1]
    );
    assert.equal(
      line2At110,
      '└─▶ Ctx [███░░░] 45.3% (475.1k/1M t) | ⚡ 92.4% (TTL 4m12s) | 🔋 Pro 5h: 92% ↻3h20m · Wk: 64% ↻6d23h'
    );
    assert.equal(displayWidth(line2At110), 100);

    const raw88 = renderStatusLine(makeNarrowPayload(88), { nowMs, spawnRefresh: false }).split('\n')[1];
    assert.equal(
      stripAnsi(raw88),
      '└─▶ Ctx [███░░░] 45.3% (475.1k/1M t) | ⚡ 92.4% | 🔋 Pro 5h: 92% ↻3h20m · Wk: 64% ↻6d23h'
    );
    assert.equal(displayWidth(raw88), 88);

    const raw80 = renderStatusLine(makeNarrowPayload(80), { nowMs, spawnRefresh: false }).split('\n')[1];
    assert.equal(
      stripAnsi(raw80),
      '└─▶ Ctx [███░░░] 45.3% (475.1k/1M t) | 🔋 Pro 5h: 92% ↻3h20m · Wk: 64% ↻6d23h'
    );
    assert.equal(displayWidth(raw80), 77);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readGitInfoSync handles repo, worktree, detached HEAD, and reftable stubs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-sl-git-'));
  const cacheDir = path.join(root, 'cache');
  try {
    const repoA = path.join(root, 'repo-a');
    const nested = path.join(repoA, 'src', 'nested');
    fs.mkdirSync(path.join(repoA, '.git'), { recursive: true });
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(repoA, '.git', 'HEAD'), 'ref: refs/heads/feat/statusline\n');
    assert.deepEqual(readGitInfoSync(nested), {
      repoDir: repoA,
      branch: 'feat/statusline',
      detached: false,
      isReftable: false,
    });

    const worktree = path.join(root, 'wt-b');
    const wtGitDir = path.join(repoA, '.git', 'worktrees', 'wt-b');
    fs.mkdirSync(wtGitDir, { recursive: true });
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(path.join(wtGitDir, 'HEAD'), 'ref: refs/heads/main\n');
    fs.writeFileSync(path.join(worktree, '.git'), 'gitdir: ../repo-a/.git/worktrees/wt-b\n');
    assert.deepEqual(readGitInfoSync(worktree), {
      repoDir: worktree,
      branch: 'main',
      detached: false,
      isReftable: false,
    });

    const repoC = path.join(root, 'repo-c');
    fs.mkdirSync(path.join(repoC, '.git'), { recursive: true });
    fs.writeFileSync(path.join(repoC, '.git', 'HEAD'), '123456789abcdef0123456789abcdef012345678\n');
    assert.deepEqual(readGitInfoSync(repoC), {
      repoDir: repoC,
      branch: '1234567',
      detached: true,
      isReftable: false,
    });

    const repoD = path.join(root, 'repo-d');
    fs.mkdirSync(path.join(repoD, '.git'), { recursive: true });
    fs.writeFileSync(path.join(repoD, '.git', 'HEAD'), 'ref: refs/heads/.invalid\n');
    assert.deepEqual(readGitInfoSync(repoD), {
      repoDir: repoD,
      branch: '',
      detached: false,
      isReftable: true,
    });

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

test('--refresh-git avoids sync git forks on render and resolves reftable branch and detached HEAD', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-sl-reftable-'));
  try {
    const cacheDir = path.join(root, 'cache');
    const prCacheDir = path.join(cacheDir, 'pr');
    const gitLog = path.join(root, 'git.log');
    const repoNormal = path.join(root, 'repo-normal');
    const repoBranch = path.join(root, 'repo-branch');
    const repoDetached = path.join(root, 'repo-detached');
    for (const r of [repoNormal, repoBranch, repoDetached]) {
      fs.mkdirSync(path.join(r, '.git'), { recursive: true });
    }
    fs.writeFileSync(path.join(repoNormal, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    fs.writeFileSync(path.join(repoBranch, '.git', 'HEAD'), 'ref: refs/heads/.invalid\n');
    fs.writeFileSync(path.join(repoDetached, '.git', 'HEAD'), 'ref: refs/heads/.invalid\n');

    const binDir = makeStubBin(root, {
      git: `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
fs.appendFileSync(${JSON.stringify(gitLog)}, process.argv.slice(2).join(' ') + '\\n');
const args = process.argv.slice(2);
if (args[0] === '--no-optional-locks') args.shift();
const base = path.basename(process.cwd());
if (args[0] === 'status') {
  if (base === 'repo-branch') process.stdout.write(' M a.txt\\n');
  process.exit(0);
}
if (args[0] === 'symbolic-ref') {
  if (base === 'repo-branch') {
    process.stdout.write('feat/reftable\\n');
    process.exit(0);
  }
  process.exit(1);
}
if (args[0] === 'rev-parse' && args[1] === '--short') {
  process.stdout.write('abc1234\\n');
  process.exit(0);
}
process.exit(1);
`,
      gh: `#!/usr/bin/env node\nprocess.exit(1);\n`,
    });

    await withPatchedEnv(
      { PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`, GH_REPO: undefined },
      async () => {
        const readCacheForRepo = (repoPath, expectDetached) => {
          if (!fs.existsSync(cacheDir)) return null;
          for (const f of fs.readdirSync(cacheDir)) {
            if (!f.startsWith('git-') || !f.endsWith('.json')) continue;
            const data = JSON.parse(fs.readFileSync(path.join(cacheDir, f), 'utf8'));
            if (
              data.repoDir === repoPath &&
              data.updatedAt > 0 &&
              data.refreshingAt === undefined &&
              Boolean(data.detached) === expectDetached
            ) {
              return data;
            }
          }
          return null;
        };

        const normalCold = stripAnsi(
          renderStatusLine(makeBasePayload({ cwd: repoNormal }), { nowMs: Date.now(), spawnRefresh: false, cacheDir })
        );
        assert.match(normalCold, /🌿 main/);
        assert.doesNotMatch(normalCold, /●/);
        assert.equal(fs.existsSync(gitLog), false);

        const reftableCold = stripAnsi(
          renderStatusLine(makeBasePayload({ cwd: repoBranch }), { nowMs: Date.now(), spawnRefresh: false, cacheDir })
        );
        assert.doesNotMatch(reftableCold, /\.invalid/);
        assert.doesNotMatch(reftableCold, /🌿/);
        assert.equal(fs.existsSync(gitLog), false);

        // Positive control: spawnRefresh: true triggers background --refresh-git (logged by stub git)
        renderStatusLine(makeBasePayload({ cwd: repoNormal }), { nowMs: Date.now(), spawnRefresh: true, cacheDir });
        await waitFor(() => readCacheForRepo(repoNormal, false));
        await waitFor(() => {
          if (!fs.existsSync(prCacheDir)) return false;
          return fs
            .readdirSync(prCacheDir)
            .filter((f) => f.endsWith('.json'))
            .some((f) => {
              const e = JSON.parse(fs.readFileSync(path.join(prCacheDir, f), 'utf8'));
              return e.key === `${repoNormal}:main` && e.updatedAt > 0 && e.fetchingAt === undefined;
            });
        });
        assert.match(fs.readFileSync(gitLog, 'utf8'), /status --porcelain -uno/);

        renderStatusLine(makeBasePayload({ cwd: repoBranch }), { nowMs: Date.now(), spawnRefresh: true, cacheDir });
        const branchEntry = await waitFor(() => readCacheForRepo(repoBranch, false));
        assert.equal(branchEntry.branch, 'feat/reftable');
        assert.equal(branchEntry.dirty, true);

        const warmBranch = stripAnsi(
          renderStatusLine(makeBasePayload({ cwd: repoBranch }), {
            nowMs: branchEntry.updatedAt + 1000,
            spawnRefresh: false,
            cacheDir,
          })
        );
        assert.match(warmBranch, /🌿 feat\/reftable●/);

        renderStatusLine(makeBasePayload({ cwd: repoDetached }), { nowMs: Date.now(), spawnRefresh: true, cacheDir });
        const detachedEntry = await waitFor(() => readCacheForRepo(repoDetached, true));
        assert.equal(detachedEntry.branch, 'abc1234');
        assert.equal(detachedEntry.detached, true);

        const warmDetached = stripAnsi(
          renderStatusLine(makeBasePayload({ cwd: repoDetached }), {
            nowMs: detachedEntry.updatedAt + 1000,
            spawnRefresh: false,
            cacheDir,
          })
        );
        assert.match(warmDetached, /🌿 abc1234/);
        assert.doesNotMatch(warmDetached, /PR #/);
      }
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('renderStatusLine spawns --refresh-git to populate clean and dirty cache transitions', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-sl-refresh-'));
  try {
    const repo = path.join(root, 'repo');
    const cacheDir = path.join(root, 'cache');
    fs.mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo, stdio: 'ignore' });
    fs.writeFileSync(path.join(repo, 'a.txt'), 'clean\n');
    execFileSync('git', ['add', 'a.txt'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init', '--no-gpg-sign'], { cwd: repo, stdio: 'ignore' });

    const readCompletedGitCache = () => {
      if (!fs.existsSync(cacheDir)) return null;
      const files = fs.readdirSync(cacheDir).filter((f) => f.startsWith('git-') && f.endsWith('.json'));
      if (files.length !== 1) return null;
      const parsed = JSON.parse(fs.readFileSync(path.join(cacheDir, files[0]), 'utf8'));
      return parsed.updatedAt > 0 && parsed.refreshingAt === undefined ? parsed : null;
    };

    renderStatusLine(makeBasePayload({ cwd: repo }), { nowMs: Date.now(), spawnRefresh: true, cacheDir });
    const cleanEntry = await waitFor(readCompletedGitCache);
    assert.equal(cleanEntry.dirty, false);

    const cleanRender = stripAnsi(
      renderStatusLine(makeBasePayload({ cwd: repo }), {
        nowMs: cleanEntry.updatedAt + 1000,
        spawnRefresh: false,
        cacheDir,
      })
    );
    assert.match(cleanRender, /🌿 main/);
    assert.doesNotMatch(cleanRender, /●/);

    fs.writeFileSync(path.join(repo, 'a.txt'), 'modified\n');
    renderStatusLine(makeBasePayload({ cwd: repo }), {
      nowMs: cleanEntry.updatedAt + 6000,
      spawnRefresh: true,
      cacheDir,
    });
    const dirtyEntry = await waitFor(() => {
      const e = readCompletedGitCache();
      return e && e.dirty === true ? e : null;
    });
    assert.equal(dirtyEntry.dirty, true);

    const dirtyRender = stripAnsi(
      renderStatusLine(makeBasePayload({ cwd: repo }), {
        nowMs: dirtyEntry.updatedAt + 1000,
        spawnRefresh: false,
        cacheDir,
      })
    );
    assert.match(dirtyRender, /🌿 main●/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('PR cache writer/reader agreement, detached-HEAD control, and 7-day cache pruning', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-sl-pr-'));
  try {
    const repo = path.join(root, 'repo');
    const cacheDir = path.join(root, 'cache');
    const prCacheDir = path.join(cacheDir, 'pr');
    fs.mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '-b', 'feat/pr-ok'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo, stdio: 'ignore' });
    fs.writeFileSync(path.join(repo, 'a.txt'), 'ok\n');
    execFileSync('git', ['add', 'a.txt'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init', '--no-gpg-sign'], { cwd: repo, stdio: 'ignore' });

    const binDir = makeStubBin(root, {
      gh: `#!/usr/bin/env node
const branch = process.argv[4];
const payloads = {
  'feat/pr-ok': {
    number: 42,
    state: 'OPEN',
    title: 'OK',
    url: 'https://example.test/42',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    statusCheckRollup: [{ state: 'SUCCESS', status: 'COMPLETED' }],
  },
  'feat/other': {
    number: 99,
    state: 'OPEN',
    title: 'Conflict',
    url: 'https://example.test/99',
    mergeable: 'CONFLICTING',
    mergeStateStatus: 'DIRTY',
    statusCheckRollup: [{ state: 'SUCCESS', status: 'COMPLETED' }],
  },
  '1234567': {
    number: 1234567,
    state: 'OPEN',
    title: 'Detached control',
    url: 'https://example.test/1234567',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    statusCheckRollup: [{ state: 'SUCCESS', status: 'COMPLETED' }],
  },
};
if (!payloads[branch]) process.exit(1);
process.stdout.write(JSON.stringify(payloads[branch]));
`,
    });

    const updater = path.join(__dirname, 'update_pr_cache.js');
    const headPath = path.join(repo, '.git', 'HEAD');

    await withPatchedEnv(
      { PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`, GH_REPO: undefined },
      async () => {
        const readPrEntries = () => {
          if (!fs.existsSync(prCacheDir)) return [];
          return fs
            .readdirSync(prCacheDir)
            .filter((f) => f.endsWith('.json'))
            .map((f) => JSON.parse(fs.readFileSync(path.join(prCacheDir, f), 'utf8')))
            .filter((e) => e.updatedAt > 0 && e.fetchingAt === undefined);
        };

        const readGitReady = () => {
          if (!fs.existsSync(cacheDir)) return false;
          const files = fs.readdirSync(cacheDir).filter((f) => f.startsWith('git-') && f.endsWith('.json'));
          if (files.length !== 1) return false;
          const parsed = JSON.parse(fs.readFileSync(path.join(cacheDir, files[0]), 'utf8'));
          return parsed.updatedAt > 0 && parsed.refreshingAt === undefined;
        };

        renderStatusLine(makeBasePayload({ cwd: repo }), { nowMs: Date.now(), spawnRefresh: true, cacheDir });
        await waitFor(() => readPrEntries().find((e) => e.key === `${repo}:feat/pr-ok`));
        await waitFor(readGitReady);

        fs.writeFileSync(headPath, 'ref: refs/heads/feat/other\n');
        renderStatusLine(makeBasePayload({ cwd: repo }), { nowMs: Date.now(), spawnRefresh: true, cacheDir });
        const twoEntries = await waitFor(() => {
          const all = readPrEntries();
          return all.length === 2 && all.some((e) => e.key === `${repo}:feat/other`) ? all : null;
        });
        assert.equal(twoEntries.length, 2);

        fs.writeFileSync(headPath, 'ref: refs/heads/feat/pr-ok\n');
        const prOkOut = stripAnsi(
          renderStatusLine(makeBasePayload({ cwd: repo }), { spawnRefresh: false, cacheDir })
        );
        assert.match(prOkOut, /PR #42 ✅/);

        fs.writeFileSync(headPath, 'ref: refs/heads/feat/other\n');
        const prConflictOut = stripAnsi(
          renderStatusLine(makeBasePayload({ cwd: repo }), { spawnRefresh: false, cacheDir })
        );
        assert.match(prConflictOut, /PR #99 ⚡Conflict/);

        // Detached-HEAD positive control (writer produces branch '1234567' entry) then detached negative
        execFileSync(process.execPath, [updater, repo, '1234567', prCacheDir], { stdio: 'ignore' });
        fs.writeFileSync(headPath, 'ref: refs/heads/1234567\n');
        const branch123Out = stripAnsi(
          renderStatusLine(makeBasePayload({ cwd: repo }), { spawnRefresh: false, cacheDir })
        );
        assert.match(branch123Out, /🌿 1234567 \(PR #1234567 ✅\)/);

        fs.writeFileSync(headPath, '123456789abcdef0123456789abcdef012345678\n');
        const detachedOut = stripAnsi(
          renderStatusLine(makeBasePayload({ cwd: repo }), { spawnRefresh: false, cacheDir })
        );
        assert.match(detachedOut, /🌿 1234567/);
        assert.doesNotMatch(detachedOut, /PR #1234567/);

        const detachedWithVcsSha = stripAnsi(
          renderStatusLine(makeBasePayload({ cwd: repo, vcs: { type: 'git', branch: '1234567' } }), {
            spawnRefresh: false,
            cacheDir,
          })
        );
        assert.match(detachedWithVcsSha, /🌿 1234567/);
        assert.doesNotMatch(detachedWithVcsSha, /PR #1234567/);

        // 7-day pruning covers stale .tmp and git-/cmux- cache files without removing fresh PR entries
        const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
        const stalePrTmp = path.join(prCacheDir, 'stale.123.tmp');
        const staleGitJson = path.join(cacheDir, 'git-stale.json');
        const staleCmuxTmp = path.join(cacheDir, 'cmux-stale.json.1.tmp');
        for (const p of [stalePrTmp, staleGitJson, staleCmuxTmp]) {
          fs.writeFileSync(p, '{}');
          fs.utimesSync(p, oldDate, oldDate);
        }

        execFileSync(process.execPath, [updater, repo, 'feat/pr-ok', prCacheDir], { stdio: 'ignore' });
        assert.equal(fs.existsSync(stalePrTmp), false);
        assert.equal(fs.existsSync(staleGitJson), false);
        assert.equal(fs.existsSync(staleCmuxTmp), false);
        assert.equal(readPrEntries().length, 3);
      }
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('updateCmuxStatus deduplicates per workspace across panes and rolls back on spawn error', async () => {
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

    const payloadA = { conversation_id: 'conv-1' };
    const payloadB = { conversation_id: 'conv-b' };
    const working = { cmuxValue: 'Working', cmuxIcon: 'gearshape.fill', cmuxColor: '#4C8DFF' };
    const idle = { cmuxValue: 'Idle', cmuxIcon: 'pause.circle.fill', cmuxColor: '#8E8E93' };
    const t0 = 1_700_000_000_000;

    const findSingleCmuxCache = (dir) => {
      const files = fs.readdirSync(dir).filter((f) => f.startsWith('cmux-') && f.endsWith('.json'));
      assert.equal(files.length, 1);
      return JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
    };

    const readLogLines = () =>
      fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean) : [];

    await withPatchedEnv(
      { CMUX_WINDOW_ID: 'win-1', CMUX_WORKSPACE_ID: 'ws-1', CMUX_SURFACE_ID: 'surf-a' },
      async () => {
        updateCmuxStatus(payloadA, working, t0, { hasCmux: true, cmuxCli: mockCmux, cacheDir });
        assert.equal(findSingleCmuxCache(cacheDir).updatedAt, t0);

        updateCmuxStatus(payloadA, working, t0 + 1000, { hasCmux: true, cmuxCli: mockCmux, cacheDir });
        assert.equal(findSingleCmuxCache(cacheDir).updatedAt, t0);

        await waitFor(() => readLogLines().length >= 1);
        await new Promise((r) => setTimeout(r, 100));
        assert.equal(readLogLines().length, 1);

        // Second pane in the same workspace overwrites shared 'agy' status to Idle
        process.env.CMUX_SURFACE_ID = 'surf-b';
        updateCmuxStatus(payloadB, idle, t0 + 2000, { hasCmux: true, cmuxCli: mockCmux, cacheDir });
        assert.equal(findSingleCmuxCache(cacheDir).updatedAt, t0 + 2000);
        const afterPaneB = await waitFor(() => {
          const lines = readLogLines();
          return lines.length >= 2 ? lines : null;
        });
        assert.equal(afterPaneB.length, 2);

        // Returning to Pane A must not be suppressed by a stale per-pane cache
        process.env.CMUX_SURFACE_ID = 'surf-a';
        updateCmuxStatus(payloadA, working, t0 + 3000, { hasCmux: true, cmuxCli: mockCmux, cacheDir });
        assert.equal(findSingleCmuxCache(cacheDir).updatedAt, t0 + 3000);
        const afterPaneA = await waitFor(() => {
          const lines = readLogLines();
          return lines.length >= 3 ? lines : null;
        });
        assert.equal(afterPaneA.length, 3);
        assert.match(afterPaneA[0], /set-status agy Working/);
        assert.match(afterPaneA[1], /set-status agy Idle/);
        assert.match(afterPaneA[2], /set-status agy Working/);

        // Repeat Working on Pane A within 60s dedupes again
        updateCmuxStatus(payloadA, working, t0 + 4000, { hasCmux: true, cmuxCli: mockCmux, cacheDir });
        assert.equal(findSingleCmuxCache(cacheDir).updatedAt, t0 + 3000);
        await new Promise((r) => setTimeout(r, 100));
        assert.equal(readLogLines().length, 3);

        const rollbackDir = path.join(root, 'cache-rollback');
        fs.mkdirSync(rollbackDir, { recursive: true });
        updateCmuxStatus(payloadA, working, t0, {
          hasCmux: true,
          cmuxCli: path.join(root, 'nonexistent-cmux'),
          cacheDir: rollbackDir,
        });
        const rolledBack = await waitFor(() => fs.readdirSync(rollbackDir).length === 0);
        assert.equal(rolledBack, true);
      }
    );
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
  assert.equal(displayWidth('└─▶'), 3);
  assert.equal(displayWidth('█'), 1);
  assert.equal(displayWidth('░'), 1);
  assert.equal(displayWidth('⚡'), 2);
  assert.equal(displayWidth('🔋'), 2);
  assert.equal(displayWidth('↻'), 1);
  assert.equal(displayWidth('·'), 1);
  assert.equal(displayWidth('💵'), 2);
  assert.equal(displayWidth('💳'), 2);
  assert.equal(displayWidth('⚙️'), 2);
});
