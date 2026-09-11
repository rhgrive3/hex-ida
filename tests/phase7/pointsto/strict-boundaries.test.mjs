import test from 'node:test';
import assert from 'node:assert/strict';

import {
  UNBOUNDED_RANGE,
  createOffsetRange,
  createPointsToSet,
  createPointsToTarget,
  createRootDescriptorSeparatedTarget,
  exactRange,
} from '../../../js/analysis/pointsto/lattice.js';
import { pointsToAlias } from '../../../js/analysis/pointsto/alias.js';
import { deriveCanonicalAddressProof } from '../../../js/analysis/alias/canonical-address-v2.js';
import { createAnalysisStatus } from '../../../js/analysis/status.js';

const complete = createAnalysisStatus({
  snapshotId:'pointsto-strict-boundaries',
  analyzerId:'pointsto-test',
  analyzerVersion:'1',
  completeness:'complete',
});

function singleton(target) {
  return createPointsToSet({ targets: [target] });
}

function canonicalProof(rootEntityId, separationClass) {
  const valueId = `proof-${separationClass}-${rootEntityId}`;
  const proof = deriveCanonicalAddressProof({
    functionId: 'issue-3018-canonical-proof',
    values: [{
      id: valueId,
      kind: 'entry',
      variableKey: `root-${rootEntityId}`,
      machineType: { kind: 'address', widthBits: 64 },
      metadata: {
        canonicalRoot: {
          kind: separationClass,
          rootEntityId,
          baseOffset: 0,
          addressSpace: 'memory',
          linearOffsets: true,
        },
      },
    }],
    nodes: [],
    blocks: [],
  }, valueId);
  assert.equal(proof.kind, 'rooted');
  return proof;
}
test('#3020 structured offset values fail closed instead of minting exact ranges', () => {
  for (const malformed of [
    ['8'],
    [8],
    true,
    false,
    { toString() { return '8'; } },
    { valueOf() { return 8; } },
    1.5,
    Number.POSITIVE_INFINITY,
  ]) {
    assert.deepEqual(exactRange(malformed), UNBOUNDED_RANGE);
  }

  assert.deepEqual(exactRange(8n), createOffsetRange(8n, 8n));
  assert.deepEqual(exactRange(8), createOffsetRange(8n, 8n));
  assert.deepEqual(exactRange('8'), createOffsetRange(8n, 8n));
  assert.deepEqual(exactRange('0x8'), createOffsetRange(8n, 8n));
});

test('#3020 malformed offsets cannot manufacture strong same-root alias answers', () => {
  const root = {
    addressSpace: 'memory',
    rootKind: 'rooted',
    rootEntityId: 'root-A',
    widthBits: 64,
  };
  const left = singleton(createPointsToTarget({ ...root, offsetRange: exactRange(['0']) }));
  const right = singleton(createPointsToTarget({ ...root, offsetRange: exactRange(['8']) }));
  const result = pointsToAlias(left, right, {
    status: complete,
    widthBitsLeft: 64,
    widthBitsRight: 64,
  });
  assert.equal(result.relation, 'may');
});

test('#3018 non-string separation metadata cannot produce descriptor-backed NoAlias', () => {
  const malformedA = createPointsToTarget({
    addressSpace: 'memory',
    rootKind: 'rooted',
    rootEntityId: 'A',
    separationClass: ['global-like'],
    separationAuthority: ['root-descriptor'],
    offsetRange: exactRange(0),
  });
  const malformedB = createPointsToTarget({
    addressSpace: 'memory',
    rootKind: 'rooted',
    rootEntityId: 'B',
    separationClass: ['global-like'],
    separationAuthority: ['root-descriptor'],
    offsetRange: exactRange(0),
  });
  assert.equal(malformedA.separationClass, null);
  assert.equal(malformedA.separationAuthority, null);
  assert.equal(pointsToAlias(singleton(malformedA), singleton(malformedB), {
    status: complete,
    widthBitsLeft: 64,
    widthBitsRight: 64,
  }).relation, 'may');

  // #6066: the same holds for plain strings — separation authority is minted
  // only through the canonical proof boundary, never accepted from input.
  const strA = createPointsToTarget({
    addressSpace: 'memory', rootKind: 'rooted', rootEntityId: 'A',
    separationClass: 'global-like', separationAuthority: 'root-descriptor',
    offsetRange: exactRange(0),
  });
  const strB = createPointsToTarget({
    addressSpace: 'memory', rootKind: 'rooted', rootEntityId: 'B',
    separationClass: 'global-like', separationAuthority: 'root-descriptor',
    offsetRange: exactRange(0),
  });
  assert.equal(strA.separationAuthority, null,
    'a self-claimed authority string must not be stored as authority');
  assert.equal(pointsToAlias(singleton(strA), singleton(strB), {
    status: complete,
    widthBitsLeft: 64,
    widthBitsRight: 64,
  }).relation, 'may');

  // A target minted through the canonical proof boundary keeps the exact
  // distinct-storage NoAlias the corpus relies on (#1848).
  const validA = createRootDescriptorSeparatedTarget({
    addressSpace: 'memory', rootKind: 'rooted', rootEntityId: 'A',
    offsetRange: exactRange(0),
  }, canonicalProof('A', 'global-like'));
  const validB = createRootDescriptorSeparatedTarget({
    addressSpace: 'memory', rootKind: 'rooted', rootEntityId: 'B',
    offsetRange: exactRange(0),
  }, canonicalProof('B', 'global-like'));
  assert.equal(pointsToAlias(singleton(validA), singleton(validB), {
    status: complete,
    widthBitsLeft: 64,
    widthBitsRight: 64,
  }).relation, 'no');
});
