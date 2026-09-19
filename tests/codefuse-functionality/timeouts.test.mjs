import test from 'node:test';
import assert from 'node:assert/strict';

import { compileSource, linkBinary, validateTimeout } from '../../reports/investigations/codefuse-functionality/harness/compile.mjs';
import { runProgram } from '../../reports/investigations/codefuse-functionality/harness/functionality.mjs';
import { hangingChild } from './helpers.mjs';

test('a compiler that never exits is killed and recorded as a timeout', async () => {
  const started = Date.now();
  const result = await compileSource({
    file: '/tmp/never.c',
    timeoutMs: 1000,
    spawnImpl: () => hangingChild(),
  });
  assert.equal(result.status, 'timeout');
  assert.equal(result.compileSucceeded, false);
  assert.equal(result.objectFile, null);
  assert.match(result.reason, /timeout:1000/);
  assert.ok(Date.now() - started < 5000, 'timeout must be finite');
});

test('a link that never exits is killed and recorded as a timeout', async () => {
  const result = await linkBinary({
    file: '/tmp/never.o',
    out: '/tmp/never.bin',
    timeoutMs: 1000,
    spawnImpl: () => hangingChild(),
  });
  assert.equal(result.status, 'timeout');
  assert.equal(result.linkSucceeded, false);
  assert.equal(result.binary, null);
});

test('program execution has a finite timeout and never hangs the probe', async () => {
  const started = Date.now();
  const run = await runProgram({
    binary: '/tmp/never-run',
    timeoutMs: 150,
    spawnImpl: () => hangingChild(),
  });
  assert.equal(run.timedOut, true);
  assert.equal(run.status, 'timeout');
  assert.ok(Date.now() - started < 5000, 'run timeout must be finite');
});

test('timeout configuration is validated and cannot be unbounded', () => {
  assert.equal(validateTimeout(5000), 5000);
  assert.equal(validateTimeout(undefined, 1000), 1000);
  assert.throws(() => validateTimeout(999), /codefuse-timeout-out-of-range/);
  assert.throws(() => validateTimeout(10_000_000), /codefuse-timeout-out-of-range/);
  assert.throws(() => validateTimeout('nope'), /codefuse-timeout-out-of-range/);
});

test('program run rejects an out-of-range timeout instead of running unbounded', async () => {
  await assert.rejects(
    () => runProgram({ binary: '/tmp/x', timeoutMs: 10, spawnImpl: () => hangingChild() }),
    /codefuse-run-timeout-out-of-range/,
  );
});
