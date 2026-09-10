import assert from 'node:assert/strict';
import test from 'node:test';
import { aliasMemoryRegions } from '../../../js/analysis/alias/legacy-safety-floor.js';

const origin = { instructionIds: ['instruction_5130'] };

const stackRegion = (overrides = {}) => ({
  kind: 'stack-fixed',
  functionId: 'f',
  offset: '-16',
  widthBits: 64,
  origin,
  metadata: { canonicalRootStorageClass: 'function-local-stack' },
  ...overrides,
});

const entryArgument = (overrides = {}) => ({
  kind: 'rooted-offset',
  functionId: 'f',
  rootEntityId: 'x0-entry',
  offset: '0',
  widthBits: 64,
  origin,
  metadata: { canonicalRootStorageClass: 'external-entry-memory' },
  ...overrides,
});

test('#5130 entry-argument storage class is not a stack separation proof', () => {
  // caller: `sub x0, sp, #16` before `bl callee`; callee: `sub sp, sp, #16`.
  // x0_entry == sp_callee, so the pair can be MustAlias — ABI classes alone
  // must not mint `no`.
  assert.equal(aliasMemoryRegions(stackRegion(), entryArgument()), 'may');
  assert.equal(aliasMemoryRegions(entryArgument(), stackRegion()), 'may');
});

test('#5130 proven separations outside the entry-argument rule are preserved', () => {
  // Distinct same-function stack intervals stay NoAlias (interval arithmetic).
  assert.equal(
    aliasMemoryRegions(stackRegion({ offset: '-16' }), stackRegion({ offset: '32' })),
    'no',
  );
  // Overlapping same-function stack intervals stay `may` (not separated).
  assert.equal(
    aliasMemoryRegions(stackRegion({ offset: '-16' }), stackRegion({ offset: '-12' })),
    'may',
  );
  // Stack vs image-global separation is unchanged (#2926 authority).
  assert.equal(
    aliasMemoryRegions(
      stackRegion(),
      { kind: 'global-absolute', binaryId: 'bin', address: '4096', widthBits: 64, origin, metadata: { canonicalRootStorageClass: 'image-global' } },
    ),
    'no',
  );
  // Distinct physical address spaces stay NoAlias (#4440).
  assert.equal(
    aliasMemoryRegions(
      { kind: 'tls', functionId: 'f', binaryId: 'bin', addressSpace: 'tls', rootIdentity: { addressValueId: 'v0' }, widthBits: 64, origin },
      { kind: 'io', functionId: 'f', binaryId: 'bin', addressSpace: 'io', rootIdentity: { addressValueId: 'v0' }, widthBits: 64, origin },
    ),
    'no',
  );
});
