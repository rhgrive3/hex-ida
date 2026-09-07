import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createAnalysisStatus,
  isFailClosedStatus,
  mergeAnalysisStatus,
} from '../../js/analysis/status.js';

function status(completeness, stopReason, overrides = {}) {
  return createAnalysisStatus({
    snapshotId: 'issue-5307',
    analyzerId: 'issue-5307',
    analyzerVersion: '1',
    completeness,
    stopReason,
    ...overrides,
  });
}

function semanticProjection(value) {
  return {
    completeness: value.completeness,
    stopReason: value.stopReason,
    budgetClass: value.budgetClass,
    evidenceIds: value.evidenceIds,
    dependencyIds: value.dependencyIds,
  };
}

test('#5307 weakest non-fail-closed status supplies the canonical stop reason independent of order', () => {
  const partial = status('partial', 'evidence-missing', {
    budgetClass: 'interactive',
    evidenceIds: ['e-partial'],
    dependencyIds: ['d-partial'],
  });
  const truncated = status('truncated', 'unsupported-input', {
    budgetClass: 'interactive',
    evidenceIds: ['e-truncated'],
    dependencyIds: ['d-truncated'],
  });

  const forward = mergeAnalysisStatus(partial, truncated);
  const reverse = mergeAnalysisStatus(truncated, partial);

  assert.equal(forward.completeness, 'truncated');
  assert.equal(forward.stopReason, 'unsupported-input');
  assert.deepEqual(semanticProjection(forward), semanticProjection(reverse));
  assert.deepEqual(forward.evidenceIds, ['e-partial', 'e-truncated']);
  assert.deepEqual(forward.dependencyIds, ['d-partial', 'd-truncated']);
});

test('#5307 fail-closed authority propagates even when a weaker non-fail-closed status is present', () => {
  const cancelled = status('partial', 'cancelled');
  const unsupported = status('unsupported', 'unsupported-input');

  const forward = mergeAnalysisStatus(cancelled, unsupported);
  const reverse = mergeAnalysisStatus(unsupported, cancelled);

  assert.equal(forward.completeness, 'unsupported');
  assert.equal(forward.stopReason, 'cancelled');
  assert.equal(isFailClosedStatus(forward), true);
  assert.deepEqual(semanticProjection(forward), semanticProjection(reverse));
});

test('#5307 equal-completeness reasons use a deterministic declared-vocabulary tie-break', () => {
  const widened = status('partial', 'widened');
  const missing = status('partial', 'evidence-missing');

  const forward = mergeAnalysisStatus(widened, missing);
  const reverse = mergeAnalysisStatus(missing, widened);

  assert.equal(forward.completeness, 'partial');
  assert.equal(forward.stopReason, 'widened');
  assert.deepEqual(semanticProjection(forward), semanticProjection(reverse));
});

test('#5307 equal-completeness fail-closed reasons are deterministic and stay fail closed', () => {
  const cancelled = status('truncated', 'cancelled');
  const timeout = status('truncated', 'timeout');

  const forward = mergeAnalysisStatus(timeout, cancelled);
  const reverse = mergeAnalysisStatus(cancelled, timeout);

  assert.equal(forward.completeness, 'truncated');
  assert.equal(forward.stopReason, 'cancelled');
  assert.equal(isFailClosedStatus(forward), true);
  assert.deepEqual(semanticProjection(forward), semanticProjection(reverse));
});

test('#5307 complete merge remains complete with no fabricated stop reason', () => {
  const left = status('complete', null, { evidenceIds: ['e2'] });
  const right = status('complete', null, { evidenceIds: ['e1'] });
  const merged = mergeAnalysisStatus(left, right);

  assert.equal(merged.completeness, 'complete');
  assert.equal(merged.stopReason, null);
  assert.deepEqual(merged.evidenceIds, ['e1', 'e2']);
});
