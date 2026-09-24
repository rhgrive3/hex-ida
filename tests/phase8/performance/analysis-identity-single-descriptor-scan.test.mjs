import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalAnalysisIdentity } from '../../../js/decompiler/phase8/analysis-identity.js';
import { fixture } from '../helpers/ir-fixtures.mjs';

test('Phase8 identity validates and reads each mutable metadata descriptor once', () => {
  const f = fixture('single-descriptor-scan');
  f.block(0);
  const value = f.constant(1n, 64);
  f.ret(value);
  const ir = f.build();

  const extra = {};
  for (let index = 0; index < 128; index += 1) extra[`field_${String(index).padStart(3, '0')}`] = index;
  value.def.extra = extra;

  const original = Object.getOwnPropertyDescriptor;
  let reads = 0;
  Object.getOwnPropertyDescriptor = function counted(owner, key) {
    if (owner === extra) reads += 1;
    return original(owner, key);
  };
  let resolved;
  try {
    resolved = canonicalAnalysisIdentity({ ir });
  } finally {
    Object.getOwnPropertyDescriptor = original;
  }

  assert.equal(resolved.valid, true);
  assert.ok(reads <= 132, `metadata descriptors were read more than once per field: ${reads}`);
});
