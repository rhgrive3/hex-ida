/*
 * Keep userscript-owned generated output canonical on the release integration
 * lane. The caller must be a push-only/write-capable workflow; this script
 * independently refuses non-release contexts, off-list build effects, and
 * deleted canonical outputs.
 *
 * A concurrent main merge is handled by discarding the stale generated commit,
 * resetting to the newest remote tip, rebuilding, and trying again. Source
 * changes are never rebased into or carried by the generated-output commit.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import {
  CANONICAL_GENERATED_OUTPUT_PATHS,
  resolveCanonicalGeneratedOutputCommit,
} from '../tools/validation/generated-output-policy.mjs';

const root = process.cwd();
const argv = process.argv.slice(2);
const rebuild = argv.includes('--rebuild');
const branch = process.env.GITHUB_REF_NAME || gitRead(['rev-parse', '--abbrev-ref', 'HEAD']);
const eventName = process.env.GITHUB_EVENT_NAME || '';
const maxAttempts = 4;

for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
  if (attempt > 1) {
    fetchRemoteBranch();
    gitOk(['reset', '--hard', `refs/remotes/origin/${branch}`]);
  }

  if (rebuild) runOk('npm', ['run', 'userscript:build']);

  const state = collectState();
  const decision = resolveCanonicalGeneratedOutputCommit({
    eventName,
    refName: branch,
    changedPaths: state.changed,
    deletedPaths: state.deleted,
  });

  if (decision.offList.length > 0) {
    fail(`refusing to auto-commit; non-canonical changes present: ${decision.offList.join(', ')}`);
  }
  if (decision.deletions.length > 0) {
    fail(`refusing to commit deleted canonical output: ${decision.deletions.join(', ')}`);
  }
  if (decision.paths.length === 0) {
    console.log('generated-userscript-sync: canonical outputs already match source.');
    process.exit(0);
  }
  if (!decision.canCommit) {
    fail(`context not permitted to commit generated output (event=${eventName || '<none>'} ref=${branch || '<none>'}).`);
  }

  gitOk(['config', 'user.name', 'github-actions[bot]']);
  gitOk(['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);
  gitOk(['add', '-A', '--', ...CANONICAL_GENERATED_OUTPUT_PATHS]);
  gitOk(['commit', '-m', 'chore: sync generated userscript']);

  const push = run('git', ['push', 'origin', `HEAD:refs/heads/${branch}`], { allowFailure: true });
  if (push.status === 0) {
    fetchRemoteBranch();
    const remoteTip = gitRead(['rev-parse', `refs/remotes/origin/${branch}`]);
    const localTip = gitRead(['rev-parse', 'HEAD']);
    if (remoteTip === localTip) {
      console.log(`generated-userscript-sync: canonical outputs published on ${branch}.`);
      process.exit(0);
    }
    if (attempt < maxAttempts) {
      console.log(`generated-userscript-sync: ${branch} advanced after publish; rebuilding latest tip (attempt ${attempt + 1}/${maxAttempts}).`);
      continue;
    }
    break;
  }

  if (attempt < maxAttempts) {
    console.log(`generated-userscript-sync: push raced with ${branch}; rebuilding latest tip (attempt ${attempt + 1}/${maxAttempts}).`);
  }
}

fail(`could not publish generated userscript sync to ${branch} after ${maxAttempts} attempts.`);

function collectState() {
  for (const file of CANONICAL_GENERATED_OUTPUT_PATHS) {
    if (!fs.existsSync(file)) {
      fail(`canonical generated output is missing from the worktree: ${file}`);
    }
  }

  const deleted = [...new Set([
    ...names(gitRead(['ls-files', '--deleted', '--', ...CANONICAL_GENERATED_OUTPUT_PATHS])),
    ...names(gitRead(['diff', '--cached', '--diff-filter=D', '--name-only', '--', ...CANONICAL_GENERATED_OUTPUT_PATHS])),
  ])];
  const changed = [...new Set([
    ...names(gitRead(['diff', '--name-only', '--', '.'])),
    ...names(gitRead(['diff', '--cached', '--name-only', '--', '.'])),
    ...names(gitRead(['ls-files', '--others', '--exclude-standard'])),
    ...deleted,
  ])];
  return { changed, deleted };
}

function fetchRemoteBranch() {
  gitOk([
    'fetch',
    '--no-tags',
    'origin',
    `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
  ]);
}

function names(output) {
  return output ? output.split('\n').map((line) => line.trim()).filter(Boolean) : [];
}

function gitRead(args) {
  const result = run('git', args, { allowFailure: true });
  if (result.status !== 0) {
    fail(`git ${args.join(' ')} failed: ${detail(result)}`);
  }
  return result.stdout.trim();
}

function gitOk(args) {
  return runOk('git', args).stdout.trim();
}

function runOk(bin, args) {
  const result = run(bin, args, { allowFailure: true });
  if (result.status !== 0) {
    fail(`${bin} ${args.join(' ')} failed: ${detail(result)}`);
  }
  return result;
}

function run(bin, args, { allowFailure = false } = {}) {
  const result = spawnSync(bin, args, {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error && !allowFailure) {
    fail(`${bin} ${args.join(' ')} failed to start: ${result.error.message}`);
  }
  return result;
}

function detail(result) {
  return String(result.error?.message || result.stderr || result.stdout || 'unknown error').trim().slice(-4000);
}

function fail(message) {
  console.error(`generated-userscript-sync: ${message}`);
  process.exit(1);
}
