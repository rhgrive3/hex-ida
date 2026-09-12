import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const router = resolve('scripts/ci/circleci-impact.sh');
const root = mkdtempSync(join(tmpdir(), 'hex-circleci-impact-'));
const repo = join(root, 'repo');
const remote = join(root, 'remote.git');
const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function write(path, value) {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, value);
}

function routeResult(head, branch, mode, pattern, env = {}) {
  git(repo, 'checkout', '--detach', head);
  return spawnSync('bash', [router, mode, pattern], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, CIRCLE_BRANCH: branch, ...env },
  });
}

function route(head, branch, mode, pattern, env = {}) {
  const result = routeResult(head, branch, mode, pattern, env);
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

  git(repo, 'checkout', '-b', 'feature');
  write(join(repo, 'js', 'ai', 'feature.js'), 'export const feature = true;\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'C: feature gated change');
  const commitC = git(repo, 'rev-parse', 'HEAD');

  write(join(repo, 'docs', 'feature-note.md'), 'feature docs only\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'D: feature docs only');
  const commitD = git(repo, 'rev-parse', 'HEAD');

  git(repo, 'checkout', 'main');
  execFileSync('git', ['clone', '--bare', repo, remote], { encoding: 'utf8' });
  git(repo, 'remote', 'add', 'origin', remote);

  // Regression for the A -> B race: remote main is already B while the older
  // A pipeline starts. A must still validate its own first-parent delta.
  assert.equal(route(commitA, 'main', 'main-and-branch', '^js/ai/'), 'true');

  // B owns only its docs delta, so it correctly does not rerun the AI lane.
  assert.equal(route(commitB, 'main', 'main-and-branch', '^js/ai/'), 'false');

  // PR-only lanes remain disabled on main regardless of the changed path.
  assert.equal(route(commitA, 'main', 'pr-only', '^js/ai/'), 'false');

  // Non-main stale suppression is safe because the newest branch head validates
  // the cumulative merge-base diff. C can skip once D exists; D still sees C.
  assert.equal(route(commitC, 'feature', 'main-and-branch', '^js/ai/'), 'false');
  assert.equal(route(commitD, 'feature', 'main-and-branch', '^js/ai/'), 'true');

  // A stale-head refresh failure must never turn into a false skip. With an
  // unresolvable branch name, routing falls through to the merge-base diff.
  assert.equal(route(commitC, 'missing-feature', 'main-and-branch', '^js/ai/'), 'true');

  // Missing provider branch metadata is uncertain, so the router must fail open.
  assert.equal(route(commitB, '', 'main-and-branch', '^js/ai/'), 'true');

  // A failed git diff must also fail open instead of becoming an empty diff.
  const fakeBin = join(root, 'fake-bin');
  const fakeGit = join(fakeBin, 'git');
  mkdirSync(fakeBin, { recursive: true });
  const fakeGitScript = [
    '#!/usr/bin/env bash',
    "if [[ \"${1:-}\" == 'diff' ]]; then exit 42; fi",
    `exec ${JSON.stringify(realGit)} "$@"`,
    '',
  ].join('\n');
  write(fakeGit, fakeGitScript);
  chmodSync(fakeGit, 0o755);
  assert.equal(
    route(commitD, 'feature', 'main-and-branch', '^js/ai/', {
      PATH: `${fakeBin}:${process.env.PATH || ''}`,
    }),
    'true',
  );

  // Malformed repository-owned regexes must fail visibly, never act as no-match.
  const invalidPattern = routeResult(commitD, 'feature', 'main-and-branch', '[');
  assert.notEqual(invalidPattern.status, 0);
  assert.match(invalidPattern.stderr, /invalid CircleCI impact path pattern/);

  // Issue #5904: exercise the real lane regex with one-file branch diffs and
  // main first-parent deltas. The old regex demonstrably misses both files.
  const config = readFileSync(resolve('.circleci/config.yml'), 'utf8');
  const agentJob = config.match(/^  agent-loop-resilience:\n([\s\S]*?)(?=^  [\w-]+:)/m)?.[1];
  const agentPattern = agentJob?.match(/circleci-impact\.sh main-and-branch '([^']+)'/)?.[1];
  assert.ok(agentPattern, 'read the actual resilience lane filter');
  const oldAgentPattern = '^js/userscript/dev/';
  for (const [index, file] of ['js/userscript/chatgpt-adapter.js', 'js/ai/dev/workers/contracts.js'].entries()) {
    const branch = `resilience-counterexample-${index}`;
    git(repo, 'checkout', '-b', branch, 'main');
    write(join(repo, file), 'export const changed = true;\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', `Change only ${file}`);
    git(repo, 'push', 'origin', branch);
    const head = git(repo, 'rev-parse', 'HEAD');
    for (const routedBranch of [branch, 'main']) {
      assert.equal(route(head, routedBranch, 'main-and-branch', oldAgentPattern), 'false',
        `old policy misses ${file} on ${routedBranch}`);
      assert.equal(route(head, routedBranch, 'main-and-branch', agentPattern), 'true',
        `actual policy must run ${file} on ${routedBranch}`);
    }
  }
  assert.equal(route(commitB, 'main', 'main-and-branch', agentPattern), 'false',
    'unrelated docs-only main delta must keep skipping the resilience lane');

  console.log('circleci-impact routing: PASS');
} finally {
  rmSync(root, { recursive: true, force: true });
}
