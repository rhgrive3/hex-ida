import assert from 'node:assert/strict';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const root = resolve('.');

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function write(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}

function runValidator(repo, branch, phase, baseSha, headSha) {
  return spawnSync(process.execPath, [
    `tools/validation/phase${phase}-ownership.mjs`,
    '--base-sha', baseSha,
    '--head-sha', headSha,
  ], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, CIRCLE_BRANCH: branch },
  });
}

function aggregateSummary(result, phase) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const summary = JSON.parse(result.stdout.trim());
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

  const branch = 'perf/development-gate-policy';
  const phase7Summary = aggregateSummary(runValidator(repo, branch, 7, baseSha, headSha), 7);
  const phase8Summary = aggregateSummary(runValidator(repo, branch, 8, baseSha, headSha), 8);
  assert.equal(phase7Summary.baseSha, baseSha);
  assert.equal(phase7Summary.headSha, headSha);
  assert.equal(phase8Summary.baseSha, baseSha);
  assert.equal(phase8Summary.headSha, headSha);

  for (const [phase, componentBranch] of [[7, 'component/phase7'], [8, 'component/phase8']]) {
    const result = runValidator(repo, componentBranch, phase, baseSha, headSha);
    assert.notEqual(result.status, 0, `component Phase ${phase} accepted a mixed inventory`);
    assert.match(`${result.stdout}\n${result.stderr}`, /outside-lane/);
  }

  // Explicit inventories never inherit branch projection: malformed/empty input
  // remains rejected by the canonical validator even on the aggregate branch.
  for (const phase of [7, 8]) {
    for (const inventory of ['[]', '["../outside.js"]']) {
      const result = spawnSync(process.execPath, [
        `tools/validation/phase${phase}-ownership.mjs`, '--files-json', inventory,
      ], {
        cwd: repo,
        encoding: 'utf8',
        env: { ...process.env, CIRCLE_BRANCH: branch },
      });
      assert.notEqual(result.status, 0, `Phase ${phase} accepted invalid explicit inventory ${inventory}`);
    }
  }

  console.log('circleci ownership aggregate routing: PASS');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
