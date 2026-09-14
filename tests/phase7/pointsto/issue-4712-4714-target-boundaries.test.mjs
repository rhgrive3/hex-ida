import assert from 'node:assert/strict';
import test from 'node:test';

import { createAnalysisStatus } from '../../../js/analysis/status.js';
import {
  UNBOUNDED_RANGE,
  createPointsToSet,
  createPointsToTarget,
  exactRange,
  joinPointsTo,
} from '../../../js/analysis/pointsto/lattice.js';
import { pointsToAlias } from '../../../js/analysis/pointsto/alias.js';

const complete=createAnalysisStatus({
  snapshotId:'snapshot-4712-4714',
  analyzerId:'pointsto-test',
  analyzerVersion:'1',
  completeness:'complete',
});

function singleton(target) {
  return createPointsToSet({ targets:[target] });
}

function aliasOf(left, right) {
  return pointsToAlias(singleton(left), singleton(right), {
    status:complete,
    widthBitsLeft:64,
    widthBitsRight:64,
  });
}

function rawTarget(rootEntityId, offsetRange=exactRange(0)) {
  return {
    rootKey:'forged-same-root',
    addressSpace:'memory',
    rootKind:'unknown',
    rootEntityId,
    offsetRange,
    evidenceIds:[],
  };
}

test('raw rootKey cannot mint a same-root MustAlias through createPointsToSet (#4712)', () => {
  const left=rawTarget('actual-root-A');
  const right=rawTarget('actual-root-B');
  const leftSet=singleton(left);
  const rightSet=singleton(right);

  assert.notEqual(leftSet.targets[0].rootKey,'forged-same-root');
  assert.notEqual(leftSet.targets[0].rootKey,rightSet.targets[0].rootKey);
  assert.equal(aliasOf(left,right).relation,'may');
});

test('different canonical roots cannot be merged by a forged rootKey (#4712)', () => {
  const left=singleton(rawTarget('actual-root-A'));
  const right=singleton(rawTarget('actual-root-B'));
  const joined=joinPointsTo(left,right);
  assert.equal(joined.targets.length,2);
  assert.notEqual(joined.targets[0].rootKey,joined.targets[1].rootKey);
});

test('canonical targets retain same-root range semantics after set reconstruction (#4712)', () => {
  const left=createPointsToTarget({
    rootKind:'rooted',
    rootEntityId:'same-root',
    offsetRange:exactRange(0),
  });
  const same=createPointsToTarget({
    rootKind:'rooted',
    rootEntityId:'same-root',
    offsetRange:exactRange(0),
  });
  const disjoint=createPointsToTarget({
    rootKind:'rooted',
    rootEntityId:'same-root',
    offsetRange:exactRange(16),
  });
  assert.equal(aliasOf(left,same).relation,'must');
  assert.equal(aliasOf(left,disjoint).relation,'no');
});

test('malformed offsetRange cannot mint a strong alias relation (#4714)', () => {
  const malformed={ min:'not-an-offset', max:'not-an-offset', exact:true };
  const left=createPointsToTarget({
    rootKind:'rooted',
    rootEntityId:'same-root',
    offsetRange:malformed,
  });
  const right=createPointsToTarget({
    rootKind:'rooted',
    rootEntityId:'same-root',
    offsetRange:malformed,
  });

  assert.deepEqual(left.offsetRange,UNBOUNDED_RANGE);
  assert.equal(aliasOf(left,right).relation,'may');
});
