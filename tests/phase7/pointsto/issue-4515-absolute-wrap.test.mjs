import assert from 'node:assert/strict';
import test from 'node:test';

import { createAnalysisStatus } from '../../../js/analysis/status.js';
import { pointsToAlias } from '../../../js/analysis/pointsto/alias.js';
import {
  createPointsToSet,
  createPointsToTarget,
  exactRange,
} from '../../../js/analysis/pointsto/lattice.js';

const complete = createAnalysisStatus({
  snapshotId: 'issue-4515',
  analyzerId: 'pointsto-test',
  analyzerVersion: '1',
  completeness: 'complete',
});

function target(rootEntityId, address, offsetRange = exactRange(0n), widthBits = 64) {
  return createPointsToTarget({
    addressSpace: 'memory',
    rootKind: 'absolute',
    rootEntityId,
    address,
    offsetRange,
    widthBits,
  });
}

function alias(left, right, widthBitsLeft = 64, widthBitsRight = 64) {
  return pointsToAlias(
    createPointsToSet({ targets: [left] }),
    createPointsToSet({ targets: [right] }),
    { status: complete, widthBitsLeft, widthBitsRight },
  );
}

test('absolute base plus offset wrap cannot mint NoAlias (#4515)', () => {
  const wrapped = target('A', '0xfffffffffffffff0', exactRange(0x20n));
  const sameEffectiveAddress = target('B', '0x10');
  const result = alias(wrapped, sameEffectiveAddress);

  assert.notEqual(result.relation, 'no');
  assert.ok(result.reasonCodes.includes('provenance-lost'));
  assert.ok(!result.reasonCodes.includes('disjoint-global-interval'));
});

test('non-wrapping disjoint absolute intervals still prove NoAlias (#4515)', () => {
  const left = target('A', '0x1000', exactRange(0n));
  const right = target('B', '0x2000', exactRange(0n));
  const result = alias(left, right);

  assert.equal(result.relation, 'no');
  assert.ok(result.reasonCodes.includes('disjoint-global-interval'));
});

test('non-wrapping identical absolute spans still prove MustAlias (#4515)', () => {
  const left = target('A', '0x1000', exactRange(8n));
  const right = target('B', '0x1008', exactRange(0n));
  const result = alias(left, right);

  assert.equal(result.relation, 'must');
  assert.ok(result.reasonCodes.includes('identical-root-and-exact-offset'));
});

test('lower-bound underflow and unknown pointer width fail closed (#4515)', () => {
  const underflow = alias(target('A', '0x10', exactRange(-0x20n)), target('B', '0x10'));
  assert.notEqual(underflow.relation, 'no');
  assert.ok(underflow.reasonCodes.includes('provenance-lost'));

  const unknownWidth = alias(target('A', '0x1000', exactRange(0n), null), target('B', '0x2000'));
  assert.notEqual(unknownWidth.relation, 'no');
  assert.ok(unknownWidth.reasonCodes.includes('provenance-lost'));
});

test('an access whose end crosses the pointer boundary is not separated (#4515)', () => {
  const crossing = target('A', '0xffffffffffffffff', exactRange(0n));
  const other = target('B', '0x10');
  const result = alias(crossing, other, 64, 64);

  assert.notEqual(result.relation, 'no');
  assert.ok(result.reasonCodes.includes('provenance-lost'));
});

console.log('issue #4515 absolute pointer-wrap alias regressions: PASS');
