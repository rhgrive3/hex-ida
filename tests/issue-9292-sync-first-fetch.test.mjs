import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function git(cwd, args, { allowFailure = false } = {}) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result;
}

test('#9292 sync materializes origin/<branch> before attempt 1', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-9292-'));
  try {
    const origin = path.join(sandbox, 'origin.git');
    const work = path.join(sandbox, 'work');
    git(sandbox, ['init', '--bare', '--initial-branch=main', origin]);
    git(sandbox, ['clone', origin, work]);

    fs.mkdirSync(path.join(work, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(work, 'tools/validation'), { recursive: true });
    fs.mkdirSync(path.join(work, 'userscript'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'scripts/sync-generated-userscript.mjs'), path.join(work, 'scripts/sync-generated-userscript.mjs'));
    fs.copyFileSync(path.join(ROOT, 'tools/validation/generated-output-policy.mjs'), path.join(work, 'tools/validation/generated-output-policy.mjs'));
    fs.writeFileSync(path.join(work, 'userscript/hex.user.template.js'), 'canonical\n');
    fs.writeFileSync(path.join(work, 'userscript/release-version.json'), '{"version":"test"}\n');
    git(work, ['add', '-A']);
    git(work, ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'seed']);
    git(work, ['push', '-u', 'origin', 'HEAD:refs/heads/main']);

    git(work, ['update-ref', '-d', 'refs/remotes/origin/main']);
    assert.notEqual(git(work, ['show-ref', '--verify', 'refs/remotes/origin/main'], { allowFailure: true }).status, 0);

    const result = spawnSync(process.execPath, ['scripts/sync-generated-userscript.mjs'], {
      cwd: work,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_EVENT_NAME: 'push', GITHUB_REF_NAME: 'main' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /canonical outputs already match source/);
    assert.equal(git(work, ['show-ref', '--verify', 'refs/remotes/origin/main'], { allowFailure: true }).status, 0);

    const missing = spawnSync(process.execPath, ['scripts/sync-generated-userscript.mjs'], {
      cwd: work,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_EVENT_NAME: 'push', GITHUB_REF_NAME: 'does-not-exist' },
    });
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /git fetch .*does-not-exist.*failed/);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
