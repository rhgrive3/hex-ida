import assert from 'node:assert/strict';
import test from 'node:test';

import { OP } from '../../../js/ir-base.js';
import { backwardDependencySlice } from '../../../js/symbolic/translate/slice.js';

const leaf = { id: 'v0', const: 1n, origin: '0x1000' };
const inst1 = { id: 'i1', op: OP.BIN, subOp: 'add', args: [{ value: leaf }], origin: '0x1004' };
const middle = { id: 'v1', def: inst1, origin: '0x1004' };
const inst2 = { id: 'i2', op: OP.BIN, subOp: 'add', args: [{ value: middle }], origin: '0x1008' };
const target = { id: 'v2', def: inst2, origin: '0x1008' };

test('slice maxDepth accepts only primitive finite numeric authority', () => {
  assert.equal(
    backwardDependencySlice(target, { maxDepth: 1 }).hitDepthLimit,
    true,
    'finite primitive number must retain its existing depth-bound behavior',
  );
  assert.equal(
    backwardDependencySlice(target, { maxDepth: 0 }).hitDepthLimit,
    true,
    'explicit zero must remain the strictest finite depth bound',
  );

  for (const malformed of [['1'], '1', { valueOf: () => 1 }, Infinity, -Infinity, NaN]) {
    assert.equal(
      backwardDependencySlice(target, { maxDepth: malformed }).hitDepthLimit,
      false,
      `non-authoritative maxDepth must fall back to the default: ${String(malformed)}`,
    );
  }
});
