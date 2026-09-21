import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding:'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}
function commit(work, message) {
  git(work, ['add', '-A']);
  git(work, ['-c','user.name=test','-c','user.email=test@example.invalid','commit','-m',message]);
  return git(work, ['rev-parse', 'HEAD']);
}
function mergeWithTemplate(work, branch, value, message) {
  const r = spawnSync('git', ['-c','user.name=test','-c','user.email=test@example.invalid','merge','--no-ff',branch,'-m',message], { cwd:work, encoding:'utf8' });
  if (r.status !== 0) {
    fs.writeFileSync(path.join(work, 'userscript/hex.user.template.js'), `${value}\n`);
    git(work, ['add', 'userscript/hex.user.template.js']);
    git(work, ['-c','user.name=test','-c','user.email=test@example.invalid','commit','--no-edit']);
  }
  return git(work, ['rev-parse', 'HEAD']);
}
function runSync(work) {
  return spawnSync(process.execPath, ['scripts/sync-generated-userscript.mjs'], {
    cwd:work, encoding:'utf8',
    env:{ ...process.env, GITHUB_EVENT_NAME:'push', GITHUB_REF_NAME:'release' },
  });
}

test('#9355 reset safety includes the net remote-tip to local-tip tree delta across merge topology', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-9355-'));
  try {
    const origin = path.join(sandbox, 'origin.git');
    const work = path.join(sandbox, 'work');
    git(sandbox, ['init', '--bare', '--initial-branch=release', origin]);
    git(sandbox, ['init', '--initial-branch=release', work]);
    git(work, ['remote', 'add', 'origin', origin]);
    fs.mkdirSync(path.join(work, 'scripts'), { recursive:true });
    fs.mkdirSync(path.join(work, 'tools/validation'), { recursive:true });
    fs.mkdirSync(path.join(work, 'userscript'), { recursive:true });
    fs.copyFileSync(path.join(ROOT, 'scripts/sync-generated-userscript.mjs'), path.join(work, 'scripts/sync-generated-userscript.mjs'));
    fs.copyFileSync(path.join(ROOT, 'tools/validation/generated-output-policy.mjs'), path.join(work, 'tools/validation/generated-output-policy.mjs'));
    fs.writeFileSync(path.join(work, 'userscript/hex.user.template.js'), 'seed\n');
    fs.writeFileSync(path.join(work, 'userscript/release-version.json'), '{"version":"test"}\n');
    commit(work, 'seed');

    fs.writeFileSync(path.join(work, 'source-only.txt'), 'source state that must survive\n');
    const source = commit(work, 'source state');

    git(work, ['switch', '-c', 'a', source]);
    fs.writeFileSync(path.join(work, 'userscript/hex.user.template.js'), 'A\n');
    const a = commit(work, 'generated A');

    git(work, ['switch', '-c', 'b', source]);
    fs.writeFileSync(path.join(work, 'userscript/hex.user.template.js'), 'B\n');
    commit(work, 'generated B');

    git(work, ['switch', 'a']);
    const localMerge = mergeWithTemplate(work, 'b', 'LOCAL', 'local merge');

    git(work, ['switch', '-c', 'remote-line', a]);
    mergeWithTemplate(work, 'b', 'REMOTE-BASE', 'remote merge');
    fs.rmSync(path.join(work, 'source-only.txt'));
    fs.writeFileSync(path.join(work, 'userscript/hex.user.template.js'), 'REMOTE\n');
    const remoteTip = commit(work, 'remote removes source state');
    git(work, ['push', 'origin', `${remoteTip}:refs/heads/release`]);

    git(work, ['switch', '-C', 'release', localMerge]);
    git(work, ['fetch', '--no-tags', 'origin', '+refs/heads/release:refs/remotes/origin/release']);

    assert.equal(git(work, ['rev-list', '--count', `${remoteTip}..${localMerge}`]), '1', 'only the merge commit is local-only');
    const mergeChanged = git(work, ['diff-tree', '--root', '-m', '--no-commit-id', '--name-only', '-r', localMerge]);
    assert.doesNotMatch(mergeChanged, /source-only\.txt/, 'per-parent merge diff hides the source path');
    assert.match(git(work, ['diff', '--name-only', remoteTip, localMerge]), /source-only\.txt/, 'reset would lose source state');

    const rejected = runSync(work);
    assert.equal(rejected.status, 1, rejected.stdout + rejected.stderr);
    assert.match(rejected.stderr, /refusing to discard local-only source commits before reset/);
    assert.equal(git(work, ['rev-parse', 'HEAD']), localMerge);
    assert.equal(fs.readFileSync(path.join(work, 'source-only.txt'), 'utf8'), 'source state that must survive\n');
  } finally {
    fs.rmSync(sandbox, { recursive:true, force:true });
  }
});
