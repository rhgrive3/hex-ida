// Regression for #4666: createUnknownSemantic() JSON-cloned `detail` and froze
// only the top level, so a nested mutation after the first
// computeStructuralHash() call left the WeakMap-cached hash stale while
// structuralEquals() kept re-reading the live detail. Equal expressions could
// then carry different structural hashes.
import assert from 'node:assert/strict';
import test from 'node:test';

import { bvSort, boolSort, BV_BINARY_OP } from '../../../js/symbolic/expr/kinds.js';
import {
  createBv,
  createBinary,
  createFreshSymbol,
  restoreFreshSymbol,
  createUnknownSemantic,
} from '../../../js/symbolic/expr/factory.js';
import { computeStructuralHash, structuralEquals } from '../../../js/symbolic/expr/hash.js';
import { exprToPlain, serializeExprDag, deserializeExprDag } from '../../../js/symbolic/expr/serialize.js';

function nestedDetail(code) {
  return { nested: { code }, frames: [{ code }, { code }] };
}

function attemptMutation(callback) {
  try { callback(); return null; } catch (error) { return error; }
}

test('#4666 UnknownSemantic detail is deep immutable at construction', () => {
  const node = createUnknownSemantic(bvSort(32), 'unsupported', nestedDetail('A'));
  assert.equal(Object.isFrozen(node.detail), true);
  assert.equal(Object.isFrozen(node.detail.nested), true);
  assert.equal(Object.isFrozen(node.detail.frames), true);
  assert.equal(Object.isFrozen(node.detail.frames[0]), true);
  assert.ok(attemptMutation(() => { node.detail.nested.code = 'B'; }) instanceof TypeError);
  assert.ok(attemptMutation(() => { node.detail.frames.push({ code: 'C' }); }) instanceof TypeError);
  assert.ok(attemptMutation(() => { delete node.detail.nested.code; }) instanceof TypeError);
  assert.equal(node.detail.nested.code, 'A');
  assert.equal(node.detail.frames.length, 2);
  assert.equal(node.reason, 'unsupported');

  const frozenInput = nestedDetail('A');
  const fromFrozen = createUnknownSemantic(bvSort(32), 'unsupported', frozenInput);
  assert.notEqual(fromFrozen.detail, frozenInput);
  frozenInput.nested.code = 'mutated after construction';
  assert.equal(fromFrozen.detail.nested.code, 'A');
});

test('#4666 structural hash and equality cannot diverge for UNKNOWN_SEMANTIC', () => {
  const a = createUnknownSemantic(bvSort(32), 'unsupported', nestedDetail('A'));
  const hashBefore = computeStructuralHash(a);
  attemptMutation(() => { a.detail.nested.code = 'B'; });
  assert.equal(computeStructuralHash(a), hashBefore);

  const same = createUnknownSemantic(bvSort(32), 'unsupported', nestedDetail('A'));
  assert.equal(structuralEquals(a, same), true);
  assert.equal(computeStructuralHash(a), computeStructuralHash(same));

  const mutatedTwin = createUnknownSemantic(bvSort(32), 'unsupported', { nested: { code: 'B' }, frames: [{ code: 'B' }, { code: 'B' }] });
  assert.equal(structuralEquals(a, mutatedTwin), false);
  if (structuralEquals(a, mutatedTwin)) assert.equal(computeStructuralHash(a), computeStructuralHash(mutatedTwin));

  const otherReason = createUnknownSemantic(bvSort(32), 'memory', nestedDetail('A'));
  assert.equal(structuralEquals(a, otherReason), false);

  assert.equal(structuralEquals(a, createUnknownSemantic(bvSort(64), 'unsupported', nestedDetail('A'))), false);
  assert.equal(structuralEquals(a, createUnknownSemantic(boolSort(), 'unsupported', nestedDetail('A'))), false);
});

test('#4666 hash does not depend on first-call order or embedding position', () => {
  const left = createUnknownSemantic(bvSort(32), 'unsupported', nestedDetail('A'));
  const right = createUnknownSemantic(bvSort(32), 'unsupported', nestedDetail('A'));
  const leftWrapped = createBinary(BV_BINARY_OP.ADD, left, createBv(32, 1));
  const rightWrapped = createBinary(BV_BINARY_OP.ADD, createBv(32, 1), right);

  const firstOrder = [computeStructuralHash(left), computeStructuralHash(leftWrapped), computeStructuralHash(right), computeStructuralHash(rightWrapped)];
  const secondOrder = [computeStructuralHash(rightWrapped), computeStructuralHash(right), computeStructuralHash(leftWrapped), computeStructuralHash(left)];
  assert.equal(computeStructuralHash(left), computeStructuralHash(right));
  assert.equal(firstOrder[0], firstOrder[2]);
  assert.equal(firstOrder[1] === computeStructuralHash(leftWrapped), true);
  assert.equal(secondOrder[1], firstOrder[2]);
  assert.equal(secondOrder[3], firstOrder[0]);
  assert.notEqual(firstOrder[1], firstOrder[3]);
});

test('#4666 normal UnknownSemantic detail and serialization semantics are preserved', () => {
  const scalar = createUnknownSemantic(bvSort(8), 'unsupported', 'opaque text');
  assert.equal(scalar.detail, 'opaque text');
  assert.equal(createUnknownSemantic(bvSort(8), 'unsupported', null).detail, null);
  assert.equal(createUnknownSemantic(bvSort(8), 'unsupported', undefined).detail, null);
  assert.equal(createUnknownSemantic(bvSort(8), 'unsupported', 0).detail, null);

  const node = createUnknownSemantic(bvSort(32), 'unsupported', nestedDetail('A'));
  const plain = exprToPlain(node);
  assert.deepEqual(plain.detail, node.detail);
  const roundTripped = deserializeExprDag(serializeExprDag(node));
  assert.equal(structuralEquals(node, roundTripped), true);
  assert.equal(computeStructuralHash(node), computeStructuralHash(roundTripped));
  assert.equal(Object.isFrozen(roundTripped.detail.nested), true);

  const shared = nestedDetail('A');
  const first = createUnknownSemantic(bvSort(32), 'unsupported', shared);
  const second = createUnknownSemantic(bvSort(32), 'unsupported', shared);
  assert.notEqual(first.detail, second.detail);
  assert.equal(computeStructuralHash(first), computeStructuralHash(second));
});

test('#4666 cyclic and unserializable detail keep the fail-closed validation policy', () => {
  const cyclic = { nested: {} };
  cyclic.nested.self = cyclic;
  assert.throws(() => createUnknownSemantic(bvSort(32), 'unsupported', cyclic), TypeError);
  assert.throws(() => createUnknownSemantic(bvSort(32), 'unsupported', { value: 1n }), TypeError);
  const dropped = createUnknownSemantic(bvSort(32), 'unsupported', { keep: 1, value: Symbol('x'), fn() {} });
  assert.deepEqual(dropped.detail, { keep: 1 });
  assert.equal(Object.isFrozen(dropped.detail), true);
  assert.throws(() => createUnknownSemantic(bvSort(32), '', { nested: {} }), TypeError);
  assert.throws(() => createUnknownSemantic(null, 'unsupported', { nested: {} }), TypeError);
});

test('#4666 FreshSymbol meta stays non-structural and is not part of identity', () => {
  const symbol = createFreshSymbol(bvSort(32), 'x', { origin: 'loc1', provenance: { row: 10 } });
  const restored = restoreFreshSymbol(bvSort(32), 'x', symbol.symbolId, { origin: 'loc2', provenance: { row: 99 } });
  assert.equal(Object.isFrozen(symbol.meta), true);
  assert.equal(computeStructuralHash(symbol), computeStructuralHash(restored));
  assert.equal(structuralEquals(symbol, restored), true);
  attemptMutation(() => { symbol.meta.provenance.row = 11; });
  assert.equal(computeStructuralHash(symbol), computeStructuralHash(restored));
  assert.equal(structuralEquals(symbol, restored), true);
});
