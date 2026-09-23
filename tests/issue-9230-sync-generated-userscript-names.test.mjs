import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function commit(cwd, message) {
  git(cwd, ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '-m', message]);
  return git(cwd, ['rev-parse', 'HEAD']);
}

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-9230-'));
try {
  const origin = path.join(sandbox, 'origin.git');
  const work = path.join(sandbox, 'work');
  git(sandbox, ['init', '--bare', '--initial-branch=main', origin]);
  git(sandbox, ['init', '--initial-branch=main', work]);
  git(work, ['remote', 'add', 'origin', origin]);
  git(work, ['config', 'user.name', 'test']);
  git(work, ['config', 'user.email', 'test@example.invalid']);

  for (const dir of ['scripts', 'tools/validation', 'userscript']) {
    fs.mkdirSync(path.join(work, dir), { recursive: true });
  }
  fs.copyFileSync(path.join(ROOT, 'scripts/sync-generated-userscript.mjs'), path.join(work, 'scripts/sync-generated-userscript.mjs'));
  fs.copyFileSync(path.join(ROOT, 'tools/validation/generated-output-policy.mjs'), path.join(work, 'tools/validation/generated-output-policy.mjs'));
  fs.writeFileSync(path.join(work, 'userscript/hex.user.template.js'), 'base\n');
  fs.writeFileSync(path.join(work, 'userscript/release-version.json'), '{"version":"base"}\n');
  git(work, ['add', '-A']);
  commit(work, 'seed');
  git(work, ['push', '-u', 'origin', 'main']);

  // Verify that trailing whitespace in untracked file is not trimmed
  const testFile = path.join(work, 'userscript/hex.user.template.js ');
  fs.writeFileSync(testFile, 'unexpected\n');

  const res = spawnSync('node', ['scripts/sync-generated-userscript.mjs'], {
    cwd: work,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_REF_NAME: 'main', GITHUB_EVENT_NAME: 'push' },
  });
  assert.notEqual(res.status, 0);
  assert.ok(res.stderr.includes('non-canonical changes present') || res.stderr.includes('userscript/hex.user.template.js '));
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}

console.log('issue-9230-sync-generated-userscript-names: PASS');
