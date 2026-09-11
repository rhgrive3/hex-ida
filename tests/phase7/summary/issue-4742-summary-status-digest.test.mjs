import assert from 'node:assert/strict';
import test from 'node:test';

import { createAnalysisStatus } from '../../../js/analysis/status.js';
import {
  createFunctionSummary,
  functionSummaryDigest,
} from '../../../js/analysis/summary/contract.js';

function status(overrides = {}) {
  return createAnalysisStatus({
    snapshotId: 'snapshot-a',
    analyzerId: 'phase7.summary.local',
    analyzerVersion: '1.0.0',
    completeness: 'complete',
    ...overrides,
  });
}

function summary(statusValue) {
  return createFunctionSummary({
    functionId: 'fn_status_digest',
    status: statusValue,
    noreturn: false,
    mayThrow: false,
  });
}

test('evidence provenance participates in FunctionSummary dependency identity (#4742)', () => {
  const before = summary(status({ evidenceIds: ['e1'] }));
  const after = summary(status({ evidenceIds: ['e1', 'e2'] }));
  assert.notEqual(functionSummaryDigest(before), functionSummaryDigest(after));
});

test('dependency provenance participates in FunctionSummary dependency identity (#4742)', () => {
  const before = summary(status({ dependencyIds: ['d1'] }));
  const after = summary(status({ dependencyIds: ['d1', 'd2'] }));
  assert.notEqual(functionSummaryDigest(before), functionSummaryDigest(after));
});

test('snapshot and budget identity participate in FunctionSummary dependency identity (#4742)', () => {
  const reference = functionSummaryDigest(summary(status({ budgetClass: 'interactive' })));
  assert.notEqual(reference, functionSummaryDigest(summary(status({ snapshotId: 'snapshot-b', budgetClass: 'interactive' }))));
  assert.notEqual(reference, functionSummaryDigest(summary(status({ budgetClass: 'background' }))));
});

test('canonical status ordering remains digest-stable (#4742)', () => {
  const left = summary(status({ evidenceIds: ['e2', 'e1', 'e2'], dependencyIds: ['d2', 'd1'] }));
  const right = summary(status({ evidenceIds: ['e1', 'e2'], dependencyIds: ['d1', 'd2'] }));
  assert.equal(functionSummaryDigest(left), functionSummaryDigest(right));
});

test('provenance-only growth advances the recursive fixed-point key (#4742)', () => {
  const previous = summary(status({ evidenceIds: ['callee:e1'], dependencyIds: ['summary:d1'] }));
  const next = summary(status({ evidenceIds: ['callee:e1', 'callee:e2'], dependencyIds: ['summary:d1', 'summary:d2'] }));

  // This is the exact convergence predicate used by solveInterproceduralSummaries:
  // a new summary is published only when its digest differs from the prior one.
  let published = previous;
  let digest = functionSummaryDigest(previous);
  const nextDigest = functionSummaryDigest(next);
  if (digest !== nextDigest) {
    digest = nextDigest;
    published = next;
  }

  assert.equal(digest, nextDigest);
  assert.deepEqual(published.status.evidenceIds, ['callee:e1', 'callee:e2']);
  assert.deepEqual(published.status.dependencyIds, ['summary:d1', 'summary:d2']);
});
