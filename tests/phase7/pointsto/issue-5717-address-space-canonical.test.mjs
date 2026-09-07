import assert from 'node:assert/strict';
import test from 'node:test';

import { createAnalysisStatus } from '../../../js/analysis/status.js';
import { createPointsToSet, createPointsToTarget, exactRange } from '../../../js/analysis/pointsto/lattice.js';
import { pointsToAlias } from '../../../js/analysis/pointsto/alias.js';

// #5717: createPointsToTarget() stored `addressSpace` verbatim, and alias
// separation treats a differing addressSpace as a strong NoAlias. A trailing
// space on 'memory ' therefore manufactured a distinct-space NoAlias with no
// storage relation evidence at all.

const complete = createAnalysisStatus({
  snapshotId:'snapshot_issue_5717',
  analyzerId:'pointsto-test',
  analyzerVersion:'1',
  completeness:'complete',
});

const targetFor = (entityId, addressSpace) => createPointsToTarget({
  addressSpace,
  rootKind:'rooted',
  rootEntityId:entityId,
  offsetRange:exactRange(0n),
});

const aliasOf = (left, right) => pointsToAlias(
  createPointsToSet({ targets:[left] }),
  createPointsToSet({ targets:[right] }),
  { status:complete, widthBitsLeft:64, widthBitsRight:64 },
);

test('a padded address space must not manufacture a distinct-space NoAlias (#5717)', () => {
  const left = targetFor('left', 'memory');
  const right = targetFor('right', 'memory ');
  assert.deepEqual(right.addressSpace, 'memory',
    'the canonical target boundary trims the authority field');
  const result = aliasOf(left, right);
  assert.notEqual(result.relation, 'no',
    'whitespace notation drift alone must not prove NoAlias');
  assert.ok(!result.reasonCodes.includes('distinct-address-space'));
});

test('a whitespace-only address space degrades to unknown, never to authority (#5717)', () => {
  const left = targetFor('left', 'memory');
  const right = targetFor('right', '   ');
  assert.equal(right.addressSpace, 'unknown',
    'whitespace-only space cannot be proven, so it must degrade to unknown');
  const result = aliasOf(left, right);
  assert.notEqual(result.relation, 'no');
  assert.ok(!result.reasonCodes.includes('distinct-address-space'));
});

test('genuinely distinct proven spaces still separate, and identical spaces still alias (#5717)', () => {
  // Distinct canonical spaces keep their strong separation.
  const io = targetFor('left', 'io');
  const memory = targetFor('right', 'memory');
  const separated = aliasOf(io, memory);
  assert.equal(separated.relation, 'no');
  assert.ok(separated.reasonCodes.includes('distinct-address-space'));

  // The same canonical space with different roots reaches the ordinary
  // address/offset comparison instead of the space shortcut.
  const a = targetFor('left', 'memory');
  const b = targetFor('right', 'memory');
  const same = aliasOf(a, b);
  assert.notEqual(same.relation, 'no', 'same-space targets are not separated by the space shortcut');
});
