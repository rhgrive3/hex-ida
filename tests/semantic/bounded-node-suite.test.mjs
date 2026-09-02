import assert from 'node:assert/strict';

import {
  resolveBoundedNodeConcurrency,
  runBoundedNodeSuite,
} from '../support/bounded-node-suite.mjs';

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
  const result = await runBoundedNodeSuite({
    label: 'semantic-verbose-contract',
    files: ['/tmp/a.mjs', '/tmp/b.mjs'],
    cwd: '/tmp',
    env: { HEX_TEST_OUTPUT: 'verbose', HEX_SEMANTIC_TEST_CONCURRENCY: '8' },
    envName: 'HEX_SEMANTIC_TEST_CONCURRENCY',
    stdout: { write() {} },
    stderr: { write() {} },
    runCommand: async () => ({ ok: true, status: 0 }),
    availableParallelism: 8,
  });
  assert.equal(result.concurrency, 1, 'verbose diagnostics stay serial and readable');
}

console.log('bounded semantic node suite contract: PASS');
