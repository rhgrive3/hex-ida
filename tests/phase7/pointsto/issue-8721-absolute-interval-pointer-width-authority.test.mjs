// Regression for #8721 (and the duplicate #8779): the alias query's memory-access
// width is not pointer-width authority. An absolute target whose own pointer width is
// unknown or malformed must never mint `disjoint-global-interval` NoAlias or an
// identical-span MustAlias; it fails closed to `may` and records the loss.
// The pre-#5172 `absoluteInterval()` contract this restores is what the #4515
// permanent regressions assert, so those two suites are the paired acceptance.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createAnalysisStatus } from '../../../js/analysis/status.js';
import { pointsToAlias } from '../../../js/analysis/pointsto/alias.js';
import {
  createPointsToSet,
  createPointsToTarget,
  exactRange,
} from '../../../js/analysis/pointsto/lattice.js';

const status = createAnalysisStatus({
  snapshotId: 'issue-8721',
  analyzerId: 'pointsto-test',
  analyzerVersion: '1',
  completeness: 'complete',
});

function target(rootEntityId, address, widthBits) {
  return createPointsToTarget({
    addressSpace: 'memory',
    rootKind: 'absolute',
    rootEntityId,
    address,
    offsetRange: exactRange(0n),
    widthBits,
  });
}

function alias(left, right, widthBitsLeft = 64, widthBitsRight = 64) {
  return pointsToAlias(
    createPointsToSet({ targets: [left] }),
    createPointsToSet({ targets: [right] }),
    { status, widthBitsLeft, widthBitsRight },
  );
}

test('#8721 an unproven pointer width is not repaired from the access width', () => {
  for (const accessWidth of [32, 64]) {
    const result = alias(
      target('A', '0x1000', null),
      target('B', '0x2000', 64),
      accessWidth,
      accessWidth,
    );
    assert.notEqual(result.relation, 'no', `access width ${accessWidth} minted a strong separation`);
    assert.notEqual(result.relation, 'must');
    assert.ok(!result.reasonCodes.includes('disjoint-global-interval'));
    assert.ok(result.reasonCodes.includes('provenance-lost'), 'the lost authority must be observable');
  }
});

test('#8721 both sides unproven separate nothing, whatever the access width', () => {
  for (const accessWidth of [8, 32, 64]) {
    const disjoint = alias(
      target('A', '0x1000', null),
      target('B', '0x80000000', null),
      accessWidth,
      accessWidth,
    );
    assert.notEqual(disjoint.relation, 'no');
    assert.ok(!disjoint.reasonCodes.includes('disjoint-global-interval'));

    // The same numeric address on two roots is still not an *exact* proof here:
    // the interval branch that names identical spans requires a proven width.
    const identical = alias(
      target('A', '0x1000', null),
      target('B', '0x1000', null),
      accessWidth,
      accessWidth,
    );
    assert.notEqual(identical.relation, 'must');
    assert.ok(!identical.reasonCodes.includes('identical-root-and-exact-offset'));
  }
});

test('#8721 a malformed target width is rejected, and cannot be laundered by bypassing the boundary', () => {
  for (const width of ['64', 0, -64, 1.5]) {
    assert.throws(
      () => createPointsToSet({ targets: [Object.freeze({ ...target('A', '0x1000', null), widthBits: width })] }),
      (error) => error instanceof TypeError && error.message === 'phase7-pointsto-target-invalid-width-bits',
      `structured/invalid width ${JSON.stringify(width)} accepted at the target boundary`,
    );
    // Raw-set bypass: even when the forged width reaches the alias kernel, the
    // query's access width must not repair it into pointer-width authority.
    const forged = Object.freeze({ ...target('A', '0x1000', null), widthBits: width });
    const result = pointsToAlias(
      Object.freeze({ top: false, lossReasons: Object.freeze([]), targets: Object.freeze([forged]) }),
      Object.freeze({ top: false, lossReasons: Object.freeze([]), targets: Object.freeze([target('B', '0x2000', 64)]) }),
      { status, widthBitsLeft: 64, widthBitsRight: 64 },
    );
    assert.notEqual(result.relation, 'no', `structured/invalid width ${JSON.stringify(width)} separated`);
    assert.ok(result.reasonCodes.includes('provenance-lost'));
  }

  // A width that survives the target boundary but is not an address-space width
  // still cannot mint separation, and still cannot be repaired by the access width.
  const absurd = Object.freeze({ ...target('A', '0x1000', null), widthBits: Number.MAX_SAFE_INTEGER });
  const absurdResult = pointsToAlias(
    Object.freeze({ top: false, lossReasons: Object.freeze([]), targets: Object.freeze([absurd]) }),
    Object.freeze({ top: false, lossReasons: Object.freeze([]), targets: Object.freeze([target('B', '0x2000', 64)]) }),
    { status, widthBitsLeft: 64, widthBitsRight: 64 },
  );
  assert.notEqual(absurdResult.relation, 'no');
  assert.ok(absurdResult.reasonCodes.includes('provenance-lost'));
});

test('#8721 a proven pointer width keeps both strong interval answers', () => {
  const disjoint = alias(target('A', '0x1000', 64), target('B', '0x2000', 64));
  assert.equal(disjoint.relation, 'no');
  assert.ok(disjoint.reasonCodes.includes('disjoint-global-interval'));

  const identical = alias(target('A', '0x1000', 64), target('B', '0x1000', 64));
  assert.equal(identical.relation, 'must');
  assert.ok(identical.reasonCodes.includes('identical-root-and-exact-offset'));
});

test('#8721 width authority is per-target, not per-query', () => {
  // Only the left target is unproven: neither the pair may be separated nor
  // identified, and the surviving side must not lend its width to the other.
  const result = alias(target('A', '0x1000', null), target('B', '0x1000', 32), 32, 32);
  assert.notEqual(result.relation, 'must');
  assert.notEqual(result.relation, 'no');
  assert.ok(result.reasonCodes.includes('provenance-lost'));
});
