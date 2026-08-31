import test from 'node:test';
import assert from 'node:assert/strict';

import {
  UNBOUNDED_RANGE,
  createOffsetRange,
  createPointsToSet,
  createPointsToTarget,
  exactRange,
} from '../../../js/analysis/pointsto/lattice.js';
import { pointsToAlias } from '../../../js/analysis/pointsto/alias.js';
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

  const validA = createPointsToTarget({
    addressSpace: 'memory', rootKind: 'rooted', rootEntityId: 'A',
    separationClass: 'global-like', separationAuthority: 'root-descriptor',
    offsetRange: exactRange(0),
  });
  const validB = createPointsToTarget({
    addressSpace: 'memory', rootKind: 'rooted', rootEntityId: 'B',
    separationClass: 'global-like', separationAuthority: 'root-descriptor',
    offsetRange: exactRange(0),
  });
  assert.equal(pointsToAlias(singleton(validA), singleton(validB), {
    status: complete,
    widthBitsLeft: 64,
    widthBitsRight: 64,
  }).relation, 'no');
});
