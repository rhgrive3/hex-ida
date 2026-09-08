import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveMemoryRegion } from '../../../js/analysis/alias/regions-v2.js';
import { aliasMemoryRegions } from '../../../js/analysis/alias/legacy-safety-floor.js';

// #5218: `uniqueBinaryId()` preferred the explicit `binaryId` over the origin's
// own byte-range provenance, so a region could carry `binaryId: bin-B` while
// its evidence bytes came from bin-A — and then MustAlias a real bin-B global.

const region = (binaryId, rangeBinaryId) => deriveMemoryRegion({
  functionId: 'f',
  binaryId,
  widthBits: 32,
  origin: { byteRanges: [{ binaryId: rangeBinaryId, start: 0, end: 4 }] },
  regionEvidence: { kind: 'global-absolute', address: '4096' },
});

test('#5218 explicit binary identity conflicting with origin provenance fails closed', () => {
  assert.throws(() => region('bin-B', 'bin-A'), /alias-region-binary-identity-mismatch/);
});

test('#5218 agreeing authorities keep producing the precise region', () => {
  const realB = region('bin-B', 'bin-B');
  assert.equal(realB.kind, 'global-absolute');
  assert.equal(realB.binaryId, 'bin-B');
  assert.equal(realB.origin.byteRanges[0].binaryId, 'bin-B');
});

test('#5218 a forged cross-binary region can no longer MustAlias the real one', () => {
  const realB = region('bin-B', 'bin-B');
  let fromA;
  try {
    fromA = region('bin-B', 'bin-A');
  } catch (error) {
    fromA = null;
    assert.ok(String(error?.message).includes('alias-region-binary-identity-mismatch'));
  }
  if (fromA != null) {
    // Defensive: even if the boundary ever relaxes, the legacy floor must not
    // answer `must` for a contradictory region.
    assert.notEqual(aliasMemoryRegions(fromA, realB), 'must');
  }
});
