import test from 'node:test';
import assert from 'node:assert/strict';
import { boolSort, bvSort } from '../js/symbolic/expr/kinds.js';
import { createUnknownSemantic, createBv } from '../js/symbolic/expr/factory.js';
import { computeStructuralHash, structuralEquals } from '../js/symbolic/expr/hash.js';
import { serializeExprDag, deserializeExprDag } from '../js/symbolic/expr/serialize.js';

test('issue #5035: object key order in detail does not affect structural hash or equality', () => {
  const node1 = createUnknownSemantic(boolSort(), 'unsupported_op', { a: 1, b: 2 });
  const node2 = createUnknownSemantic(boolSort(), 'unsupported_op', { b: 2, a: 1 });

  assert.equal(computeStructuralHash(node1), computeStructuralHash(node2));
  assert.equal(structuralEquals(node1, node2), true);
});

test('issue #5035: serialize -> deserialize round-trip preserves structural hash and equality', () => {
  const before = createUnknownSemantic(boolSort(), 'demo', { b: 2, a: 1 });
  const h1 = computeStructuralHash(before);

  const wire = serializeExprDag(before);
  const after = deserializeExprDag(wire);
  const h2 = computeStructuralHash(after);

  assert.equal(h1, h2);
  assert.equal(structuralEquals(before, after), true);
});

test('issue #5035: nested objects are key-order independent', () => {
  const node1 = createUnknownSemantic(bvSort(32), 'complex', {
    outer: { z: 10, y: 20 },
    flag: true,
  });
  const node2 = createUnknownSemantic(bvSort(32), 'complex', {
    flag: true,
    outer: { y: 20, z: 10 },
  });

  assert.equal(computeStructuralHash(node1), computeStructuralHash(node2));
  assert.equal(structuralEquals(node1, node2), true);
});

test('issue #5035: different values or different array orders remain structurally distinct', () => {
  const nodeA = createUnknownSemantic(boolSort(), 'test', { a: 1 });
  const nodeB = createUnknownSemantic(boolSort(), 'test', { a: 2 });
  assert.notEqual(computeStructuralHash(nodeA), computeStructuralHash(nodeB));
  assert.equal(structuralEquals(nodeA, nodeB), false);

  const nodeArr1 = createUnknownSemantic(boolSort(), 'test', { list: [1, 2] });
  const nodeArr2 = createUnknownSemantic(boolSort(), 'test', { list: [2, 1] });
  assert.notEqual(computeStructuralHash(nodeArr1), computeStructuralHash(nodeArr2));
  assert.equal(structuralEquals(nodeArr1, nodeArr2), false);
});
