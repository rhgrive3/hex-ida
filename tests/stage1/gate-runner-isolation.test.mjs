import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runIsolatedGateBatch } from '../../tools/validation/stage1/run-gates-isolated.mjs';

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'stage1-gate-runner-test-'));
const runGit = (...args) => {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

try {
  runGit('init', '-q');
  runGit('config', 'user.email', 'stage1-test@example.invalid');
  runGit('config', 'user.name', 'Stage1 Test');
  fs.writeFileSync(path.join(repo, 'seed.txt'), 'seed\n');
  runGit('add', 'seed.txt');
  runGit('commit', '-qm', 'seed');
  const head = runGit('rev-parse', 'HEAD');
  const command = (text, exitCode = 0) => ({
    bin: process.execPath,
    args: ['-e', `require('fs').writeFileSync('shared.txt', ${JSON.stringify(text)}); process.exit(${exitCode})`],
  });
  const gates = [
    { id: 'T1', name: 'first', evidence: ['seed.txt'], commands: [command('first')] },
    { id: 'T2', name: 'second', evidence: ['seed.txt'], commands: [command('second')] },
    { id: 'T3', name: 'failure', evidence: ['seed.txt'], commands: [command('failed', 7)] },
  ];

  const results = await runIsolatedGateBatch({ repositoryRoot: repo, headSha: head, gates, concurrency: 2 });
  assert.deepEqual(results.map((gate) => gate.id), ['T1', 'T2', 'T3'], 'result ordering must stay deterministic');
  assert.deepEqual(results.map((gate) => gate.status), ['passed', 'passed', 'failed'], 'child failure must remain fail-closed');
  assert.equal(results[2].commands[0].exitCode, 7);
  assert.equal(fs.existsSync(path.join(repo, 'shared.txt')), false, 'gate writes must never leak into the verifier worktree');
  const worktreeList = runGit('worktree', 'list', '--porcelain');
  assert.equal((worktreeList.match(/^worktree /gm) || []).length, 1, 'temporary gate worktrees must be removed');
  assert.equal(runGit('status', '--porcelain'), '', 'source repository must remain clean');
} finally {
  fs.rmSync(repo, { recursive: true, force: true });
}

console.log('stage1 isolated gate runner: PASS');
