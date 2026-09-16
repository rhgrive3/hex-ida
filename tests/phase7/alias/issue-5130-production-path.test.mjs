import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryRegionRef } from '../../../js/semantics/memoryssa/contract.js';
import { aliasMemoryRegions, unknownStoreClobbersRegion } from '../../../js/analysis/alias/legacy-safety-floor.js';

const origin = { instructionIds: ['caller_5130', 'callee_5130'] };

function callerX0Region() {
  return createMemoryRegionRef({
    id: 'x0-entry',
    kind: 'rooted-offset',
    functionId: 'callee',
    rootEntityId: 'x0-entry',
    offset: '-16',
    widthBits: 64,
    origin,
    metadata: { canonicalRootStorageClass: 'external-entry-memory' },
  });
}

function calleeSpRegion() {
  return createMemoryRegionRef({
    id: 'callee-sp-minus-16',
    kind: 'stack-fixed',
    functionId: 'callee',
    offset: '-16',
    widthBits: 64,
    origin,
    metadata: { canonicalRootStorageClass: 'function-local-stack' },
  });
}

test('#5130 production-shaped caller x0=S-16 / callee sp=S-16 stays aliasable', () => {
  const entry = callerX0Region();
  const stack = calleeSpRegion();
  assert.equal(aliasMemoryRegions(entry, stack), 'may');
  assert.equal(aliasMemoryRegions(stack, entry), 'may');
  assert.equal(unknownStoreClobbersRegion(stack, entry), true);
});

test('#5130 canonical region construction preserves the dependency witness', () => {
  const entry = callerX0Region();
  const stack = calleeSpRegion();
  assert.equal(entry.offset, '-16');
  assert.equal(stack.offset, '-16');
  assert.equal(entry.widthBits, 64);
  assert.equal(stack.widthBits, 64);
  assert.deepEqual(entry.origin, stack.origin);
});
