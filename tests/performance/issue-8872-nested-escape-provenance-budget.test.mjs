import assert from 'node:assert/strict';
import test from 'node:test';

import { createFunctionSummary } from '../../js/analysis/summary/contract.js';
import {
  solveInterproceduralSummaries,
  SUMMARY_PAYLOAD_RESOURCES,
} from '../../js/analysis/summary/interprocedural.js';
import { createAnalysisStatus } from '../../js/analysis/status.js';

const status = () => createAnalysisStatus({
  snapshotId: 'snapshot_8872_nested',
  analyzerId: 'phase7.summary.local',
  analyzerVersion: '1.0.0',
  completeness: 'complete',
});

function sameEscapeChain(n) {
  const locals = new Map();
  for (let i = n - 1; i >= 0; i--) {
    locals.set(`f${i}`, createFunctionSummary({
      functionId: `f${i}`,
      directCalls: i + 1 < n ? [{
        callSiteId: `c${i}`,
        targetEntityIds: [`f${i + 1}`],
        summaryId: null,
        effectSource: 'proven-summary',
      }] : [],
      escapes: [{ kind: 'return', target: 'shared', evidenceIds: [`e${i}`] }],
      status: status(),
    }));
  }
  return locals;
}

test('resident budget counts nested evidence IDs on a deduped escape row', () => {
  const solved = solveInterproceduralSummaries({
    roots: ['f0'],
    localSummaries: sameEscapeChain(8),
    snapshotId: 'snapshot_8872_nested',
    budget: {
      maxResidentSummaryRows: 30,
      maxSummaryMergeRows: 100000,
      maxTransitiveRowsPerSummary: 64,
    },
  });

  assert.equal(solved.status.completeness, 'truncated');
  assert.equal(solved.status.stopReason, 'budget-exhausted');
  assert.equal(solved.budgetStop?.resource, SUMMARY_PAYLOAD_RESOURCES.residentRows);
  assert.equal(solved.summaries.size, 0, 'no prefix survives resident provenance exhaustion');
});

test('same-key escape evidence union is capped before materializing an unbounded provenance list', () => {
  const solved = solveInterproceduralSummaries({
    roots: ['f0'],
    localSummaries: sameEscapeChain(6),
    snapshotId: 'snapshot_8872_nested',
    budget: {
      maxTransitiveRowsPerSummary: 3,
      maxResidentSummaryRows: 100000,
      maxSummaryMergeRows: 100000,
    },
  });

  const root = solved.summaries.get('f0');
  assert.ok(root);
  assert.equal(root.escapes.length, 1);
  assert.ok(root.escapes[0].evidenceIds.length <= 3);
  assert.equal(root.status.completeness, 'truncated');
  assert.equal(solved.status.completeness, 'truncated');
});
