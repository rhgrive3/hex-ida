import assert from 'node:assert/strict';
import test from 'node:test';

import { pointsToAlias } from '../../js/analysis/pointsto/alias.js';
import { createPointsToTarget } from '../../js/analysis/pointsto/lattice.js';
import { createAnalysisStatus } from '../../js/analysis/status.js';

const status = createAnalysisStatus({ snapshotId: 's', analyzerId: 'a', analyzerVersion: '1', completeness: 'complete' });
const widthOptions = { status, widthBitsLeft: 64, widthBitsRight: 64 };

function rawTarget(rootKey, addressSpace) {
  return { top: false, lossReasons: [], targets: [{ rootKey, addressSpace, rootKind: 'rooted', offsetRange: { exact: true, min: 0n, max: 0n } }] };
}

test('#5587 a malformed structured addressSpace never mints a distinct-space NoAlias', () => {
  const left = rawTarget('left', ['memory']);
  const right = rawTarget('right', 'memory');
  const result = pointsToAlias(left, right, widthOptions);
  assert.notEqual(result.relation, 'no', `structured addressSpace must not separate: ${JSON.stringify(result.reasonCodes)}`);
  assert.ok(!result.reasonCodes.includes('distinct-address-space'));
});

test('#5587 a case-different addressSpace spelling cannot separate by spelling alone', () => {
  const result = pointsToAlias(rawTarget('left', 'MEMORY'), rawTarget('right', 'memory'), widthOptions);
  assert.notEqual(result.relation, 'no', `case spelling must not mint a separation proof: ${JSON.stringify(result.reasonCodes)}`);
  assert.ok(!result.reasonCodes.includes('distinct-address-space'));
});

test('#5587 a padded addressSpace keeps the #5717 fail-closed boundary', () => {
  const result = pointsToAlias(rawTarget('left', 'memory '), rawTarget('right', 'memory'), widthOptions);
  assert.notEqual(result.relation, 'no');
});

test('#5587 canonical targets in genuinely different spaces still separate exactly', () => {
  const memory = createPointsToTarget({ rootKey: 'left', addressSpace: 'memory', rootKind: 'rooted', offsetRange: { exact: true, min: 0n, max: 0n } });
  const tls = createPointsToTarget({ rootKey: 'right', addressSpace: 'tls', rootKind: 'rooted', offsetRange: { exact: true, min: 0n, max: 0n } });
  const result = pointsToAlias(
    { top: false, lossReasons: [], targets: [memory] },
    { top: false, lossReasons: [], targets: [tls] },
    widthOptions,
  );
  assert.equal(result.relation, 'no');
  assert.ok(result.reasonCodes.includes('distinct-address-space'));
});
