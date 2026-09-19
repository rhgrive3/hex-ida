import test from 'node:test';
import assert from 'node:assert/strict';

function summarize(states, denominator) {
  const counts = { PASS: 0, FAIL: 0, TIMEOUT: 0, CRASH: 0, NOT_RUN: 0 };
  for (const state of states) counts[state] = (counts[state] || 0) + 1;
  return {
    counts,
    denominator,
    complete: counts.NOT_RUN === 0 && counts.TIMEOUT === 0,
  };
}

test('incomplete timeout remains non-complete and cannot inflate PASS', () => {
  const summary = summarize(['PASS', 'TIMEOUT', 'NOT_RUN'], 3);
  assert.equal(summary.denominator, 3);
  assert.equal(summary.counts.PASS, 1);
  assert.equal(summary.counts.TIMEOUT, 1);
  assert.equal(summary.counts.NOT_RUN, 1);
  assert.equal(summary.complete, false);
});

test('retry completion is required before a corpus can be complete', () => {
  const summary = summarize(['PASS', 'PASS', 'FAIL'], 3);
  assert.equal(summary.denominator, 3);
  assert.equal(summary.counts.PASS, 2);
  assert.equal(summary.complete, true);
  assert.notEqual(summary.counts.PASS, summary.denominator);
});
