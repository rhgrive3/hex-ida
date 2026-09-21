import assert from 'node:assert/strict';
import test from 'node:test';

import { parseCheckSteps, runCheckParallel } from '../scripts/run-check-parallel.mjs';

test('mixed top-level && and || remains one serial shell job', () => {
  assert.deepEqual(parseCheckSteps('A || B && C'), ['A || B && C']);
  assert.deepEqual(parseCheckSteps('A && B || C && D'), ['A && B || C && D']);
});

test('quoted, substitution, and grouped || do not force whole-script fallback', () => {
  assert.deepEqual(parseCheckSteps("echo 'x || y' && B"), ["echo 'x || y'", 'B']);
  assert.deepEqual(parseCheckSteps('echo $(false || true) && B'), ['echo $(false || true)', 'B']);
  assert.deepEqual(parseCheckSteps('(A || B) && C'), ['(A || B)', 'C']);
});

test('pure && chain remains independently parallelizable', () => {
  assert.deepEqual(parseCheckSteps('A && B && C'), ['A', 'B', 'C']);
});

test('orchestration does not start C as an independent job for A || B && C', async () => {
  const started = [];
  const runCommand = async (job) => {
    started.push(job.rawCommand);
    return { ok: true, status: 0, signal: null, logPath: null, durationMs: 0 };
  };
  const sink = { write() {} };
  const result = await runCheckParallel({
    checkScript: 'A || B && C',
    runCommand,
    stdout: sink,
    stderr: sink,
    env: { ...process.env, HEX_CHECK_PARALLEL: '4' },
  });
  assert.deepEqual(started, ['A || B && C']);
  assert.equal(result.failures.length, 0);
});
