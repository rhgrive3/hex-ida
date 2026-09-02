import test from 'node:test';
import assert from 'node:assert/strict';

import { functionPaths, minimalCausalPath } from '../js/query/causal.js';

function programWithChain() {
  const callees = new Map([
    [100n, [{ addr: 200n }]],
    [200n, [{ addr: 300n }]],
  ]);
  return {
    graphCompleteness: { callsComplete: true },
    functionRange: () => ({ start: 0n, end: 16n }),
    calleesOf: (addr) => callees.get(addr) || [],
  };
}

test('#3189 structured options fail closed to fallback budgets', () => {
  const program = programWithChain();
  const coerced = functionPaths(program, 100n, 300n, { maxDepth: ['1'], maxPaths: ['2'], maxVisited: ['16'] });
  assert.ok(coerced.paths.length >= 1, 'fallback depth still finds the chain');
  assert.deepEqual(coerced.paths[0], [100n, 200n, 300n]);
  assert.equal(coerced.truncated, false);
});

test('#3189 numeric strings and truthy booleans are not budget authority', () => {
  const program = programWithChain();
  const strict = functionPaths(program, 100n, 300n, { maxDepth: '1' });
  assert.deepEqual(strict.paths[0], [100n, 200n, 300n], 'numeric string maxDepth falls back');
  assert.deepEqual(
    functionPaths(program, 100n, 300n, { maxPaths: true }).paths[0],
    [100n, 200n, 300n],
  );
});

test('#3189 real numbers keep floor/clamp semantics', () => {
  const program = programWithChain();
  const floored = functionPaths(program, 100n, 300n, { maxDepth: 3.5, maxPaths: 4.7 });
  assert.deepEqual(floored.paths[0], [100n, 200n, 300n], '3.5 floors to 3 and reaches the sink');
  const floorShort = functionPaths(program, 100n, 300n, { maxDepth: 2.9 });
  assert.equal(floorShort.paths.length, 0, '2.9 floors to 2 and cannot reach the sink');
});

test('#3189 minimalCausalPath structured limit falls back', () => {
  const fakeIr = { startAddress: 0n };
  const out = minimalCausalPath(fakeIr, { row: 1 }, { limit: ['2'] });
  assert.equal(out.engine, 'semantic-ir');
  assert.ok(Array.isArray(out.nodes));
});
