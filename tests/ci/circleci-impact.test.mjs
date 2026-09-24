import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

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
  git(repo, 'commit', '-m', 'D: feature docs only [ci skip]');
  const commitD = git(repo, 'rev-parse', 'HEAD');

  git(repo, 'checkout', 'main');
  execFileSync('git', ['clone', '--bare', repo, remote], { encoding: 'utf8' });
  git(repo, 'remote', 'add', 'origin', remote);

  // #9211: unsupported trailing arguments are invocation errors and must be
  // rejected before any repository/network work is attempted.
  const arityFakeBin = join(root, 'arity-fake-bin');
  const arityGit = join(arityFakeBin, 'git');
  const arityGitMarker = join(root, 'arity-git-called');
  mkdirSync(arityFakeBin, { recursive: true });
  write(arityGit, [
    '#!/usr/bin/env bash',
    `printf 'called\\n' >> ${JSON.stringify(arityGitMarker)}`,
    'exit 99',
    '',
  ].join('\n'));
  chmodSync(arityGit, 0o755);
  for (const args of [
    ['main-and-branch', '^js/ai/', 'unexpected'],
    ['pr-only', '^js/ai/', 'extra1', 'extra2'],
  ]) {
    const result = spawnSync('bash', [router, ...args], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, CIRCLE_BRANCH: 'main', PATH: `${arityFakeBin}:${process.env.PATH || ''}` },
    });
    assert.equal(result.status, 2, result.stderr || result.stdout);
    assert.match(result.stderr, /unexpected CircleCI impact arguments/);
  }
  assert.equal(existsSync(arityGitMarker), false, 'rejected trailing arguments must not invoke git');

  // #9613: unresolved pipeline HEAD is repository uncertainty, not a caller
  // configuration error. Run conservatively instead of escaping through set -e.
  for (const [name, prepare] of [
    ['unborn', (cwd) => git(cwd, 'init', '-b', 'main')],
    ['missing-ref', (cwd) => {
      git(cwd, 'init', '-b', 'main');
      git(cwd, 'config', 'user.name', 'CircleCI Router Test');
      git(cwd, 'config', 'user.email', 'router-test@example.invalid');
      write(join(cwd, 'README.md'), 'committed\n');
      git(cwd, 'add', '.');
      git(cwd, 'commit', '-m', 'committed head');
      writeFileSync(join(cwd, '.git', 'HEAD'), 'ref: refs/heads/missing\n');
    }],
  ]) {
    const uncertainRepo = join(root, `head-${name}`);
    mkdirSync(uncertainRepo, { recursive: true });
    prepare(uncertainRepo);
    const result = spawnSync('bash', [router, 'main-and-branch', '^js/ai/'], {
      cwd: uncertainRepo,
      encoding: 'utf8',
      env: { ...process.env, CIRCLE_BRANCH: 'feature' },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stdout.trim(), 'true');
    assert.match(result.stderr, /could not resolve pipeline HEAD; running lane conservatively/);
  }

  // Regression for the A -> B race: remote main is already B while the older
  // A pipeline starts. A must still validate its own first-parent delta.
  assert.equal(route(commitA, 'main', 'main-and-branch', '^js/ai/'), 'true');

  // B owns only its docs delta, so it correctly does not rerun the AI lane.
  assert.equal(route(commitB, 'main', 'main-and-branch', '^js/ai/'), 'false');

  // PR-only lanes remain disabled on main regardless of the changed path.
  assert.equal(route(commitA, 'main', 'pr-only', '^js/ai/'), 'false');

  // #9435: best-effort impact-buffer cleanup must preserve an already-established
  // routing result and exit status.
  const cleanupFakeBin = join(root, 'cleanup-fake-bin');
  const cleanupRm = join(cleanupFakeBin, 'rm');
  mkdirSync(cleanupFakeBin, { recursive: true });
  write(cleanupRm, [
    '#!/usr/bin/env bash',
    "printf 'forced cleanup failure\\n' >&2",
    'exit 73',
    '',
  ].join('\n'));
  chmodSync(cleanupRm, 0o755);
  for (const [head, routedBranch, mode, expected] of [
    [commitA, 'main', 'pr-only', 'false'],
    [commitA, 'main', 'main-and-branch', 'true'],
    [commitB, '', 'main-and-branch', 'true'],
  ]) {
    const result = routeResult(head, routedBranch, mode, '^js/ai/', {
      PATH: `${cleanupFakeBin}:${process.env.PATH || ''}`,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stdout.trim(), expected);
    assert.match(result.stderr, /could not remove impact path buffer during cleanup/);
  }

  // A descendant remote head is not proof that a replacement pipeline exists.
  // D is explicitly CI-skipped, so C must still route its own gated change.
  assert.equal(route(commitC, 'feature', 'main-and-branch', '^js/ai/'), 'true');
  assert.equal(route(commitD, 'feature', 'main-and-branch', '^js/ai/'), 'true');

  // #9160: a force-pushed replacement is not proof that the old pipeline's
  // changes are covered. The stale old head must route on its own merge-base
  // diff when the remote replacement is a sibling rather than a descendant.
  git(repo, 'checkout', '-B', 'rewritten-feature', 'main');
  write(join(repo, 'js', 'ai', 'rewritten-old.js'), 'export const oldHeadOnly = true;\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'E: gated change on old rewritten head');
  const rewrittenOld = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'push', '-u', 'origin', 'rewritten-feature');

  git(repo, 'checkout', '-B', 'rewritten-feature', 'main');
  write(join(repo, 'docs', 'rewritten-replacement.md'), 'replacement docs only\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'F: force-pushed docs-only replacement');
  const rewrittenLatest = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'push', '--force', 'origin', 'rewritten-feature');
  assert.notEqual(rewrittenOld, rewrittenLatest);
  assert.equal(route(rewrittenOld, 'rewritten-feature', 'main-and-branch', '^js/ai/'), 'true',
    'non-descendant remote replacement must not stale-suppress the old gated head');
  assert.equal(route(rewrittenLatest, 'rewritten-feature', 'main-and-branch', '^js/ai/'), 'false',
    'replacement docs-only head correctly skips the gated lane on its own diff');

  // Branch-name lookup is not needed for ownership proof; any non-empty branch
  // still routes its exact HEAD against the merge base.
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

  // Importing coverage must not terminate the caller before CI policy assertions.
  const policyEntry = resolve('tests/ci-development-mode.mjs');
  const policy = spawnSync(process.execPath, [policyEntry], { encoding: 'utf8', env: process.env });
  assert.equal(policy.status, 0, policy.stderr || policy.stdout);
  assert.match(policy.stdout, /CI development mode contract: PASS/, 'all existing CI assertions must execute');
  const continuation = spawnSync(process.execPath, ['--input-type=module', '-e',
    `await import(${JSON.stringify(pathToFileURL(policyEntry).href)}); throw new Error('ci-policy-continuation-sentinel');`,
  ], { encoding: 'utf8', env: process.env });
  assert.equal(continuation.status, 1, 'coverage import must not exit its caller with success');
  assert.match(continuation.stderr, /ci-policy-continuation-sentinel/);

  console.log('circleci-impact routing: PASS');
} finally {
  rmSync(root, { recursive: true, force: true });
}
