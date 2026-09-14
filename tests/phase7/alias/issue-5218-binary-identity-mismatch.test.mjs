import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveMemoryRegion } from '../../../js/analysis/alias/regions-v2.js';
import { aliasMemoryRegions } from '../../../js/analysis/alias/legacy-safety-floor.js';

const oneRange = (binaryId = null) => ({
  byteRanges: [{ ...(binaryId == null ? {} : { binaryId }), start: 0, end: 4 }],
});
const multiRange = () => ({
  byteRanges: [
    { binaryId: 'bin-A', start: 0, end: 2 },
    { binaryId: 'bin-B', start: 2, end: 4 },
  ],
});

function derive({ binaryId, origin = oneRange('bin-A'), evidence = { kind: 'global-absolute', address: '4096' }, includeBinaryId = true } = {}) {
  return deriveMemoryRegion({
    functionId: 'f',
    ...(includeBinaryId ? { binaryId } : {}),
    widthBits: 32,
    origin,
    regionEvidence: evidence,
  });
}

const preciseCases = [
  ['stack-fixed', { kind: 'stack-fixed', offset: '16' }],
  ['global-absolute', { kind: 'global-absolute', address: '4096' }],
  ['rooted-offset', { kind: 'rooted-offset', rootEntityId: 'root', offset: '8' }],
  ['tls', { kind: 'tls', addressSpace: 'tls', rootIdentity: { slot: 'x' } }],
  ['io', { kind: 'io', addressSpace: 'io', rootIdentity: { port: 'x' } }],
  ['physical-space', { kind: 'physical-space', addressSpace: 'physical', rootIdentity: { page: 'x' } }],
];

test('#5218 explicit binary identity conflicting with single-origin provenance fails closed', () => {
  assert.throws(
    () => derive({ binaryId: 'bin-B', origin: oneRange('bin-A') }),
    /alias-region-binary-identity-mismatch/,
  );
});

test('#5218 explicit binary identity cannot collapse multi-binary provenance', () => {
  assert.throws(
    () => derive({ binaryId: 'bin-A', origin: multiRange() }),
    /alias-region-binary-identity-mismatch/,
  );
});

test('#5218 omitted explicit identity preserves conservative multi-binary fallback', () => {
  const value = derive({ includeBinaryId: false, origin: multiRange() });
  assert.equal(value.kind, 'unknown');
  assert.equal(value.binaryId ?? null, null);
  assert.equal(value.functionId, 'f');
  assert.equal(value.origin.byteRanges.length, 2);
});

test('#5218 one provenance binary remains sufficient without an explicit identity', () => {
  const value = derive({ includeBinaryId: false, origin: oneRange('bin-A') });
  assert.equal(value.kind, 'global-absolute');
  assert.equal(value.binaryId, 'bin-A');
});

test('#5218 origin without binary identity preserves explicit-only compatibility', () => {
  const value = derive({ binaryId: 'bin-B', origin: oneRange(null) });
  assert.equal(value.kind, 'global-absolute');
  assert.equal(value.binaryId, 'bin-B');
});

test('#5218 binary provenance agreement preserves every precise region kind', () => {
  for (const [kind, evidence] of preciseCases) {
    const value = derive({ binaryId: 'bin-B', origin: oneRange('bin-B'), evidence });
    assert.equal(value.kind, kind, `${kind} must stay precise when authorities agree`);
    assert.equal(value.binaryId, 'bin-B', `${kind} must retain the agreed binary identity`);
  }
});

test('#5218 every precise region kind rejects contradictory binary provenance', () => {
  for (const [kind, evidence] of preciseCases) {
    assert.throws(
      () => derive({ binaryId: 'bin-B', origin: oneRange('bin-A'), evidence }),
      /alias-region-binary-identity-mismatch/,
      `${kind} must not mint authority from contradictory provenance`,
    );
  }
});

test('#5218 contradictory provenance cannot produce a false cross-binary MustAlias', () => {
  const realB = derive({ binaryId: 'bin-B', origin: oneRange('bin-B') });
  const realA = derive({ binaryId: 'bin-A', origin: oneRange('bin-A') });
  assert.notEqual(aliasMemoryRegions(realA, realB), 'must');
  assert.throws(
    () => derive({ binaryId: 'bin-B', origin: oneRange('bin-A') }),
    /alias-region-binary-identity-mismatch/,
  );
});
