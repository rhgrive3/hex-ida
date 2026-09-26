import assert from 'node:assert/strict';
import test from 'node:test';

import {
  analysisIdentityResolutionForIr,
  bindAnalysisIdentityResolutionToIr,
  canonicalAnalysisIdentity,
  resolveAnalysisIdentityForIr,
} from '../../../js/decompiler/phase8/analysis-identity.js';
import { buildRenderProvenance } from '../../../js/decompiler/phase8/render-provenance.js';
import { fixture } from '../helpers/ir-fixtures.mjs';

function buildLargeIr() {
  const f = fixture('source-partial-identity-resolution-reuse');
  f.block(0);
  let value = f.constant(1n, 64);
  for (let index = 0; index < 64; index++) {
    value = f.binary('add', value, f.constant(BigInt(index + 2), 64), 64);
  }
  f.ret(value);
  return f.build();
}

function graphObjects(root) {
  const found = new WeakSet();
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    if (current == null || typeof current !== 'object' || found.has(current)) continue;
    found.add(current);
    for (const key of Reflect.ownKeys(current)) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor && 'value' in descriptor) pending.push(descriptor.value);
    }
  }
  return found;
}

test('source-partial identity resolution reuses the exact valid or unknown result without an IR walk', () => {
  const ir = buildLargeIr();
  // This well-formed but stale source ID fails only after the canonical IR
  // shape has been traversed and hashed.
  ir.identity = { semanticIrId:'semantic-ir:stale-source' };
  const expected = canonicalAnalysisIdentity({ ir });
  assert.equal(expected.valid, false);
  assert.equal(expected.reason, 'analysis identity is stale for the Semantic IR');

  const resolutionBinding = bindAnalysisIdentityResolutionToIr(ir, expected);
  assert.ok(resolutionBinding);
  assert.equal(analysisIdentityResolutionForIr(resolutionBinding, { ...ir }), null,
    'a shallow IR clone cannot inherit the original resolution');

  const tracked = graphObjects(ir);
  const originalDescriptor = Object.getOwnPropertyDescriptor;
  let irDescriptorReads = 0;
  Object.getOwnPropertyDescriptor = function countedDescriptor(owner, key) {
    if (tracked.has(owner)) irDescriptorReads++;
    return originalDescriptor(owner, key);
  };
  let reused;
  try {
    reused = resolveAnalysisIdentityForIr({
      ir,
      resolutionBinding,
      // If the resolver tries to recompute, spreading this fallback context
      // fails immediately instead of hiding a second canonical traversal.
      context:new Proxy({}, { ownKeys() { throw new Error('canonical-identity-recomputed'); } }),
    });
  } finally {
    Object.getOwnPropertyDescriptor = originalDescriptor;
  }

  assert.deepEqual(reused, expected, 'reuse preserves the explicit stale-identity result');
  assert.equal(irDescriptorReads, 0,
    `exact-object resolution reuse re-read ${irDescriptorReads} IR descriptors`);

  const pseudocode = 'uint64 function(void) { return 1; }';
  const result = { ir, lines:[], pseudocode };
  const originalMap = buildRenderProvenance({ result, snapshotId:null });
  const reusedMap = buildRenderProvenance({ result, snapshotId:reused.valid ? reused.identity.snapshotId : null });
  assert.equal(result.pseudocode, pseudocode);
  assert.deepEqual(reusedMap, originalMap,
    'reused unknown identity keeps render provenance byte-equivalent');
});

test('same-IR valid resolution reuse preserves the canonical snapshot and provenance map', () => {
  const ir = buildLargeIr();
  const expected = canonicalAnalysisIdentity({ ir });
  assert.equal(expected.valid, true);
  const resolutionBinding = bindAnalysisIdentityResolutionToIr(ir, expected);
  assert.ok(resolutionBinding);

  const reused = resolveAnalysisIdentityForIr({ ir, resolutionBinding });
  assert.deepEqual(reused, expected);
  const result = { ir, lines:[], pseudocode:'uint64 function(void) { return 0xABCDEF; }' };
  assert.deepEqual(
    buildRenderProvenance({ result, snapshotId:reused.identity.snapshotId }),
    buildRenderProvenance({ result, snapshotId:expected.identity.snapshotId }),
  );
  assert.equal(result.pseudocode, 'uint64 function(void) { return 0xABCDEF; }');
});
