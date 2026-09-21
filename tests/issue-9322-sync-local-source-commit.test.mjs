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
function runSync(work) {
  return spawnSync(process.execPath, ['scripts/sync-generated-userscript.mjs'], {
    cwd:work, encoding:'utf8',
    env:{ ...process.env, GITHUB_EVENT_NAME:'push', GITHUB_REF_NAME:'release' },
  });
}

test('#9322 clean local source commit is rejected before destructive reset', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-9322-'));
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
    fs.writeFileSync(path.join(work, 'userscript/hex.user.template.js'), 'canonical\n');
    fs.writeFileSync(path.join(work, 'userscript/release-version.json'), '{"version":"test"}\n');
    fs.writeFileSync(path.join(work, 'js/app.js'), 'export const value = 1;\n');
    git(work, ['add', '-A']);
    git(work, ['-c','user.name=test','-c','user.email=test@example.invalid','commit','-m','seed']);
    git(work, ['push', '-u', 'origin', 'HEAD:refs/heads/release']);
    const remoteTip = git(work, ['rev-parse', 'HEAD']);

    fs.writeFileSync(path.join(work, 'js/app.js'), 'export const value = 2;\n');
    git(work, ['add', 'js/app.js']);
    git(work, ['-c','user.name=test','-c','user.email=test@example.invalid','commit','-m','local source']);
    const localSourceTip = git(work, ['rev-parse', 'HEAD']);
    const rejected = runSync(work);
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /refusing to discard local-only source commits before reset/);
    assert.equal(git(work, ['rev-parse', 'HEAD']), localSourceTip, 'local source commit must remain checked out');

    git(work, ['reset', '--hard', remoteTip]);
    fs.writeFileSync(path.join(work, 'userscript/hex.user.template.js'), 'stale-generated-only\n');
    git(work, ['add', 'userscript/hex.user.template.js']);
    git(work, ['-c','user.name=test','-c','user.email=test@example.invalid','commit','-m','stale generated output']);
    const allowed = runSync(work);
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.match(allowed.stdout, /advanced before attempt 1; rebuilding latest remote tip/);
    assert.equal(git(work, ['rev-parse', 'HEAD']), remoteTip);
  } finally {
    fs.rmSync(sandbox, { recursive:true, force:true });
  }
});
