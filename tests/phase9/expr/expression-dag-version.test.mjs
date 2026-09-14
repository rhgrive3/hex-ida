import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EXPR_DAG_VERSION,
  EXPR_SCHEMA_VERSION,
  deserializeExprDag,
} from '../../../js/symbolic/expr/serialize.js';

test('deserializeExprDag preserves the canonical current DAG version', () => {
  assert.equal(deserializeExprDag({
    schemaVersion: EXPR_SCHEMA_VERSION,
    expressionDagVersion: EXPR_DAG_VERSION,
    root: null,
  }), null);
});

test('deserializeExprDag rejects unknown or missing expression DAG versions', () => {
  assert.throws(
    () => deserializeExprDag({
      schemaVersion: EXPR_SCHEMA_VERSION,
      expressionDagVersion: '999.0.0',
      root: null,
    }),
    /incompatible expression DAG version/,
  );

  assert.throws(
    () => deserializeExprDag({
      schemaVersion: EXPR_SCHEMA_VERSION,
      root: null,
    }),
    /incompatible expression DAG version/,
  );
});
