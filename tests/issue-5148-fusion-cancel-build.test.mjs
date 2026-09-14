import test from 'node:test';
import assert from 'node:assert/strict';

import { fuseFunctionCandidates } from '../js/analysis/discovery/fusion.js';

function instrumented(start, index, seen, hooks = {}) {
  return {
    get kind() {
      if (!seen.has(index)) {
        seen.add(index);
        hooks.onConsume?.(seen.size);
      }
      return 'direct-call-target';
    },
    producerId: 'p',
    extentRole: 'complete',
    start,
    regions: [],
  };
}

function hugeUniqueStarts(count, seen, hooks = {}) {
  return Array.from({ length: count }, (_, index) => instrumented(String(BigInt(index) * 0x1000n), index, seen, hooks));
}

function row(start, producerId, overrides = {}) {
  return {
    kind: 'direct-call-target',
    producerId,
    extentRole: 'complete',
    start,
    regions: [],
    ...overrides,
  };
}

test('#5148 maxCandidates=1 bounds ingestion on a huge unique-start array', () => {
  const seen = new Set();
  const result = fuseFunctionCandidates(hugeUniqueStarts(100_000, seen), {
    snapshotId: 'issue-5148-budget',
    budget: { maxCandidates: 1, maxEvidencePerCandidate: 1 },
  });
  assert.deepEqual(result.candidates, []);
  assert.equal(result.status.completeness, 'truncated');
  assert.equal(result.status.stopReason, 'budget-exhausted');
  assert.ok(seen.size <= 2, `ingestion consumed ${seen.size} records despite maxCandidates=1`);
});

test('#5148 abort during candidate-build ingestion stops consumption promptly', () => {
  const controller = new AbortController();
  const seen = new Set();
  const evidence = hugeUniqueStarts(20_000, seen, {
    onConsume: (count) => {
      if (count === 8) controller.abort();
    },
  });
  const result = fuseFunctionCandidates(evidence, {
    snapshotId: 'issue-5148-cancel',
    budget: { maxCandidates: 20_000, maxEvidencePerCandidate: 4 },
    signal: controller.signal,
  });
  assert.deepEqual(result.candidates, []);
  assert.equal(result.status.completeness, 'partial');
  assert.equal(result.status.stopReason, 'cancelled');
  assert.ok(seen.size <= 64, `build loop consumed ${seen.size} records after abort at 8`);
});

test('#5148 budget truncation publishes no candidates regardless of arrival order', () => {
  const options = {
    snapshotId: 'issue-5148-order',
    budget: { maxCandidates: 2, maxEvidencePerCandidate: 4 },
  };
  const forward = fuseFunctionCandidates([
    row('4096', 'a'),
    row('8192', 'b'),
    row('12288', 'c', { kind: 'loader-function-start' }),
  ], options);
  const reverse = fuseFunctionCandidates([
    row('12288', 'c', { kind: 'loader-function-start' }),
    row('8192', 'b'),
    row('4096', 'a'),
  ], options);
  assert.equal(forward.status.completeness, 'truncated');
  assert.equal(reverse.status.completeness, 'truncated');
  assert.deepEqual(forward.candidates, []);
  assert.deepEqual(reverse.candidates, []);
});

test('#5148 pre-aborted signal consumes no evidence', () => {
  const controller = new AbortController();
  controller.abort();
  const seen = new Set();
  const result = fuseFunctionCandidates(hugeUniqueStarts(100, seen), {
    snapshotId: 'issue-5148-preabort',
    signal: controller.signal,
  });
  assert.equal(result.status.completeness, 'partial');
  assert.equal(result.status.stopReason, 'cancelled');
  assert.equal(seen.size, 0);
});
