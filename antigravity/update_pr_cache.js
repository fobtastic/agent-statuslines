#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const repoDir = process.argv[2];
const branchName = process.argv[3];
const home = process.env.HOME || os.homedir() || '/home/ubuntu';
const prCacheDir = process.argv[4] || path.join(home, '.gemini', 'cache', 'pr');

const hashKey = (str) => crypto.createHash('sha1').update(str).digest('hex').slice(0, 12);

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
        windowsHide: true,
      }
    );
    if (stdout.trim()) {
      prData = JSON.parse(stdout);
    }
  } catch (_) {
    prData = { state: 'NONE' };
  }

  const key = `${repoDir}:${branchName}`;
  const targetFile = path.join(prCacheDir, `${hashKey(key)}.json`);
  writeJsonAtomic(targetFile, {
    key,
    number: prData.number || 0,
    state: prData.state || 'NONE',
    title: prData.title || '',
    url: prData.url || '',
    mergeable: prData.mergeable || 'UNKNOWN',
    mergeStateStatus: prData.mergeStateStatus || 'UNKNOWN',
    statusCheckRollup: prData.statusCheckRollup || [],
    updatedAt: Date.now(),
  });

  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  try {
    for (const name of fs.readdirSync(prCacheDir)) {
      if (!name.endsWith('.json')) continue;
      const fullPath = path.join(prCacheDir, name);
      try {
        if (fs.statSync(fullPath).mtimeMs < cutoff) {
          fs.unlinkSync(fullPath);
        }
      } catch (_) {}
    }
  } catch (_) {}
} catch (_) {}
