import test from 'node:test';
import assert from 'node:assert/strict';

import { boolSort, bvSort } from '../js/symbolic/expr/kinds.js';
import { createUnknownSemantic, restoreFreshSymbol } from '../js/symbolic/expr/factory.js';
import { computeStructuralHash, structuralEquals } from '../js/symbolic/expr/hash.js';
import { serializeExprDag, deserializeExprDag } from '../js/symbolic/expr/serialize.js';

test('#4666 UnknownSemantic nested detail objects are immutable after creation', () => {
  const node = createUnknownSemantic(bvSort(32), 'unsupported', { nested: { code: 'A' }, list: [{ v: 1 }] });

  assert.equal(Object.isFrozen(node.detail), true);
  assert.equal(Object.isFrozen(node.detail.nested), true);
  assert.equal(Object.isFrozen(node.detail.list), true);
  assert.equal(Object.isFrozen(node.detail.list[0]), true);

  assert.throws(() => { node.detail.nested.code = 'B'; }, TypeError);
  assert.throws(() => { node.detail.list[0].v = 2; }, TypeError);
  assert.throws(() => { node.detail.list.push({ v: 3 }); }, TypeError);
  assert.equal(node.detail.nested.code, 'A');
  assert.deepEqual(node.detail.list, [{ v: 1 }]);
});

test('#4666 nested detail mutation cannot desynchronize structural hash and equality', () => {
  const a = createUnknownSemantic(bvSort(32), 'unsupported', { nested: { code: 'A' } });
  const h1 = computeStructuralHash(a);

  assert.throws(() => { a.detail.nested.code = 'B'; }, TypeError);

  const b = createUnknownSemantic(bvSort(32), 'unsupported', { nested: { code: 'B' } });
  assert.equal(structuralEquals(a, b), false);
  assert.notEqual(computeStructuralHash(a), computeStructuralHash(b));
  assert.equal(computeStructuralHash(a), h1);

  const aAgain = createUnknownSemantic(bvSort(32), 'unsupported', { nested: { code: 'A' } });
  assert.equal(structuralEquals(a, aAgain), true);
  assert.equal(computeStructuralHash(a), computeStructuralHash(aAgain));
});

test('#4666 structural hash is independent of first-call order', () => {
  const x = createUnknownSemantic(boolSort(), 'r', { nested: { deep: [1, { k: 'v' }] } });
  const y = createUnknownSemantic(boolSort(), 'r', { nested: { deep: [1, { k: 'v' }] } });

  const hashYFirst = computeStructuralHash(y);
  const hashX = computeStructuralHash(x);
  const hashYAgain = computeStructuralHash(y);

  assert.equal(hashX, hashYFirst);
  assert.equal(hashYAgain, hashYFirst);
});

test('#4666 deserialized UnknownSemantic detail is deep immutable too', () => {
  const original = createUnknownSemantic(bvSort(8), 'unsupported-instruction-add', { nested: { code: 'A' } });
  const restored = deserializeExprDag(serializeExprDag(original));

  assert.equal(Object.isFrozen(restored.detail.nested), true);
  assert.throws(() => { restored.detail.nested.code = 'Z'; }, TypeError);
  assert.equal(computeStructuralHash(restored), computeStructuralHash(original));
});

test('#4666 normal UnknownSemantic detail semantics are preserved', () => {
  const nullDetail = createUnknownSemantic(bvSort(8), 'missing');
  assert.equal(nullDetail.detail, null);
  assert.equal(typeof computeStructuralHash(nullDetail), 'string');

  const scalar = createUnknownSemantic(bvSort(8), 'r', 'text');
  assert.equal(scalar.detail, 'text');

  const clone = createUnknownSemantic(bvSort(8), 'r', { a: 1 });
  const mutableInput = { a: 1 };
  const fromMutable = createUnknownSemantic(bvSort(8), 'r', mutableInput);
  mutableInput.a = 2;
  assert.equal(fromMutable.detail.a, 1);
  assert.equal(structuralEquals(clone, fromMutable), true);

  const nested = createUnknownSemantic(bvSort(8), 'r', { n: undefined, f: () => {}, s: 'ok' });
  assert.deepEqual(Object.keys(nested.detail), ['s']);
});

test('#4666 cyclic detail keeps the existing fail-closed validation policy', () => {
  const cyclic = { code: 'A' };
  cyclic.self = cyclic;
  assert.throws(
    () => createUnknownSemantic(bvSort(32), 'unsupported', cyclic),
    TypeError,
  );
});

test('#4666 FreshSymbol non-structural meta contract is unchanged', () => {
  const sym = restoreFreshSymbol(bvSort(32), 'metaContract', 'sym_900001_metaContract', { ui: { label: 'x' } });
  assert.equal(Object.isFrozen(sym.meta), true);
  assert.throws(() => { sym.meta.other = 1; }, TypeError);

  const other = restoreFreshSymbol(bvSort(32), 'metaContract', 'sym_900001_metaContract', { ui: { label: 'different' } });
  assert.equal(structuralEquals(sym, other), true);
  assert.equal(computeStructuralHash(sym), computeStructuralHash(other));
});
