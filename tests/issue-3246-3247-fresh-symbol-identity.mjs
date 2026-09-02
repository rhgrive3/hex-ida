import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resetSymbolCounterForTesting,
  createFreshSymbol,
  restoreFreshSymbol,
} from '../js/symbolic/expr/factory.js';
import { computeStructuralHash, structuralEquals } from '../js/symbolic/expr/hash.js';
import { exprToPlain, plainToExpr, serializeExprDag, deserializeExprDag } from '../js/symbolic/expr/serialize.js';
import { boolSort, bvSort } from '../js/symbolic/expr/kinds.js';

test('#3246 same-name fresh symbols keep distinct structural identity', () => {
  resetSymbolCounterForTesting(0);
  const a = createFreshSymbol(boolSort(), 'x');
  const b = createFreshSymbol(boolSort(), 'x');
  assert.notEqual(a.symbolId, b.symbolId);
  assert.notEqual(computeStructuralHash(a), computeStructuralHash(b));
  assert.equal(structuralEquals(a, b), false);
  assert.equal(structuralEquals(a, a), true);
  assert.equal(computeStructuralHash(a), computeStructuralHash(a), 'hash is stable per node');
});

test('#3246 different-name symbols were and remain distinct', () => {
  resetSymbolCounterForTesting(0);
  const a = createFreshSymbol(bvSort(8), 'a');
  const b = createFreshSymbol(bvSort(8), 'b');
  assert.notEqual(computeStructuralHash(a), computeStructuralHash(b));
  assert.equal(structuralEquals(a, b), false);
});

test('#3247 plainToExpr restores the saved symbolId', () => {
  resetSymbolCounterForTesting(0);
  const x = createFreshSymbol(boolSort(), 'x');
  const plain = exprToPlain(x);
  createFreshSymbol(boolSort(), 'other'); // advance the counter
  const roundTrip = plainToExpr(plain);
  assert.equal(roundTrip.symbolId, plain.symbolId);
  assert.equal(roundTrip.symbolId, x.symbolId);
});

test('#3247 full DAG serialize/deserialize round-trip preserves symbol identity', () => {
  resetSymbolCounterForTesting(0);
  const x = createFreshSymbol(bvSort(16), 'x');
  const json = serializeExprDag(x);
  createFreshSymbol(bvSort(16), 'noise1');
  createFreshSymbol(bvSort(16), 'noise2');
  const restored = deserializeExprDag(json);
  assert.equal(restored.symbolId, x.symbolId);
  assert.equal(structuralEquals(x, restored), true);
  assert.equal(computeStructuralHash(x), computeStructuralHash(restored));
});

test('#3247 externally restored ids advance the allocator', () => {
  resetSymbolCounterForTesting(0);
  const restored = plainToExpr({
    kind: 'fresh_symbol',
    name: 'a',
    symbolId: 'sym_41_a',
    sort: { kind: 'bool' },
    meta: {},
  });
  assert.equal(restored.symbolId, 'sym_41_a');
  const next = createFreshSymbol(boolSort(), 'b');
  assert.equal(next.symbolId, 'sym_42_b');
});

test('#3247 restoreFreshSymbol rejects malformed ids and non-strings', () => {
  assert.throws(() => restoreFreshSymbol(boolSort(), 'x', 42), /symbolId must be a string/);
  assert.throws(() => restoreFreshSymbol(boolSort(), 'x', 'totally-custom'), /malformed symbolId/);
  assert.throws(() => restoreFreshSymbol(boolSort(), '', 'sym_1_x'), /name must be a non-empty string/);
});

test('#3247 plainToExpr rejects present non-string symbol ids', () => {
  const base = { kind: 'fresh_symbol', name: 'x', sort: { kind: 'bool' }, meta: {} };
  for (const symbolId of [42, null, { id: 'sym_1_x' }, ['sym_1_x']]) {
    assert.throws(() => plainToExpr({ ...base, symbolId }), /fresh symbolId must be a string/);
  }
});

test('#3247 legacy serialized payloads without symbolId still re-allocate', () => {
  const plain = { kind: 'fresh_symbol', name: 'legacy', sort: { kind: 'bool' }, meta: {} };
  const node = plainToExpr(plain);
  assert.equal(typeof node.symbolId, 'string');
  assert.match(node.symbolId, /^sym_\d+_legacy$/);
});