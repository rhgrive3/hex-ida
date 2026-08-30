/*
 * Keep userscript owned generated output canonical on the main integration
 * lane (EP-003: integration owns canonical committed generated output).
 *
 * Every merge that changes userscript-owned source advances the release
 * identity, so the committed template can never embed its own content hash.
 * This script rebuilds (optionally), stages only the canonical generated
 * paths, and pushes the sync commit onto the release branch with a
 * fetch/rebase/rebuild retry loop for concurrent main movement. Anything
 * outside the canonical paths — unexpected build side effects, deleted
 * outputs, non-release contexts — fails closed and leaves main untouched.
 *
 * Context comes from CI env vars; --dispatch-paths enables manual repairs
 * where no changed-path set exists (workflow_dispatch).
 */
import { spawnSync } from 'node:child_process';
import { resolveCanonicalGeneratedOutputCommit } from '../tools/validation/generated-output-policy.mjs';

const root = process.cwd();
const argv = process.argv.slice(2);
const rebuild = argv.includes('--rebuild');
const dispatchFlag = '--dispatch-paths=';
const dispatchArg = argv.find((arg) => arg.startsWith(dispatchFlag));
const dispatchPaths = dispatchArg ? dispatchArg.slice(dispatchFlag.length).split(',').map((value) => value.trim()).filter(Boolean) : null;

const branch = process.env.GITHUB_REF_NAME || git(['rev-parse', '--abbrev-ref', 'HEAD']);
const eventName = process.env.GITHUB_EVENT_NAME || '';

if (rebuild) {
  const build = run('npm', ['run', 'userscript:build']);
  if (build.status !== 0) fail('userscript:build failed; refusing to sync generated output.');
}

const unstagedDeleted = names(git(['ls-files', '--deleted', '--', ...canonicalPathsList()]));
const stagedDeleted = names(git(['diff', '--cached', '--diff-filter=D', '--name-only', '--', ...canonicalPathsList()]));
const deletedCanonical = [...new Set([...unstagedDeleted, ...stagedDeleted])];
const unstaged = names(git(['diff', '--name-only', '--', '.']));
const staged = names(git(['diff', '--cached', '--name-only', '--', '.']));
const untracked = names(git(['ls-files', '--others', '--exclude-standard']));

const changed = [...new Set([...unstaged, ...staged, ...untracked, ...deletedCanonical])];
const decision = resolveCanonicalGeneratedOutputCommit({
  eventName,
  refName: branch,
  changedPaths: dispatchPaths ?? changed,
  deletedPaths: deletedCanonical,
});

if (!decision.canCommit) {
  if (dispatchPaths && decision.paths.length === 0) {
    console.log('generated-userscript-sync: no canonical diff to commit.');
    process.exit(0);
  }
  if (decision.offList.length > 0) {
    console.error(`generated-userscript-sync: refusing to auto-commit; non-canonical changes present: ${decision.offList.join(', ')}`);
    process.exit(1);
  }
  if (decision.deletions.length > 0) {
    console.error(`generated-userscript-sync: refusing to commit deleted canonical output: ${decision.deletions.join(', ')}`);
    process.exit(1);
  }
  if (decision.paths.length === 0) {
    console.log('generated-userscript-sync: no canonical diff to commit.');
    process.exit(0);
  }
  console.error(`generated-userscript-sync: context not permitted to commit generated output (event=${eventName || '<none>'} ref=${branch || '<none>'}).`);
  process.exit(1);
}

const paths = [...decision.paths, ...decision.deletions];
gitOk(['config', 'user.name', 'github-actions[bot]']);
gitOk(['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);
gitOk(['add', '-A', '--', ...paths]);
if (run('git', ['diff', '--cached', '--quiet'], { allowFailure: true }).status === 0) {
  console.log('generated-userscript-sync: no canonical diff to commit.');
  process.exit(0);
}
gitOk(['commit', '-m', 'chore: sync generated userscript']);
console.log(`generated-userscript-sync: committing canonical output (${paths.join(', ')}) onto ${branch}.`);

for (let attempt = 1; attempt <= 3; attempt += 1) {
  const push = spawnSync('git', ['push', 'origin', `HEAD:refs/heads/${branch}`], { cwd: root, encoding: 'utf8' });
  if (push.status === 0) {
    console.log('generated-userscript-sync: main is canonical again.');
    process.exit(0);
  }
  console.log(`generated-userscript-sync: push rejected (attempt ${attempt}); rebasing onto ${branch}.`);
  gitOk(['fetch', 'origin', branch]);
  const rebase = spawnSync('git', ['rebase', `origin/${branch}`], { cwd: root, encoding: 'utf8' });
  if (rebase.status !== 0) {
    spawnSync('git', ['rebase', '--abort'], { cwd: root });
    const detail = String(rebase.stderr || rebase.stdout || '').trim().slice(-2000);
    fail(`rebase onto ${branch} failed; another integration sync should own the canonical state. ${detail}`);
  }
  if (rebuild) {
    const build = run('npm', ['run', 'userscript:build']);
    if (build.status !== 0) fail('userscript:build failed during rebase retry.');
    gitOk(['add', '-A', '--', ...canonicalPathsList()]);
    const dirty = git(['status', '--porcelain', '--untracked-files=no', '--', ...canonicalPathsList()]);
    if (dirty) gitOk(['commit', '--amend', '--no-edit']);
  }
}
fail(`could not push the generated userscript sync to ${branch} after 3 attempts.`);

function canonicalPathsList() {
  return ['userscript/hex.user.template.js', 'userscript/release-version.json'];
}

function names(output) {
  return output ? output.split('\n').map((line) => line.trim()).filter(Boolean) : [];
}

function git(args) {
  const result = run('git', args, { allowFailure: true });
  if (result.status !== 0) return '';
  return result.stdout.trim();
}

function gitOk(args) {
  const result = run('git', args);
  if (result.status !== 0) fail(`git ${args.join(' ')} failed: ${result.stderr?.trim() || result.stdout?.trim() || 'unknown error'}`);
  return result.stdout.trim();
}

function run(bin, args, { allowFailure = false } = {}) {
  const result = spawnSync(bin, args, { cwd: root, encoding: 'utf8', env: process.env, maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0 && !allowFailure) {
    const detail = String(result.stderr || result.stdout || '').trim();
    fail(`${bin} ${args.join(' ')} failed: ${detail.slice(-4000) || 'no output'}`);
  }
  return result;
}

function fail(message) {
  console.error(`generated-userscript-sync: ${message}`);
  process.exit(1);
}
