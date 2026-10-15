#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const repoDir = process.argv[2];
const branchName = process.argv[3];
const home = process.env.HOME || '/home/ubuntu';
const cacheFile = path.join(home, '.gemini', 'pr-cache.json');

if (!repoDir || !branchName) {
  process.exit(1);
}

try {
  let prData = { state: 'NONE' };
  try {
    const stdout = execFileSync(
      'gh',
      [
        'pr',
        'view',
        branchName,
        '--json',
        'number,state,title,url,mergeable,mergeStateStatus,statusCheckRollup',
      ],
      {
        cwd: repoDir,
        encoding: 'utf8',
        timeout: 8000,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    if (stdout.trim()) {
      prData = JSON.parse(stdout);
    }
  } catch (err) {
    prData = { state: 'NONE' };
  }

  let cache = {};
  if (fs.existsSync(cacheFile)) {
    try {
      cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    } catch (e) {}
  }

  const key = `${repoDir}:${branchName}`;
  cache[key] = {
    number: prData.number || 0,
    state: prData.state || 'NONE',
    title: prData.title || '',
    url: prData.url || '',
    mergeable: prData.mergeable || 'UNKNOWN',
    mergeStateStatus: prData.mergeStateStatus || 'UNKNOWN',
    statusCheckRollup: prData.statusCheckRollup || [],
    updatedAt: Date.now(),
  };

  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const k in cache) {
    if (cache[k] && cache[k].updatedAt < cutoff) {
      delete cache[k];
    }
  }

  fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2), 'utf8');
  process.exit(0);
} catch (e) {
  process.exit(0);
}
