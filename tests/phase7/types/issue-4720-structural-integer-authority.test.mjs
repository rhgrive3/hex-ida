import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createHardConstraint,
  createTypeClaim,
} from '../../../js/analysis/types/constraints.js';

function descriptor(field, value) {
  return {
    kind: 'struct',
    [field]: value,
  };
}

function claim(field, value) {
  return createTypeClaim({
    layer: 'structural',
    entityId: `issue-4720-${field}`,
    descriptor: descriptor(field, value),
  });
}

test('issue #4720 accepts only primitive structural integer representations', () => {
  for (const [field, values] of [
    ['offset', [8, 8n, '8']],
    ['sizeBytes', [8, 8n, '8']],
    ['alignBytes', [8, 8n, '8']],
    ['strideBytes', [8, 8n, '8']],
    ['length', [8, 8n, '8']],
  ]) {
    for (const value of values) {
      assert.doesNotThrow(() => claim(field, value), `${field}=${String(value)} should remain valid`);
    }
  }
});

test('issue #4720 rejects structured values before they become hard layout evidence', () => {
  const malformed = [
    ['8'],
    { valueOf() { return 8; } },
    { toString() { return '8'; } },
    true,
    new Number(8),
  ];
  const fields = [
    ['offset', 'structural-offset-invalid'],
    ['sizeBytes', 'structural-size-invalid'],
    ['alignBytes', 'structural-align-invalid'],
    ['strideBytes', 'structural-stride-invalid'],
    ['length', 'structural-length-invalid'],
  ];

  for (const [field, code] of fields) {
    for (const value of malformed) {
      assert.throws(
        () => claim(field, value),
        new RegExp(code),
        `${field} must reject structured value ${Object.prototype.toString.call(value)}`,
      );
      assert.throws(
        () => createHardConstraint({
          kind: 'structural-field',
          origin: 'binary-evidence',
          claim: {
            layer: 'structural',
            entityId: `issue-4720-hard-${field}`,
            descriptor: descriptor(field, value),
          },
        }),
        new RegExp(code),
        `${field} must not mint hard authority from structured value`,
      );
    }
  }
});

test('issue #4720 never invokes coercion hooks for malformed structural integers', () => {
  let coercions = 0;
  const value = {
    valueOf() { coercions++; return 8; },
    toString() { coercions++; return '8'; },
    [Symbol.toPrimitive]() { coercions++; return 8; },
  };

  assert.throws(() => claim('offset', value), /structural-offset-invalid/);
  assert.equal(coercions, 0);
});

console.log('issue #4720 structural integer authority regression: PASS');
