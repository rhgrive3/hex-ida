import assert from 'node:assert/strict';
import { deriveMemoryRegion } from '../../../js/analysis/alias/regions-v2.js';

{
  assert.throws(
    () => deriveMemoryRegion({ functionId: { source: 'A' } }),
    /alias-region-scope-required/,
    'object function IDs must not be coerced into canonical scope strings',
  );
}

{
  assert.throws(
    () => deriveMemoryRegion({ binaryId: { source: 'A' } }),
    /alias-region-scope-required/,
    'object binary IDs must not be coerced into canonical scope strings',
  );
}

{
  const region = deriveMemoryRegion({
    functionId: 'fn:1',
    widthBits: 64,
    origin: { instructionIds: ['insn:1'] },
    regionEvidence: {
      kind: 'rooted-offset',
      rootEntityId: { source: 'root-A' },
      offset: 0,
    },
  });
  assert.equal(region.kind, 'unknown');
  assert.equal(region.functionId, 'fn:1');
  assert.equal(region.rootEntityId, undefined);
  assert.equal(region.metadata?.reason, 'malformed-or-unproven-region-evidence');
}

{
  const region = deriveMemoryRegion({
    functionId: 'fn:1',
    widthBits: 64,
    origin: { instructionIds: ['insn:1'] },
    sourceEntityId: { source: 'load-A' },
    addressValueId: { source: 'value-A' },
  });
  assert.equal(region.uncertaintyIdentity.sourceEntityId, null);
  assert.equal(region.uncertaintyIdentity.addressValueId, null);
  assert.equal(JSON.stringify(region).includes('[object Object]'), false);
}

console.log('alias region identity coercion regression: PASS');
