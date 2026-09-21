import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding:'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function commit(work, message) {
  git(work, ['add', '-A']);
  git(work, ['-c','user.name=test','-c','user.email=test@example.invalid','commit','-m',message]);
  return git(work, ['rev-parse', 'HEAD']);
}

function runSync(work) {
  return spawnSync(process.execPath, ['scripts/sync-generated-userscript.mjs'], {
    cwd:work,
    encoding:'utf8',
    env:{ ...process.env, GITHUB_EVENT_NAME:'push', GITHUB_REF_NAME:'release' },
  });
}

test('#9355 endpoint tree proof rejects merge state hidden from local-only commit enumeration', () => {
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
    fs.mkdirSync(path.join(work, 'js'), { recursive:true });
    fs.copyFileSync(path.join(ROOT, 'scripts/sync-generated-userscript.mjs'), path.join(work, 'scripts/sync-generated-userscript.mjs'));
    fs.copyFileSync(path.join(ROOT, 'tools/validation/generated-output-policy.mjs'), path.join(work, 'tools/validation/generated-output-policy.mjs'));
    fs.writeFileSync(path.join(work, 'userscript/hex.user.template.js'), 'template-base\n');
    fs.writeFileSync(path.join(work, 'userscript/release-version.json'), '{"version":"base"}\n');
    fs.writeFileSync(path.join(work, 'js/app.js'), 'export const value = 1;\n');
    const base = commit(work, 'base');

    fs.writeFileSync(path.join(work, 'js/app.js'), 'export const value = 2;\n');
    const source = commit(work, 'source state');

    git(work, ['checkout', '-b', 'parent-a', source]);
    fs.writeFileSync(path.join(work, 'userscript/hex.user.template.js'), 'template-a\n');
    const parentA = commit(work, 'generated a');

    git(work, ['checkout', '-b', 'parent-b', source]);
    fs.writeFileSync(path.join(work, 'userscript/release-version.json'), '{"version":"b"}\n');
    const parentB = commit(work, 'generated b');

    git(work, ['checkout', '-b', 'remote-line', parentA]);
    git(work, ['-c','user.name=test','-c','user.email=test@example.invalid','merge','--no-ff',parentB,'-m','remote merge']);
    fs.writeFileSync(path.join(work, 'js/app.js'), 'export const value = 1;\n');
    commit(work, 'remote reverts source state');
    git(work, ['push', 'origin', 'HEAD:refs/heads/release']);
    const remoteTip = git(work, ['rev-parse', 'HEAD']);

    git(work, ['checkout', '-B', 'release', parentA]);
    git(work, ['-c','user.name=test','-c','user.email=test@example.invalid','merge','--no-ff',parentB,'-m','local alternate merge']);
    const localTip = git(work, ['rev-parse', 'HEAD']);
    assert.notEqual(localTip, remoteTip);
    assert.equal(fs.readFileSync(path.join(work, 'js/app.js'), 'utf8'), 'export const value = 2;\n');

    const selected = git(work, ['rev-list', `refs/remotes/origin/release..${localTip}`]).split(/\s+/).filter(Boolean);
    assert.deepEqual(selected, [localTip], 'source commit must already be reachable from remote and absent from local-only enumeration');
    const mergePaths = git(work, ['diff-tree','--root','-m','--no-commit-id','--name-only','-r',localTip]).split(/\s+/).filter(Boolean);
    assert.ok(mergePaths.length > 0);
    assert.ok(mergePaths.every((name) => name === 'userscript/hex.user.template.js' || name === 'userscript/release-version.json'));

    const rejected = runSync(work);
    assert.equal(rejected.status, 1, rejected.stdout);
    assert.match(rejected.stderr, /refusing to discard local-only source commits before reset: js\/app\.js/);
    assert.equal(git(work, ['rev-parse', 'HEAD']), localTip, 'unsafe local merge must remain checked out');
    assert.equal(fs.readFileSync(path.join(work, 'js/app.js'), 'utf8'), 'export const value = 2;\n');
    assert.equal(base.length, 40);
  } finally {
    fs.rmSync(sandbox, { recursive:true, force:true });
  }
});
