import assert from 'node:assert/strict';
import test from 'node:test';

import { createMemoryRegionRef } from '../../../js/semantics/memoryssa/contract.js';
import { createPhase7AliasSolver } from '../../../js/analysis/alias/solver.js';
import { createAnalysisStatus } from '../../../js/analysis/status.js';

const region = createMemoryRegionRef({
  id: 'region_cancelled_solver',
  kind: 'stack-fixed',
  functionId: 'function_cancelled_solver',
  binaryId: 'binary_cancelled_solver',
  offset: 0,
  widthBits: 32,
  origin: { instructionIds: ['instruction_cancelled_solver'] },
});

test('aborted signal fails closed even when a complete status is supplied', () => {
  const controller = new AbortController();
  controller.abort();
  const supplied = createAnalysisStatus({
    snapshotId: 'snapshot_cancelled_solver',
    analyzerId: 'upstream.alias',
    analyzerVersion: '1.0.0',
    completeness: 'complete',
    budgetClass: 'interactive',
    stopReason: null,
  });

  const solver = createPhase7AliasSolver({
    ir: null,
    cfg: null,
    ssa: null,
    options: { status: supplied, signal: controller.signal },
  });
  const result = solver.alias(region, region);

  assert.equal(result.relation, 'unknown');
  assert.equal(result.status.completeness, 'partial');
  assert.equal(result.status.stopReason, 'cancelled');
  assert.equal(result.status.snapshotId, supplied.snapshotId);
  assert.equal(result.status.analyzerId, supplied.analyzerId);
  assert.equal(result.status.analyzerVersion, supplied.analyzerVersion);
  assert.equal(result.status.budgetClass, supplied.budgetClass);
  assert.deepEqual(result.reasonCodes, ['analysis-cancelled']);
});
