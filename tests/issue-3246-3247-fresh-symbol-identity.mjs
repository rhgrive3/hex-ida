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
  for (const symbolId of ['totally-custom', 'sym_01_x', 'sym_0_x', 'sym_1_y', 'sym_9007199254740992_x']) {
    assert.throws(() => restoreFreshSymbol(boolSort(), 'x', symbolId), /malformed symbolId/);
  }
  assert.throws(() => restoreFreshSymbol(boolSort(), '', 'sym_1_x'), /name must be a non-empty string/);
});

test('#3247 allocator fails closed at the safe-integer ceiling', () => {
  resetSymbolCounterForTesting(0);
  try {
    assert.throws(
      () => restoreFreshSymbol(boolSort(), 'x', `sym_${Number.MAX_SAFE_INTEGER}_x`),
      /malformed symbolId/,
    );
    const lastReservable = Number.MAX_SAFE_INTEGER - 1;
    const restored = restoreFreshSymbol(boolSort(), 'x', `sym_${lastReservable}_x`);
    assert.equal(restored.symbolId, `sym_${lastReservable}_x`);
    assert.throws(() => createFreshSymbol(boolSort(), 'next'), /symbol id space exhausted/);
  } finally {
    resetSymbolCounterForTesting(0);
  }
});

test('#3247 plainToExpr rejects present non-string symbol ids', () => {
  const base = { kind: 'fresh_symbol', name: 'x', sort: { kind: 'bool' }, meta: {} };
  for (const symbolId of [42, null, { id: 'sym_1_x' }, ['sym_1_x']]) {
    assert.throws(() => plainToExpr({ ...base, symbolId }), /fresh symbolId must be a string/);
  }
});

test('#3247 blank string symbol ids retain the legacy allocation path', () => {
  resetSymbolCounterForTesting(0);
  const base = { kind: 'fresh_symbol', name: 'legacy', sort: { kind: 'bool' }, meta: {} };
  const empty = plainToExpr({ ...base, symbolId: '' });
  const whitespace = plainToExpr({ ...base, symbolId: '   ' });
  assert.equal(empty.symbolId, 'sym_1_legacy');
  assert.equal(whitespace.symbolId, 'sym_2_legacy');
});

test('#3247 legacy replacement ids cannot collide with later canonical ids', () => {
  resetSymbolCounterForTesting(0);
  const mixed = plainToExpr({
    kind: 'binary',
    sort: { kind: 'bv', width: 8 },
    op: 'add',
    left: { kind: 'fresh_symbol', sort: { kind: 'bv', width: 8 }, name: 'x', symbolId: '', meta: {} },
    right: { kind: 'fresh_symbol', sort: { kind: 'bv', width: 8 }, name: 'x', symbolId: 'sym_1_x', meta: {} },
  });
  assert.equal(mixed.right.symbolId, 'sym_1_x', 'canonical payload identity must remain unchanged');
  assert.equal(mixed.left.symbolId, 'sym_2_x', 'legacy replacement must allocate after reserved canonical ids');
  assert.notEqual(mixed.left.symbolId, mixed.right.symbolId);
});

test('#3247 legacy serialized payloads without symbolId still re-allocate', () => {
  const plain = { kind: 'fresh_symbol', name: 'legacy', sort: { kind: 'bool' }, meta: {} };
  const node = plainToExpr(plain);
  assert.equal(typeof node.symbolId, 'string');
  assert.match(node.symbolId, /^sym_\d+_legacy$/);
});
