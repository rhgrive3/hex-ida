import assert from 'node:assert/strict';
import test from 'node:test';
import { fuseFunctionCandidates } from '../../../js/analysis/discovery/fusion.js';

function authoritativeEvidence(producerId, start, regions) {
  return {
    kind: 'debug-symbol',
    authority: 'authoritative',
    producerId,
    start: BigInt(start).toString(),
    extentRole: 'complete',
    regions: regions.map(([regionStart, regionEnd, ownership]) => ({
      start: BigInt(regionStart).toString(),
      end: BigInt(regionEnd).toString(),
      ownership,
    })),
    evidenceIds: [`${producerId}:extent`],
  };
}

function byStart(result) {
  return new Map(result.candidates.map((candidate) => [BigInt(candidate.start), candidate]));
}

function assertKnownShared(candidate) {
  assert.equal(candidate.extentState, 'exact');
  assert.ok(candidate.regions.length > 0);
  assert.ok(candidate.regions.every((region) => region.ownership === 'shared'));
  assert.equal(candidate.conflicts.some((conflict) => conflict.kind === 'extent'), false);
}

test('shared/shared overlap preserves both extents even when one range contains the other start', () => {
  const result = fuseFunctionCandidates([
    authoritativeEvidence('dbg-a', 0x1000n, [[0x1000n, 0x1020n, 'shared']]),
    authoritativeEvidence('dbg-b', 0x1010n, [[0x1010n, 0x1030n, 'shared']]),
  ]);
  const candidates = byStart(result);

  assertKnownShared(candidates.get(0x1000n));
  assertKnownShared(candidates.get(0x1010n));
});

test('shared/shared tail overlap remains valid without start containment', () => {
  const result = fuseFunctionCandidates([
    authoritativeEvidence('dbg-a', 0x1000n, [[0x3000n, 0x3020n, 'shared']]),
    authoritativeEvidence('dbg-b', 0x2000n, [[0x3010n, 0x3030n, 'shared']]),
  ]);

  for (const candidate of result.candidates) assertKnownShared(candidate);
});

test('mixed and ambiguous ownership stay fail-closed', () => {
  for (const otherOwnership of ['exclusive', 'ambiguous']) {
    const result = fuseFunctionCandidates([
      authoritativeEvidence('dbg-a', 0x1000n, [[0x3000n, 0x3020n, 'shared']]),
      authoritativeEvidence('dbg-b', 0x2000n, [[0x3010n, 0x3030n, otherOwnership]]),
    ]);

    for (const candidate of result.candidates) {
      assert.equal(candidate.extentState, 'unknown');
      assert.deepEqual(candidate.regions, []);
      assert.ok(candidate.conflicts.some((conflict) => conflict.kind === 'extent'));
    }
  }
});

test('exclusive overlap and swallowed starts retain existing conflict behavior', () => {
  const result = fuseFunctionCandidates([
    authoritativeEvidence('dbg-a', 0x1000n, [[0x1000n, 0x1020n, 'exclusive']]),
    authoritativeEvidence('dbg-b', 0x1010n, [[0x1010n, 0x1030n, 'exclusive']]),
  ]);
  const candidates = byStart(result);

  for (const candidate of candidates.values()) {
    assert.equal(candidate.extentState, 'unknown');
    assert.deepEqual(candidate.regions, []);
    assert.ok(candidate.conflicts.some((conflict) => conflict.kind === 'extent'));
  }
  assert.ok(candidates.get(0x1000n).conflicts.some((conflict) => /contains another function start/.test(conflict.detail)));
});

test('touching half-open extents remain non-overlapping', () => {
  const result = fuseFunctionCandidates([
    authoritativeEvidence('dbg-a', 0x1000n, [[0x1000n, 0x1010n, 'exclusive']]),
    authoritativeEvidence('dbg-b', 0x1010n, [[0x1010n, 0x1020n, 'exclusive']]),
  ]);

  for (const candidate of result.candidates) {
    assert.equal(candidate.extentState, 'exact');
    assert.equal(candidate.conflicts.some((conflict) => conflict.kind === 'extent'), false);
  }
});
