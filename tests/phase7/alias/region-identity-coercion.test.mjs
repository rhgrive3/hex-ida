import assert from 'node:assert/strict';
import { deriveMemoryRegion } from '../../../js/analysis/alias/regions-v2.js';

assert.throws(
  () => deriveMemoryRegion({ functionId: { source: 'A' } }),
  /alias-region-invalid-function-id/,
  'object function IDs must fail closed instead of becoming an absent scope',
);

assert.throws(
  () => deriveMemoryRegion({ binaryId: { source: 'A' } }),
  /alias-region-invalid-binary-id/,
  'object binary IDs must fail closed instead of becoming an absent scope',
);

assert.throws(
  () => deriveMemoryRegion({
    binaryId: { source: 'explicit-malformed' },
    widthBits: 8,
    origin: { byteRanges: [{ binaryId: 'origin-bin', start: 0, end: 1 }] },
  }),
  /alias-region-invalid-binary-id/,
  'a malformed explicit binary identity must not fall back to an origin identity',
);

assert.throws(
  () => deriveMemoryRegion({
    functionId: 'fn:1',
    widthBits: 64,
    origin: { instructionIds: ['insn:1'] },
    regionEvidence: { kind: 'rooted-offset', rootEntityId: { source: 'root-A' }, offset: 0 },
  }),
  /alias-region-invalid-root-entity-id/,
  'malformed root identity must fail before a MemoryRegion ID is minted',
);

assert.throws(
  () => deriveMemoryRegion({
    functionId: 'fn:1',
    widthBits: 64,
    origin: { instructionIds: ['insn:1'] },
    sourceEntityId: { source: 'load-A' },
  }),
  /alias-region-invalid-source-entity-id/,
  'malformed uncertainty identity must not collapse to the same null identity as absence',
);

assert.throws(
  () => deriveMemoryRegion({ functionId: 'fn:1', addressSpace: { kind: 'tls' } }),
  /alias-region-invalid-address-space/,
  'address-space identity must be an explicit non-empty string',
);

const a = deriveMemoryRegion({ functionId: ' fn:1 ', widthBits: 8, sourceEntityId: ' load:a ' });
const b = deriveMemoryRegion({ functionId: 'fn:1', widthBits: 8, sourceEntityId: 'load:b' });
assert.equal(a.functionId, 'fn:1');
assert.notEqual(a.id, b.id, 'distinct valid identity strings must remain distinct');

console.log('alias region identity coercion regression: PASS');
