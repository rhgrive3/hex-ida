import test from 'node:test';
import assert from 'node:assert/strict';

import {
  plainToExpr,
  serializeExprDag,
  deserializeExprDag,
} from '../js/symbolic/expr/serialize.js';
import {
  resetSymbolCounterForTesting,
  createFreshSymbol,
} from '../js/symbolic/expr/factory.js';
import { boolSort, bvSort } from '../js/symbolic/expr/kinds.js';

const LAST_RESERVABLE = Number.MAX_SAFE_INTEGER - 1;

function freshNode(name, symbolId, sort = { kind: 'bool' }) {
  return { kind: 'fresh_symbol', sort, name, symbolId, meta: {} };
}

test('#5149 failed deserialize after a valid canonical id leaves the allocator where it was', () => {
  resetSymbolCounterForTesting(0);
  try {
    assert.throws(
      () => plainToExpr({
        kind: 'connective',
        sort: { kind: 'bool' },
        op: 'and',
        args: [freshNode('a', 'sym_50_a'), freshNode('b', 'definitely-malformed')],
      }),
      /malformed symbolId/,
    );
    const next = createFreshSymbol(boolSort(), 'next');
    assert.equal(next.symbolId, 'sym_1_next', 'allocator must not have advanced past a failed deserialize');
  } finally {
    resetSymbolCounterForTesting(0);
  }
});

test('#5149 minimal repro: sym_MAX + malformed sibling does not exhaust the id space', () => {
  resetSymbolCounterForTesting(0);
  try {
    assert.throws(
      () => plainToExpr({
        kind: 'connective',
        sort: { kind: 'bool' },
        op: 'and',
        args: [freshNode('x', `sym_${LAST_RESERVABLE}_x`), freshNode('y', 'definitely-malformed')],
      }),
      /malformed symbolId/,
    );
    const after = createFreshSymbol(boolSort(), 'after');
    assert.equal(after.symbolId, 'sym_1_after');
  } finally {
    resetSymbolCounterForTesting(0);
  }
});

test('#5149 deserialize that fails during materialization (after reserve) is rolled back', () => {
  resetSymbolCounterForTesting(0);
  try {
    assert.throws(
      () => plainToExpr({
        kind: 'connective',
        sort: { kind: 'bool' },
        op: 'and',
        args: [
          freshNode('a', 'sym_70_a'),
          { kind: 'const', sort: { kind: 'bool' }, value: 'not-a-boolean' },
        ],
      }),
      /Bool const value must be a boolean/,
    );
    const next = createFreshSymbol(boolSort(), 'next');
    assert.equal(next.symbolId, 'sym_1_next', 'reserve-pass advancement must be undone on mid-flight throw');
  } finally {
    resetSymbolCounterForTesting(0);
  }
});

test('#5149 malformed canonical symbolId still fails closed and leaves no allocator residue', () => {
  resetSymbolCounterForTesting(0);
  try {
    assert.throws(() => plainToExpr(freshNode('x', 'sym_01_x')), /malformed symbolId/);
    assert.throws(() => plainToExpr(freshNode('x', 'sym_9007199254740992_x')), /malformed symbolId/);
    const next = createFreshSymbol(boolSort(), 'next');
    assert.equal(next.symbolId, 'sym_1_next');
  } finally {
    resetSymbolCounterForTesting(0);
  }
});

test('#5149 fully valid canonical payload still advances the allocator past restored ids', () => {
  resetSymbolCounterForTesting(0);
  try {
    const restored = plainToExpr(freshNode('a', 'sym_41_a'));
    assert.equal(restored.symbolId, 'sym_41_a');
    const next = createFreshSymbol(boolSort(), 'b');
    assert.equal(next.symbolId, 'sym_42_b');
  } finally {
    resetSymbolCounterForTesting(0);
  }
});

test('#5149 legacy blank id still cannot collide with a later canonical id', () => {
  resetSymbolCounterForTesting(0);
  try {
    const mixed = plainToExpr({
      kind: 'binary',
      sort: { kind: 'bv', width: 8 },
      op: 'add',
      left: freshNode('x', '', { kind: 'bv', width: 8 }),
      right: freshNode('x', 'sym_1_x', { kind: 'bv', width: 8 }),
    });
    assert.equal(mixed.right.symbolId, 'sym_1_x', 'canonical payload identity unchanged');
    assert.equal(mixed.left.symbolId, 'sym_2_x', 'legacy replacement must allocate after reserved canonical ids');
    assert.notEqual(mixed.left.symbolId, mixed.right.symbolId);
  } finally {
    resetSymbolCounterForTesting(0);
  }
});

test('#5149 deep nested trees keep transactional allocator semantics', () => {
  resetSymbolCounterForTesting(0);
  try {
    const deep = {
      kind: 'ite',
      sort: { kind: 'bv', width: 8 },
      cond: freshNode('c', 'sym_200_c', { kind: 'bool' }),
      thenExpr: {
        kind: 'concat',
        sort: { kind: 'bv', width: 16 },
        left: freshNode('l', 'sym_300_l', { kind: 'bv', width: 8 }),
        right: freshNode('r', 'sym_400_r', { kind: 'bv', width: 8 }),
      },
      elseExpr: {
        kind: 'cast',
        sort: { kind: 'bv', width: 8 },
        op: 'zext',
        targetWidth: 8,
        arg: freshNode('bad', 'sym_not_a_number_bad', { kind: 'bv', width: 4 }),
      },
    };
    assert.throws(() => plainToExpr(deep), /malformed symbolId/);
    const next = createFreshSymbol(bvSort(8), 'next');
    assert.equal(next.symbolId, 'sym_1_next', 'no reservation leak from a failed deep deserialize');
  } finally {
    resetSymbolCounterForTesting(0);
  }
});

test('#5149 deep nested valid tree commits the max restored index on success', () => {
  resetSymbolCounterForTesting(0);
  try {
    const deep = {
      kind: 'ite',
      sort: { kind: 'bv', width: 8 },
      cond: freshNode('c', 'sym_500_c', { kind: 'bool' }),
      thenExpr: freshNode('t', 'sym_700_t', { kind: 'bv', width: 8 }),
      elseExpr: freshNode('e', 'sym_600_e', { kind: 'bv', width: 8 }),
    };
    const expr = plainToExpr(deep);
    assert.equal(expr.thenExpr.symbolId, 'sym_700_t');
    const next = createFreshSymbol(bvSort(8), 'next');
    assert.equal(next.symbolId, 'sym_701_next', 'successful deserialize advances past the maximum restored index');
  } finally {
    resetSymbolCounterForTesting(0);
  }
});

test('#5149 deserializeExprDag wrapper inherits rollback on malformed payload', () => {
  resetSymbolCounterForTesting(0);
  try {
    assert.throws(
      () => deserializeExprDag({
        schemaVersion: '1.0.0',
        expressionDagVersion: '1.0.0',
        root: {
          kind: 'connective',
          sort: { kind: 'bool' },
          op: 'and',
          args: [freshNode('x', `sym_${LAST_RESERVABLE}_x`), freshNode('y', 'definitely-malformed')],
        },
      }),
      /malformed symbolId/,
    );
    const after = createFreshSymbol(boolSort(), 'after');
    assert.equal(after.symbolId, 'sym_1_after');
  } finally {
    resetSymbolCounterForTesting(0);
  }
});
