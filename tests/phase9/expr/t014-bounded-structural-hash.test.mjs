import assert from 'node:assert/strict';
import test from 'node:test';

import { bvSort } from '../../../js/symbolic/expr/kinds.js';
import { createBv, createFreshSymbol } from '../../../js/symbolic/expr/factory.js';
import { computeStructuralHash, computeStructuralHashesBounded } from '../../../js/symbolic/expr/hash.js';

test('T014 bounded hashing agrees with canonical hash on a valid DAG', () => {
  const symbol = createFreshSymbol(bvSort(32), 't014_hash_x');
  const result = computeStructuralHashesBounded([symbol], { maxNodes: 8 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.hashes, [computeStructuralHash(symbol)]);
  assert.equal(result.nodeCount, 1);
});

test('T014 bounded hashing fails closed on invalid budgets and malformed roots', () => {
  for (const maxNodes of [0, -1, 1.5, '8', 8n, new Number(8)]) {
    assert.equal(computeStructuralHashesBounded([], { maxNodes }).ok, false);
  }
  assert.equal(computeStructuralHashesBounded([null], { maxNodes: 8 }).reason, 'malformed-expression-node');
});

test('T014 bounded hashing stops before oversized root sets are traversed', () => {
  const roots = Array.from({ length: 3 }, (_, index) => createBv(8, BigInt(index)));
  const result = computeStructuralHashesBounded(roots, { maxNodes: 2 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'expression-node-budget-exceeded');
  assert.equal(result.limitExceeded, true);
});

test('T014 bounded hashing rejects cyclic expression graphs without recursion', () => {
  const node = { kind: 'unary', sort: bvSort(8), op: 'not', arg: null };
  node.arg = node;
  const result = computeStructuralHashesBounded([node], { maxNodes: 8 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'cyclic-expression-dag');
});

test('T014 bounded hashing fails closed on hostile unknown detail accessors and proxies', () => {
  const throwingAccessor = {};
  Object.defineProperty(throwingAccessor, 'x', {
    enumerable: true,
    get() { throw new Error('boom'); },
  });
  const accessorNode = {
    kind: 'unknown_semantic',
    sort: bvSort(8),
    reason: 'hostile-accessor',
    detail: throwingAccessor,
  };
  assert.deepEqual(
    computeStructuralHashesBounded([accessorNode], { maxNodes: 8 }),
    { ok: false, reason: 'malformed-unknown-detail', nodeCount: 1 },
  );

  const throwingProxy = new Proxy({}, {
    ownKeys() { throw new Error('boom'); },
  });
  const proxyNode = {
    kind: 'unknown_semantic',
    sort: bvSort(8),
    reason: 'hostile-proxy',
    detail: throwingProxy,
  };
  assert.deepEqual(
    computeStructuralHashesBounded([proxyNode], { maxNodes: 8 }),
    { ok: false, reason: 'malformed-unknown-detail', nodeCount: 1 },
  );
});
