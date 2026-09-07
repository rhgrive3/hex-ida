import assert from 'node:assert/strict';
import test from 'node:test';

import { createAnalysisStatus } from '../../../js/analysis/status.js';
import { createPointsToSet, createPointsToTarget, exactRange, UNBOUNDED_RANGE } from '../../../js/analysis/pointsto/lattice.js';
import { pointsToAlias } from '../../../js/analysis/pointsto/alias.js';

// #6068: createPointsToTarget() stored input.offsetRange verbatim, so a
// caller-supplied {min:0n, max:100n, exact:true} smuggled an internal
// invariant violation past rangeRelation(), which trusts `exact` and ignores
// `max` — manufacturing strong NoAlias for overlapping ranges and MustAlias
// for non-single locations. The target boundary now rebuilds the range
// through createOffsetRange, so `exact` is re-derived from min === max.

const complete = createAnalysisStatus({
  snapshotId:'snapshot_issue_6068',
  analyzerId:'pointsto-test',
  analyzerVersion:'1',
  completeness:'complete',
});

const base = {
  addressSpace:'memory',
  rootKind:'rooted',
  rootIdentity:{ id:'same-root' },
  rootEntityId:'same-root',
};

const aliasOf = (left, right) => pointsToAlias(
  createPointsToSet({ targets:[left] }),
  createPointsToSet({ targets:[right] }),
  { status:complete, widthBitsLeft:64, widthBitsRight:64 },
);

test('a self-claimed exact flag is re-derived from min === max (#6068)', () => {
  const target = createPointsToTarget({ ...base, offsetRange:{ min:0n, max:100n, exact:true } });
  assert.equal(target.offsetRange.exact, false, 'exact must be re-derived, not trusted');
  assert.equal(String(target.offsetRange.min), '0');
  assert.equal(String(target.offsetRange.max), '100');
});

test('an overlapping range can no longer produce strong NoAlias (#6068)', () => {
  const left = createPointsToTarget({ ...base, offsetRange:{ min:0n, max:100n, exact:true } });
  const right = createPointsToTarget({ ...base, offsetRange:exactRange(8) });
  const result = aliasOf(left, right);
  assert.notEqual(result.relation, 'no', 'a wide uncertain range overlaps offset 8..16');
  assert.notEqual(result.relation, 'must');
  assert.ok(!result.reasonCodes.includes('disjoint-field-interval'));
});

test('a non-single location can no longer produce MustAlias (#6068)', () => {
  const wide = createPointsToTarget({ ...base, offsetRange:{ min:0n, max:100n, exact:true } });
  const exact = createPointsToTarget({ ...base, offsetRange:exactRange(0) });
  const result = aliasOf(wide, exact);
  assert.notEqual(result.relation, 'must', 'a 0..100 range is not a single location');
  assert.equal(result.relation, 'may');
});

test('canonical ranges keep their existing identity (#6068)', () => {
  const target = createPointsToTarget({ ...base, offsetRange:exactRange(4) });
  assert.equal(target.offsetRange.exact, true);
  assert.equal(String(target.offsetRange.min), '4');
  assert.equal(String(target.offsetRange.max), '4');
  const unbounded = createPointsToTarget({ ...base });
  assert.deepEqual(
    { min:unbounded.offsetRange.min, max:unbounded.offsetRange.max, exact:unbounded.offsetRange.exact },
    { min:null, max:null, exact:false },
  );
});
