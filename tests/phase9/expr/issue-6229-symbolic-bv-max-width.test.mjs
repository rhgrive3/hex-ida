import test from 'node:test';
import assert from 'node:assert/strict';
import { bvSort, MAX_BV_WIDTH, SORT_KIND } from '../../../js/symbolic/expr/kinds.js';
import {
  mask,
  wrap,
  bvAdd,
  bvUdiv,
  bvSdiv,
  bvShl,
  bvConcat,
  bvTrunc,
  bvZext,
} from '../../../js/symbolic/expr/bitvector.js';
import { deserializeExprDag } from '../../../js/symbolic/expr/serialize.js';

test('issue #6229: supported standard widths remain valid', () => {
  for (const w of [1, 8, 16, 32, 64, 128, 256, 512, 4096, MAX_BV_WIDTH]) {
    const sort = bvSort(w);
    assert.equal(sort.kind, SORT_KIND.BV);
    assert.equal(sort.width, w);
  }
});

test('issue #6229: widths exceeding MAX_BV_WIDTH fail fast with RangeError', () => {
  assert.throws(() => bvSort(MAX_BV_WIDTH + 1), RangeError);
  assert.throws(() => bvSort(Number.MAX_SAFE_INTEGER), RangeError);
  assert.throws(() => mask(MAX_BV_WIDTH + 1), RangeError);
  assert.throws(() => mask(Number.MAX_SAFE_INTEGER), RangeError);
  assert.throws(() => wrap(1n, MAX_BV_WIDTH + 1), RangeError);
});

test('issue #6229: operations at MAX_BV_WIDTH succeed without engine BigInt overflow', () => {
  const m = mask(MAX_BV_WIDTH);
  assert.ok(typeof m === 'bigint');
  assert.equal(bvAdd(1n, 2n, MAX_BV_WIDTH), 3n);
  assert.equal(bvUdiv(1n, 0n, MAX_BV_WIDTH), m);
  assert.equal(bvSdiv(1n, 0n, MAX_BV_WIDTH), m);
  assert.equal(bvShl(1n, 10n, MAX_BV_WIDTH), 1024n);
});

test('issue #6229: serialized DAG with oversized width fails fast on deserialize', () => {
  const dag = {
    schemaVersion: '1.0.0',
    expressionDagVersion: '1.0.0',
    root: {
      kind: 'const',
      sort: { kind: 'bv', width: Number.MAX_SAFE_INTEGER },
      value: '0x1',
    },
  };
  assert.throws(() => deserializeExprDag(dag), RangeError);
});
