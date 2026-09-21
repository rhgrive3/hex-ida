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

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-9355-'));
try {
  const origin = path.join(sandbox, 'origin.git');
  const work = path.join(sandbox, 'work');
  git(sandbox, ['init', '--bare', '--initial-branch=release', origin]);
  git(sandbox, ['init', '--initial-branch=release', work]);
  git(work, ['remote', 'add', 'origin', origin]);
  git(work, ['config', 'user.name', 'test']);
  git(work, ['config', 'user.email', 'test@example.invalid']);

  for (const dir of ['scripts', 'tools/validation', 'userscript', 'js']) {
    fs.mkdirSync(path.join(work, dir), { recursive: true });
  }
  fs.copyFileSync(path.join(ROOT, 'scripts/sync-generated-userscript.mjs'), path.join(work, 'scripts/sync-generated-userscript.mjs'));
  fs.copyFileSync(path.join(ROOT, 'tools/validation/generated-output-policy.mjs'), path.join(work, 'tools/validation/generated-output-policy.mjs'));
  fs.writeFileSync(path.join(work, 'userscript/hex.user.template.js'), 'base\n');
  fs.writeFileSync(path.join(work, 'userscript/release-version.json'), '{"version":"base"}\n');
  fs.writeFileSync(path.join(work, 'js/source-only.js'), 'export const source = 1;\n');
  git(work, ['add', '-A']);
  commit(work, 'seed with source');
  const seed = git(work, ['rev-parse', 'HEAD']);

  git(work, ['branch', 'a', seed]);
  git(work, ['branch', 'b', seed]);

  git(work, ['checkout', 'a']);
  fs.writeFileSync(path.join(work, 'userscript/hex.user.template.js'), 'from-a\n');
  git(work, ['add', 'userscript/hex.user.template.js']);
  const a = commit(work, 'generated a');

  git(work, ['checkout', 'b']);
  fs.writeFileSync(path.join(work, 'userscript/release-version.json'), '{"version":"b"}\n');
  git(work, ['add', 'userscript/release-version.json']);
  commit(work, 'generated b');

  git(work, ['checkout', '-B', 'local', a]);
  git(work, ['merge', '--no-ff', 'b', '-m', 'local generated merge']);
  const localMerge = git(work, ['rev-parse', 'HEAD']);

  git(work, ['checkout', '-B', 'release', a]);
  git(work, ['merge', '--no-ff', 'b', '-m', 'remote generated merge']);
  fs.rmSync(path.join(work, 'js/source-only.js'));
  git(work, ['add', '-A']);
  commit(work, 'remote removes source');
  git(work, ['push', '-u', 'origin', 'release']);

  git(work, ['checkout', 'local']);
  const result = spawnSync(process.execPath, ['scripts/sync-generated-userscript.mjs'], {
    cwd: work,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_EVENT_NAME: 'push', GITHUB_REF_NAME: 'release' },
  });

  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stderr, /refusing to discard local-only source commits before reset/);
  assert.equal(git(work, ['rev-parse', 'HEAD']), localMerge, 'rejected reset must preserve local HEAD');
  assert.equal(fs.existsSync(path.join(work, 'js/source-only.js')), true, 'rejected reset must preserve local source state');
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}

console.log('issue-9355: ok');
