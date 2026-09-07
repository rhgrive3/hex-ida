import assert from 'node:assert/strict';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const root = resolve('.');
const config = readFileSync(join(root, '.circleci', 'config.yml'), 'utf8');

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function extractCommand(jobName) {
  const job = config.indexOf(`name: ${jobName}`);
  assert.notEqual(job, -1, `CircleCI job is missing: ${jobName}`);
  const marker = config.indexOf('command: |', job);
  assert.notEqual(marker, -1, `CircleCI command is missing: ${jobName}`);
  const firstLine = config.indexOf('\n', marker) + 1;
  const lines = config.slice(firstLine).split('\n');
  const body = [];
  for (const line of lines) {
    if (line && !line.startsWith('            ')) break;
    body.push(line ? line.slice(12) : '');
  }
  assert.match(body.join('\n'), /OWNERSHIP_BASE_SHA/);
  assert.match(body.join('\n'), /OWNERSHIP_HEAD_SHA/);
  return body.join('\n');
}

function write(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}

function run(command, repo, branch, phase, baseSha, headSha) {
  const result = spawnSync('bash', ['-c', command], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      CIRCLE_BRANCH: branch,
      [`RUN_PHASE${phase}_OWNERSHIP`]: 'true',
      OWNERSHIP_BASE_SHA: baseSha,
      OWNERSHIP_HEAD_SHA: headSha,
    },
  });
  return result;
}

function aggregateSummary(result, phase) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const line = result.stdout.split('\n').find((item) => item.includes('"aggregate":true'));
  assert.ok(line, `aggregate Phase ${phase} summary is missing: ${result.stdout}`);
  const summary = JSON.parse(line);
  assert.equal(summary.phase, phase);
  assert.equal(summary.aggregate, true);
  assert.equal(summary.changedFiles, 1);
  assert.equal(summary.outsideLaneFiles, 2);
  assert.equal(summary.violations, 0);
  return summary;
}

const scratch = mkdtempSync(join(tmpdir(), 'hex-circleci-ownership-'));
const repo = join(scratch, 'repo');

try {
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'CircleCI ownership test');
  git(repo, 'config', 'user.email', 'circleci-ownership@example.invalid');

  // Keep copies of the canonical validators in the command's module path while
  // the git inventory is synthetic and deliberately contains all three lanes.
  // A symlink would bypass each CLI module's main-module check under Node.
  for (const file of ['phase5-ownership.mjs', 'phase7-ownership.mjs', 'phase8-ownership.mjs']) {
    mkdirSync(join(repo, 'tools', 'validation'), { recursive: true });
    copyFileSync(join(root, 'tools', 'validation', file), join(repo, 'tools', 'validation', file));
  }
  for (const file of ['phase5.json', 'phase7.json', 'phase8.json']) {
    mkdirSync(join(repo, 'tools', 'validation', 'phase-ownership'), { recursive: true });
    copyFileSync(join(root, 'tools', 'validation', 'phase-ownership', file), join(repo, 'tools', 'validation', 'phase-ownership', file));
  }
  write(join(repo, 'README.md'), 'base\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'ownership test base');
  const baseSha = git(repo, 'rev-parse', 'HEAD');

  write(join(repo, 'js', 'analysis', 'phase7-change.js'), 'export const phase7 = true;\n');
  write(join(repo, 'js', 'decompiler', 'phase8-change.js'), 'export const phase8 = true;\n');
  write(join(repo, 'docs', 'other-lane.md'), 'outside the selected lane\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'ownership test mixed batch');
  const headSha = git(repo, 'rev-parse', 'HEAD');

  const phase7 = extractCommand('Validate Phase 7 ownership');
  const phase8 = extractCommand('Validate Phase 8 ownership');

  // The actual aggregate branch route filters the mixed inventory to its own
  // manifest lane and reports the two files assigned to other work.
  const phase7Summary = aggregateSummary(run(phase7, repo, 'perf/development-gate-policy', 7, baseSha, headSha), 7);
  const phase8Summary = aggregateSummary(run(phase8, repo, 'perf/development-gate-policy', 8, baseSha, headSha), 8);
  assert.equal(phase7Summary.baseSha, baseSha);
  assert.equal(phase7Summary.headSha, headSha);
  assert.equal(phase8Summary.baseSha, baseSha);
  assert.equal(phase8Summary.headSha, headSha);

  // A component branch must keep the whole-diff gate: the same mixed batch is
  // rejected because it contains files outside that component's ownership.
  for (const [command, phase, branch] of [
    [phase7, 7, 'component/phase7'],
    [phase8, 8, 'component/phase8'],
  ]) {
    const result = run(command, repo, branch, phase, baseSha, headSha);
    assert.notEqual(result.status, 0, `component Phase ${phase} accepted a mixed inventory`);
    assert.match(`${result.stdout}\n${result.stderr}`, /outside-lane/);
  }

  console.log('circleci ownership aggregate routing: PASS');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
