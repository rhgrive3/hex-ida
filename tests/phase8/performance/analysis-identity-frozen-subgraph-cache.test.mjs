import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalAnalysisIdentity } from '../../js/decompiler/phase8/analysis-identity.js';
import { fixture } from '../phase8/helpers/ir-fixtures.mjs';

function freezeGraph(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) freezeGraph(value[key], seen);
  Object.freeze(value);
  return value;
}

test('analysis identity reuses shared deep-frozen metadata across mutable extra roots', () => {
  const f = fixture('shared-frozen-extra');
  f.block(0);
  let value = f.constant(1n, 64);
  for (let index = 0; index < 64; index += 1) value = f.binary('add', value, f.constant(BigInt(index + 2), 64), 64);
  f.ret();
  const ir = f.build();

  let shared = { leaf: 'canonical' };
  const sharedNodes = [shared];
  for (let index = 0; index < 64; index += 1) {
    shared = { index, next: shared, payload: [index, index + 1, index + 2] };
    sharedNodes.push(shared, shared.payload);
  }
  freezeGraph(shared);
  const tracked = new WeakSet(sharedNodes);
  for (const block of ir.blocks) {
    for (const instruction of block.insts) {
      instruction.extra = { ...(instruction.extra || {}), sharedCanonicalMetadata: shared };
    }
  }

  const original = Object.getOwnPropertyDescriptor;
  let sharedDescriptorReads = 0;
  Object.getOwnPropertyDescriptor = function countedDescriptor(owner, key) {
    if (owner && typeof owner === 'object' && tracked.has(owner)) sharedDescriptorReads += 1;
    return original(owner, key);
  };
  let identity;
  try {
    identity = canonicalAnalysisIdentity({ ir });
  } finally {
    Object.getOwnPropertyDescriptor = original;
  }

  assert.equal(identity.valid, true);
  // Without cross-root certification, every unique mutable extra wrapper walks
  // the same frozen graph again (thousands of descriptor reads). Certification
  // may inspect+encode it once, so leave generous constant-factor headroom.
  assert.ok(sharedDescriptorReads < 1200,
    `shared deep-frozen metadata was repeatedly re-encoded: ${sharedDescriptorReads} descriptor reads`);
});
