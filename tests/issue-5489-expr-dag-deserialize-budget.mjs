import assert from 'node:assert/strict';
import test from 'node:test';

import {
  deserializeExprDag,
  serializeExprDag,
  EXPR_DAG_MAX_DEPTH,
} from '../js/symbolic/expr/serialize.js';
import { createBv, createFreshSymbol, createUnary } from '../js/symbolic/expr/factory.js';
import { bvSort } from '../js/symbolic/expr/kinds.js';

function deepPlainUnary(depth) {
  let root = { kind: 'const', sort: { kind: 'bv', width: 8 }, value: '0x2a' };
  for (let i = 0; i < depth; i++) root = { kind: 'unary', op: 'not', sort: { kind: 'bv', width: 8 }, arg: root };
  return root;
}

function deepPlainJson(depth) {
  return JSON.stringify({
    schemaVersion: '1.0.0',
    expressionDagVersion: '1.0.0',
    metadata: {},
    root: deepPlainUnary(depth),
  });
}

test('#5489 deep DAG object must fail as a domain error, not a stack overflow', () => {
  assert.throws(
    () => deserializeExprDag({
      schemaVersion: '1.0.0',
      expressionDagVersion: '1.0.0',
      metadata: {},
      root: deepPlainUnary(50_000),
    }),
    (error) => error instanceof TypeError && /depth budget exceeded/.test(error.message),
    'depth-50k DAG must be rejected with the explicit budget error',
  );
});

test('#5489 deep DAG JSON text must be rejected before native JSON.parse overflows', () => {
  // JSON.stringify itself cannot always produce 5k-deep text; the depth here
  // stays in the range where the text is producible but the budget is exceeded.
  const depth = Math.min(EXPR_DAG_MAX_DEPTH + 64, 2000);
  assert.throws(
    () => deserializeExprDag(deepPlainJson(depth)),
    (error) => error instanceof TypeError && /depth budget exceeded/.test(error.message),
  );
});

test('#5489 DAG within the budget round-trips byte-identically', () => {
  const sym = createFreshSymbol(bvSort(8), 'x');
  const expr = createUnary('not', createUnary('not', sym));
  const json = serializeExprDag(expr);
  const restored = deserializeExprDag(json);
  assert.equal(serializeExprDag(restored), json);
});

test('#5489 node budget rejects wide DAGs at shallow depth', () => {
  const wide = {
    kind: 'connective',
    op: 'and',
    sort: { kind: 'bool' },
    args: Array.from({ length: 1_048_577 }, () => ({ kind: 'const', sort: { kind: 'bool' }, value: true })),
  };
  assert.throws(
    () => deserializeExprDag({ schemaVersion: '1.0.0', expressionDagVersion: '1.0.0', metadata: {}, root: wide }),
    (error) => error instanceof TypeError && /node budget exceeded/.test(error.message),
  );
});

test('#5489 escape-heavy JSON strings do not trip the nesting scan', () => {
  // Braces inside JSON string escapes must not count as nesting depth: the
  // metadata strings below carry deep brace/bracket runs inside JSON strings.
  const braceRun = '{'.repeat(EXPR_DAG_MAX_DEPTH * 4);
  const json = JSON.stringify({
    schemaVersion: '1.0.0',
    expressionDagVersion: '1.0.0',
    metadata: { note: 'a"{[[{"b', depthProbe: braceRun },
    root: { kind: 'const', sort: { kind: 'bool' }, value: true },
  });
  const restored = deserializeExprDag(json);
  assert.ok(restored, 'escaped braces inside strings must not count as nesting');
});

