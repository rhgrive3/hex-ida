/*
 * Regression: #5138 — an authoritative `extentRole:'partial'` must never be
 * promoted to a whole-function `extentState:'exact'`.
 *
 * `authoritative` certifies the geometry of the range the producer named; it
 * does not certify that the function body is *closed* by those ranges. Start
 * and extent completeness are separate axes (P7-INV-006). Region precision from
 * an authoritative partial is still kept; only the false whole-extent
 * completeness claim is withdrawn.
 */
import assert from 'node:assert/strict';

import {
  createDiscoveryEvidence,
  hasKnownExtent,
} from '../js/analysis/discovery/candidates.js';
import { fuseFunctionCandidates } from '../js/analysis/discovery/fusion.js';

function fused(evidence) {
  const result = fuseFunctionCandidates(evidence, {
    architectureId: 'arm64',
    snapshotId: 'snapshot-5138',
  });
  assert.equal(result.candidates.length, 1, 'expected exactly one candidate');
  return result.candidates[0];
}

function extent(kind, extentRole, regions, { producerId = 'p1', start = 0x1000n } = {}) {
  return createDiscoveryEvidence({ kind, extentRole, start, regions, producerId });
}

function hasConflict(candidate, test) {
  return candidate.conflicts.some((conflict) => conflict.kind === 'extent' && test.test(conflict.detail));
}

// (1) single authoritative partial: not a whole exact extent, fragment precision kept.
{
  const candidate = fused([
    extent('loader-function-start', 'partial', [{ start: 0x1000n, end: 0x1010n, ownership: 'exclusive' }], { producerId: 'loader' }),
  ]);
  assert.notEqual(candidate.extentState, 'exact', 'an authoritative partial alone must not certify a whole exact extent');
  assert.equal(candidate.extentState, 'unknown', 'whole-extent completeness stays unknown without a complete claim');
  assert.deepEqual(candidate.regions, [{ start: '4096', end: '4112', ownership: 'exclusive' }], 'the authoritative partial range itself must not be discarded');
  assert.equal(hasKnownExtent(candidate), false, 'a partial-known extent is not a known whole extent');
  assert.equal(candidate.startState, 'exact', 'the start axis is unaffected');
  assert.equal(candidate.conflicts.length, 0, 'incomplete-but-consistent partial evidence is not a contradiction');
}

// (2) multiple authoritative partials unioned: still no complete claim, so not exact.
{
  const candidate = fused([
    extent('unwind-entry', 'partial', [{ start: 0x1000n, end: 0x1010n, ownership: 'exclusive' }], { producerId: 'u1' }),
    extent('debug-symbol', 'partial', [{ start: 0x1020n, end: 0x1030n, ownership: 'exclusive' }], { producerId: 'd1' }),
  ]);
  assert.notEqual(candidate.extentState, 'exact', 'a union of partials without a complete claim must not become a whole exact extent');
  assert.equal(candidate.extentState, 'unknown');
  assert.equal(candidate.regions.length, 2, 'both authoritative fragments remain available');
  assert.equal(hasKnownExtent(candidate), false);
}

// (3) authoritative complete matching evidence still yields an exact extent.
{
  const single = fused([
    extent('loader-function-start', 'complete', [{ start: 0x1000n, end: 0x1010n, ownership: 'exclusive' }], { producerId: 'loader' }),
  ]);
  assert.equal(single.extentState, 'exact', 'an authoritative complete claim must keep the exact extent');
  assert.equal(hasKnownExtent(single), true);

  const agreeing = fused([
    extent('loader-function-start', 'complete', [{ start: 0x1000n, end: 0x1020n, ownership: 'exclusive' }], { producerId: 'loader' }),
    extent('unwind-entry', 'complete', [{ start: 0x1000n, end: 0x1020n, ownership: 'exclusive' }], { producerId: 'u1' }),
  ]);
  assert.equal(agreeing.extentState, 'exact', 'agreeing authoritative complete claims remain exact');
}

// (4) disagreeing complete extents stay a conflict / unknown (unchanged behaviour).
{
  const candidate = fused([
    extent('loader-function-start', 'complete', [{ start: 0x1000n, end: 0x1010n, ownership: 'exclusive' }], { producerId: 'loader' }),
    extent('unwind-entry', 'complete', [{ start: 0x1000n, end: 0x1040n, ownership: 'exclusive' }], { producerId: 'u1' }),
  ]);
  assert.equal(candidate.extentState, 'unknown', 'disagreeing complete extents must not be voted into an extent');
  assert.deepEqual(candidate.regions, []);
  assert.ok(hasConflict(candidate, /extent evidence disagrees/));
}

// (4b) an authoritative partial outside a matching complete claim is a direct
// contradiction and must withdraw the exact claim (partial is never excluded
// from the contradiction check just because a complete claim exists).
{
  const candidate = fused([
    extent('loader-function-start', 'complete', [{ start: 0x1000n, end: 0x1010n, ownership: 'exclusive' }], { producerId: 'loader' }),
    extent('debug-symbol', 'partial', [{ start: 0x1020n, end: 0x1030n, ownership: 'exclusive' }], { producerId: 'd1' }),
  ]);
  assert.equal(candidate.extentState, 'unknown', 'a partial outside the complete claim contradicts its whole extent');
  assert.ok(hasConflict(candidate, /reaches outside the complete claim/));
}

// (4c) a partial contained inside the complete claim keeps the exact extent.
{
  const candidate = fused([
    extent('loader-function-start', 'complete', [{ start: 0x1000n, end: 0x1020n, ownership: 'exclusive' }], { producerId: 'loader' }),
    extent('debug-symbol', 'partial', [{ start: 0x1008n, end: 0x1010n, ownership: 'exclusive' }], { producerId: 'd1' }),
  ]);
  assert.equal(candidate.extentState, 'exact', 'a contained partial refines rather than contradicts the complete claim');
}

// (5) disagreeing ownership across partials still fails closed (regions withdrawn).
{
  const candidate = fused([
    extent('loader-function-start', 'partial', [{ start: 0x1000n, end: 0x1010n, ownership: 'exclusive' }], { producerId: 'a' }),
    extent('loader-function-start', 'partial', [{ start: 0x1000n, end: 0x1010n, ownership: 'shared' }], { producerId: 'b' }),
  ]);
  assert.equal(candidate.extentState, 'unknown');
  assert.deepEqual(candidate.regions, [], 'an ownership contradiction on the same range withdraws the fragment too');
  assert.ok(hasConflict(candidate, /ownership evidence disagrees/));
}

// (6) overlap/swallowed-start validation distinguishes partial-known regions
// from a whole exact extent: a partial fragment that happens to span another
// function start is not a swallowed-start overclaim, but an authoritative
// complete extent covering another start still is.
{
  const result = fuseFunctionCandidates([
    extent('loader-function-start', 'partial', [{ start: 0x1000n, end: 0x1030n, ownership: 'exclusive' }], { producerId: 'loader', start: 0x1000n }),
    extent('unwind-entry', 'complete', [{ start: 0x1010n, end: 0x1020n, ownership: 'exclusive' }], { producerId: 'u1', start: 0x1010n }),
  ], { architectureId: 'arm64', snapshotId: 'snapshot-5138' });
  const byStart = new Map(result.candidates.map((c) => [BigInt(c.start), c]));
  const fragment = byStart.get(0x1000n);
  assert.equal(fragment.extentState, 'unknown', 'partial-only stays incomplete');
  assert.deepEqual(fragment.regions, [{ start: '4096', end: '4144', ownership: 'exclusive' }], 'the partial fragment is not downgraded for spanning another start');
  assert.ok(!hasConflict(fragment, /contains another function start/), 'a partial-known fragment must not be judged as a whole-extent swallow');
}
{
  const result = fuseFunctionCandidates([
    extent('loader-function-start', 'complete', [{ start: 0x1000n, end: 0x1030n, ownership: 'exclusive' }], { producerId: 'loader', start: 0x1000n }),
    extent('unwind-entry', 'complete', [{ start: 0x1010n, end: 0x1020n, ownership: 'exclusive' }], { producerId: 'u1', start: 0x1010n }),
  ], { architectureId: 'arm64', snapshotId: 'snapshot-5138' });
  const byStart = new Map(result.candidates.map((c) => [BigInt(c.start), c]));
  const whole = byStart.get(0x1000n);
  assert.ok(hasConflict(whole, /contains another function start/), 'a whole exact extent spanning another start is still withdrawn');
}

console.log('issue-5138 regression: all assertions passed');
