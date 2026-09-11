import assert from 'node:assert/strict';
import test from 'node:test';

import { createDiscoveryEvidence } from '../../../js/analysis/discovery/candidates.js';
import { fuseFunctionCandidates } from '../../../js/analysis/discovery/fusion.js';

function partial(kind, producerId, start, end, ownership) {
  return createDiscoveryEvidence({
    kind,
    producerId,
    start: 0x100n,
    extentRole: 'partial',
    regions: [{ start, end, ownership }],
  });
}

function fuse(items) {
  return fuseFunctionCandidates(items, { snapshotId: 'issue-4952' }).candidates[0];
}

test('overlapping authoritative partial ranges with different ownership fail closed', () => {
  const input = [
    partial('unwind-entry', 'unwind', 0x100n, 0x120n, 'exclusive'),
    partial('loader-function-start', 'loader', 0x110n, 0x130n, 'shared'),
  ];

  for (const items of [input, [...input].reverse()]) {
    const candidate = fuse(items);
    assert.equal(candidate.extentState, 'unknown');
    assert.deepEqual(candidate.regions, []);
    assert.ok(candidate.conflicts.some((conflict) =>
      conflict.kind === 'extent' && /ownership/.test(conflict.detail)));
  }
});

test('same ownership may overlap without manufacturing a conflict', () => {
  const candidate = fuse([
    partial('unwind-entry', 'unwind', 0x100n, 0x120n, 'shared'),
    partial('loader-function-start', 'loader', 0x110n, 0x130n, 'shared'),
  ]);

  assert.equal(candidate.extentState, 'exact');
  assert.deepEqual(candidate.regions, [
    { start: '256', end: '288', ownership: 'shared' },
    { start: '272', end: '304', ownership: 'shared' },
  ]);
  assert.equal(candidate.conflicts.length, 0);
});

test('touching or disjoint ranges with different ownership remain compatible', () => {
  for (const secondStart of [0x120n, 0x130n]) {
    const candidate = fuse([
      partial('unwind-entry', 'unwind', 0x100n, 0x120n, 'exclusive'),
      partial('loader-function-start', 'loader', secondStart, secondStart + 0x10n, 'shared'),
    ]);
    assert.equal(candidate.extentState, 'exact');
    assert.equal(candidate.conflicts.length, 0);
  }
});

test('exact-range ownership disagreement remains fail closed', () => {
  const candidate = fuse([
    partial('unwind-entry', 'unwind', 0x100n, 0x120n, 'exclusive'),
    partial('loader-function-start', 'loader', 0x100n, 0x120n, 'ambiguous'),
  ]);
  assert.equal(candidate.extentState, 'unknown');
  assert.deepEqual(candidate.regions, []);
});

function complete(kind, producerId, regions) {
  return createDiscoveryEvidence({
    kind,
    producerId,
    start: 0x100n,
    extentRole: 'complete',
    regions,
  });
}

test('contained partial ownership cannot contradict a complete authoritative claim', () => {
  const candidate = fuse([
    complete('unwind-entry', 'complete', [
      { start: 0x100n, end: 0x140n, ownership: 'exclusive' },
    ]),
    partial('loader-function-start', 'partial', 0x110n, 0x120n, 'shared'),
  ]);

  assert.equal(candidate.extentState, 'unknown');
  assert.deepEqual(candidate.regions, []);
  assert.ok(candidate.conflicts.some((conflict) =>
    conflict.kind === 'extent' && /ownership/.test(conflict.detail)));
});

test('contained partial with matching complete ownership preserves exact extent', () => {
  const candidate = fuse([
    complete('unwind-entry', 'complete', [
      { start: 0x100n, end: 0x140n, ownership: 'shared' },
    ]),
    partial('loader-function-start', 'partial', 0x110n, 0x120n, 'shared'),
  ]);

  assert.equal(candidate.extentState, 'exact');
  assert.deepEqual(candidate.regions, [
    { start: '256', end: '320', ownership: 'shared' },
  ]);
  assert.equal(candidate.conflicts.length, 0);
});

test('touching or disjoint complete ranges with different ownership do not conflict', () => {
  for (const other of [
    { start: 0x120n, end: 0x140n, ownership: 'exclusive' },
    { start: 0x130n, end: 0x140n, ownership: 'exclusive' },
  ]) {
    const candidate = fuse([
      complete('unwind-entry', 'complete', [
        { start: 0x100n, end: 0x120n, ownership: 'shared' },
        other,
      ]),
      partial('loader-function-start', 'partial', 0x110n, 0x120n, 'shared'),
    ]);
    assert.equal(candidate.extentState, 'exact');
    assert.equal(candidate.conflicts.length, 0);
  }
});
