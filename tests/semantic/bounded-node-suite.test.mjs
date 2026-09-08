import assert from 'node:assert/strict';

import {
  resolveBoundedNodeConcurrency,
  runBoundedNodeSuite,
  scheduleNodeTestFiles,
} from '../support/bounded-node-suite.mjs';
import { phase3SchedulingPriority } from '../support/semantic-corpus-manifest.mjs';

assert.equal(resolveBoundedNodeConcurrency({ env: {}, availableParallelism: 1 }), 1);
assert.equal(resolveBoundedNodeConcurrency({ env: {}, availableParallelism: 4 }), 3);
assert.equal(resolveBoundedNodeConcurrency({ env: {}, availableParallelism: 4, reserveCores: 0 }), 4);
assert.equal(resolveBoundedNodeConcurrency({ env: {}, availableParallelism: 32 }), 4);
assert.equal(resolveBoundedNodeConcurrency({
  env: { HEX_SEMANTIC_TEST_CONCURRENCY: '2' },
  envName: 'HEX_SEMANTIC_TEST_CONCURRENCY',
  availableParallelism: 32,
}), 2);
assert.equal(resolveBoundedNodeConcurrency({
  env: { HEX_SEMANTIC_TEST_CONCURRENCY: '99' },
  envName: 'HEX_SEMANTIC_TEST_CONCURRENCY',
  availableParallelism: 32,
}), 16);

{
  const files = ['/tmp/a.mjs', '/tmp/b.mjs', '/tmp/c.mjs'];
  const scheduled = scheduleNodeTestFiles(files, (file) => ({
    '/tmp/a.mjs': 4,
    '/tmp/b.mjs': 1,
    '/tmp/c.mjs': 9,
  })[file]);
  assert.deepEqual(scheduled.map((item) => item.file), ['/tmp/c.mjs', '/tmp/a.mjs', '/tmp/b.mjs']);
  assert.deepEqual(scheduled.map((item) => item.index), [2, 0, 1],
    'launch priority must retain canonical result indexes');
  assert.equal(phase3SchedulingPriority('/repo/tests/compiler-truth/run.mjs'), 100);
  assert.equal(phase3SchedulingPriority('tests/objc-metadata.mjs'), 0);
}

{
  let active = 0;
  let maxActive = 0;
  const seen = [];
  const result = await runBoundedNodeSuite({
    label: 'semantic-contract',
    files: ['/tmp/a.mjs', '/tmp/b.mjs', '/tmp/c.mjs', '/tmp/d.mjs'],
    cwd: '/tmp',
    env: { HEX_SEMANTIC_TEST_CONCURRENCY: '2' },
    envName: 'HEX_SEMANTIC_TEST_CONCURRENCY',
    stdout: { write() {} },
    stderr: { write() {} },
    runCommand: async ({ args }) => {
      active++;
      maxActive = Math.max(maxActive, active);
      seen.push(args[0]);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return { ok: true, status: 0 };
    },
    availableParallelism: 8,
  });
  assert.equal(result.total, 4);
  assert.equal(result.concurrency, 2);
  assert.equal(maxActive, 2);
  assert.deepEqual(new Set(seen), new Set(['/tmp/a.mjs', '/tmp/b.mjs', '/tmp/c.mjs', '/tmp/d.mjs']));
}

{
  const seen = [];
  const result = await runBoundedNodeSuite({
    label: 'semantic-priority-contract',
    files: ['/tmp/a.mjs', '/tmp/b.mjs', '/tmp/c.mjs'],
    cwd: '/tmp',
    env: { HEX_SEMANTIC_TEST_CONCURRENCY: '1' },
    envName: 'HEX_SEMANTIC_TEST_CONCURRENCY',
    priorityForFile: (file) => file.endsWith('/c.mjs') ? 10 : file.endsWith('/a.mjs') ? 5 : 0,
    stdout: { write() {} },
    stderr: { write() {} },
    runCommand: async ({ args }) => {
      seen.push(args[0]);
      return { ok: true, status: 0 };
    },
    availableParallelism: 8,
  });
  assert.equal(result.total, 3);
  assert.deepEqual(seen, ['/tmp/c.mjs', '/tmp/a.mjs', '/tmp/b.mjs'],
    'bounded pool should start highest-cost files first when diagnostics are not verbose');
}

{
  const seen = [];
  await assert.rejects(runBoundedNodeSuite({
    label: 'semantic-fail-closed',
    files: ['/tmp/a.mjs', '/tmp/b.mjs', '/tmp/c.mjs'],
    cwd: '/tmp',
    env: { HEX_SEMANTIC_TEST_CONCURRENCY: '2' },
    envName: 'HEX_SEMANTIC_TEST_CONCURRENCY',
    stdout: { write() {} },
    stderr: { write() {} },
    runCommand: async ({ args }) => {
      seen.push(args[0]);
      if (args[0].endsWith('/b.mjs')) throw new Error('synthetic spawn failure');
      return { ok: true, status: 0 };
    },
    availableParallelism: 8,
  }), /1\/3 test files failed/);
  assert.deepEqual(new Set(seen), new Set(['/tmp/a.mjs', '/tmp/b.mjs', '/tmp/c.mjs']));
}

{
  const seen = [];
  const result = await runBoundedNodeSuite({
    label: 'semantic-verbose-contract',
    files: ['/tmp/a.mjs', '/tmp/b.mjs'],
    cwd: '/tmp',
    env: { HEX_TEST_OUTPUT: 'verbose', HEX_SEMANTIC_TEST_CONCURRENCY: '8' },
    envName: 'HEX_SEMANTIC_TEST_CONCURRENCY',
    priorityForFile: (file) => file.endsWith('/b.mjs') ? 100 : 0,
    stdout: { write() {} },
    stderr: { write() {} },
    runCommand: async ({ args }) => {
      seen.push(args[0]);
      return { ok: true, status: 0 };
    },
    availableParallelism: 8,
  });
  assert.equal(result.concurrency, 1, 'verbose diagnostics stay serial and readable');
  assert.deepEqual(seen, ['/tmp/a.mjs', '/tmp/b.mjs'],
    'verbose serial diagnostics retain canonical file order');
}

console.log('bounded semantic node suite contract: PASS');
