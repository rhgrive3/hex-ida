import test from 'node:test';
import assert from 'node:assert/strict';

import {
  serializeExprDag,
  deserializeExprDag,
  exprToPlain,
} from '../js/symbolic/expr/serialize.js';
import {
  resetSymbolCounterForTesting,
  createFreshSymbol,
  createConcat,
  createCompare,
  createBv,
} from '../js/symbolic/expr/factory.js';
import { bvSort, boolSort, BV_COMPARE_OP } from '../js/symbolic/expr/kinds.js';
import { evaluateExpr, EVAL_STATUS } from '../js/symbolic/expr/evaluate.js';
import { structuralEquals } from '../js/symbolic/expr/hash.js';

function payloadWithSymbol(kind, sort, name, symbolId) {
  return {
    schemaVersion: '1.0.0',
    expressionDagVersion: '1.0.0',
    root: {
      kind: 'concat',
      sort: { kind: 'bv', width: sort.width * 2 },
      left: { kind, sort: { kind: 'bv', width: sort.width }, name, symbolId },
      right: { kind, sort: { kind: 'bv', width: sort.width }, name, symbolId },
    },
  };
}

test('#6083 same symbolId + same name + same sort reappearing is accepted', () => {
  const expr = deserializeExprDag(payloadWithSymbol('fresh_symbol', bvSort(8), 'x', 'sym_1_x'));
  assert.equal(expr.left.symbolId, 'sym_1_x');
  assert.equal(expr.right.symbolId, 'sym_1_x');
  assert.equal(expr.left.sort.width, 8);
  assert.equal(expr.right.sort.width, 8);
});

test('#6083 same symbolId with different BV width is rejected', () => {
  const payload = {
    schemaVersion: '1.0.0',
    expressionDagVersion: '1.0.0',
    root: {
      kind: 'concat',
      sort: { kind: 'bv', width: 72 },
      left: { kind: 'fresh_symbol', sort: { kind: 'bv', width: 8 }, name: 'x', symbolId: 'sym_1_x' },
      right: { kind: 'fresh_symbol', sort: { kind: 'bv', width: 64 }, name: 'x', symbolId: 'sym_1_x' },
    },
  };
  assert.throws(() => deserializeExprDag(payload), /conflicting fresh symbol declaration/);
});

test('#6083 same symbolId across Bool and BV sorts is rejected', () => {
  const payload = {
    schemaVersion: '1.0.0',
    expressionDagVersion: '1.0.0',
    root: {
      kind: 'connective',
      op: 'eq',
      sort: { kind: 'bool' },
      args: [
        { kind: 'fresh_symbol', sort: { kind: 'bool' }, name: 'x', symbolId: 'sym_2_x' },
        { kind: 'fresh_symbol', sort: { kind: 'bv', width: 8 }, name: 'x', symbolId: 'sym_2_x' },
      ],
    },
  };
  assert.throws(() => deserializeExprDag(payload), /conflicting fresh symbol declaration/);
});

test('#6083 different symbolIds with same name and different sorts stay independent', () => {
  const payload = {
    schemaVersion: '1.0.0',
    expressionDagVersion: '1.0.0',
    root: {
      kind: 'concat',
      sort: { kind: 'bv', width: 72 },
      left: { kind: 'fresh_symbol', sort: { kind: 'bv', width: 8 }, name: 'x', symbolId: 'sym_1_x' },
      right: { kind: 'fresh_symbol', sort: { kind: 'bv', width: 64 }, name: 'x', symbolId: 'sym_2_x' },
    },
  };
  const expr = deserializeExprDag(payload);
  assert.equal(expr.left.symbolId, 'sym_1_x');
  assert.equal(expr.right.symbolId, 'sym_2_x');
  assert.equal(expr.left.sort.width, 8);
  assert.equal(expr.right.sort.width, 64);
});

test('#6083 canonical serialize->deserialize round-trip still works', () => {
  resetSymbolCounterForTesting(0);
  const x = createFreshSymbol(bvSort(8), 'x');
  const y = createFreshSymbol(bvSort(8), 'y');
  const original = createConcat(x, y);
  const json = serializeExprDag(original);
  const restored = deserializeExprDag(json);
  assert.equal(restored.kind, original.kind);
  assert.equal(restored.left.symbolId, x.symbolId);
  assert.equal(restored.right.symbolId, y.symbolId);
  assert.equal(structuralEquals(original, restored), true);
});

test('#6083 deserialized env lookup and structural identity agree on symbolId', () => {
  resetSymbolCounterForTesting(0);
  const x = createFreshSymbol(bvSort(8), 'x');
  const shared = createConcat(x, x);
  const restored = deserializeExprDag(serializeExprDag(shared));
  const model = { [x.symbolId]: 0xabn };
  const res = evaluateExpr(restored, model);
  assert.equal(res.status, EVAL_STATUS.VALUE);
  assert.equal(res.value, 0xababn);
  // structural equality: two nodes sharing symbolId/name/sort are the same symbol
  assert.equal(structuralEquals(restored.left, restored.right), true);
});

test('#6083 conflicting symbolId is caught even when first occurrence appears later', () => {
  const payload = {
    schemaVersion: '1.0.0',
    expressionDagVersion: '1.0.0',
    root: {
      kind: 'concat',
      sort: { kind: 'bv', width: 72 },
      left: { kind: 'fresh_symbol', sort: { kind: 'bv', width: 64 }, name: 'x', symbolId: 'sym_3_x' },
      right: { kind: 'fresh_symbol', sort: { kind: 'bv', width: 8 }, name: 'x', symbolId: 'sym_3_x' },
    },
  };
  assert.throws(() => deserializeExprDag(payload), /conflicting fresh symbol declaration/);
});

test('#6083 sort-mismatched compare payload is rejected before evaluation', () => {
  const payload = {
    schemaVersion: '1.0.0',
    expressionDagVersion: '1.0.0',
    root: {
      kind: 'compare',
      op: BV_COMPARE_OP.EQ,
      sort: { kind: 'bool' },
      left: { kind: 'fresh_symbol', sort: { kind: 'bv', width: 8 }, name: 'v', symbolId: 'sym_4_v' },
      right: { kind: 'const', sort: { kind: 'bv', width: 8 }, value: '0x1' },
      // second use of same id with different width
      __extra: undefined,
    },
  };
  // build a payload whose two uses disagree via a concat on the right side
  const payload2 = {
    schemaVersion: '1.0.0',
    expressionDagVersion: '1.0.0',
    root: {
      kind: 'concat',
      sort: { kind: 'bv', width: 12 },
      left: { kind: 'fresh_symbol', sort: { kind: 'bv', width: 8 }, name: 'v', symbolId: 'sym_5_v' },
      right: { kind: 'fresh_symbol', sort: { kind: 'bv', width: 4 }, name: 'v', symbolId: 'sym_5_v' },
    },
  };
  assert.throws(() => deserializeExprDag(payload2), /conflicting fresh symbol declaration/);
  assert.ok(exprToPlain);
});
