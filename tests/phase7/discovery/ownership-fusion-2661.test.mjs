import assert from 'node:assert/strict';
import test from 'node:test';
import {fuseFunctionCandidates} from '../../../js/analysis/discovery/fusion.js';

const evidence = (producerId, ownership, extentRole = 'complete') => ({
  kind: 'loader-function-start',
  authority: 'authoritative',
  producerId,
  start: '4096',
  extentRole,
  regions: [{start: '4096', end: '4112', ownership}],
});

// Ownership disagreement must remain fail-closed regardless of producer order.
test('same ownership agrees exactly', () => {
  const candidate = fuseFunctionCandidates([
    evidence('a', 'exclusive'),
    evidence('b', 'exclusive'),
  ]).candidates[0];
  assert.equal(candidate.extentState, 'exact');
  assert.equal(candidate.regions[0].ownership, 'exclusive');
  assert.equal(candidate.conflicts.length, 0);
});

test('complete ownership disagreement fails closed independent of order', () => {
  const input = [evidence('a', 'exclusive'), evidence('b', 'shared')];
  for (const value of [input, [...input].reverse()]) {
    const candidate = fuseFunctionCandidates(value).candidates[0];
    assert.equal(candidate.extentState, 'unknown');
    assert.deepEqual(candidate.regions, []);
    assert.ok(candidate.conflicts.some((conflict) => conflict.kind === 'extent'));
  }
});

test('partial ownership disagreement is never silently overwritten', () => {
  const input = [
    evidence('a', 'exclusive', 'partial'),
    evidence('b', 'shared', 'partial'),
  ];
  for (const value of [input, [...input].reverse()]) {
    const candidate = fuseFunctionCandidates(value).candidates[0];
    assert.equal(candidate.extentState, 'unknown');
    assert.deepEqual(candidate.regions, []);
    assert.ok(candidate.conflicts.some((conflict) => /ownership/.test(conflict.detail)));
  }
});
