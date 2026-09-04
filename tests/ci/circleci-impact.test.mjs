import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const router = resolve('scripts/ci/circleci-impact.sh');
const root = mkdtempSync(join(tmpdir(), 'hex-circleci-impact-'));
const repo = join(root, 'repo');
const remote = join(root, 'remote.git');

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function write(path, value) {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, value);
}

function route(head, branch, mode, pattern) {
  git(repo, 'checkout', '--detach', head);
  const result = spawnSync('bash', [router, mode, pattern], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, CIRCLE_BRANCH: branch },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

try {
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'CircleCI Router Test');
  git(repo, 'config', 'user.email', 'router-test@example.invalid');

  write(join(repo, 'README.md'), 'base\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'base');

  write(join(repo, 'js', 'ai', 'changed.js'), 'export const changed = true;\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'A: gated AI change');
  const commitA = git(repo, 'rev-parse', 'HEAD');

  write(join(repo, 'docs', 'note.md'), 'docs only\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'B: docs only');
  const commitB = git(repo, 'rev-parse', 'HEAD');

  execFileSync('git', ['clone', '--bare', repo, remote], { encoding: 'utf8' });
  git(repo, 'remote', 'add', 'origin', remote);

  // Regression for the A -> B race: remote main is already B while the older
  // A pipeline starts. A must still validate its own first-parent delta.
  assert.equal(route(commitA, 'main', 'main-and-branch', '^js/ai/'), 'true');

  // B owns only its docs delta, so it correctly does not rerun the AI lane.
  assert.equal(route(commitB, 'main', 'main-and-branch', '^js/ai/'), 'false');

  // PR-only lanes remain disabled on main regardless of the changed path.
  assert.equal(route(commitA, 'main', 'pr-only', '^js/ai/'), 'false');

  console.log('circleci-impact routing: PASS');
} finally {
  rmSync(root, { recursive: true, force: true });
}
