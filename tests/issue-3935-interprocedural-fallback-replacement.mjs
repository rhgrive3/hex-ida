import assert from 'node:assert/strict';
import test from 'node:test';

import { createAnalysisStatus } from '../js/analysis/status.js';
import {
  createFunctionSummary,
  createMemoryEffect,
  summaryIsPure,
} from '../js/analysis/summary/contract.js';
import { solveInterproceduralSummaries } from '../js/analysis/summary/interprocedural.js';

const status = (completeness, stopReason = null) => createAnalysisStatus({
  snapshotId: 's',
  analyzerId: 'local',
  analyzerVersion: '1',
  completeness,
  stopReason,
});

test('#3935 resolved pure callee closes the local summary-missing fallback', () => {
  const B = createFunctionSummary({ functionId: 'B', status: status('complete') });
  const A = createFunctionSummary({
    functionId: 'A',
    directCalls: [{
      callSiteId: 'call-B',
      targetEntityIds: ['B'],
      effectSource: 'unknown-call-fallback',
    }],
    unknownCallEffects: [{
      callSiteId: 'call-B',
      reason: 'summary-missing',
      targetEntityIds: ['B'],
    }],
    memoryWriteRegions: [createMemoryEffect({
      regionKind: 'unknown',
      broad: true,
      addressSpaces: ['memory'],
      source: 'unknown-call-fallback',
    })],
    noreturn: 'unknown',
    mayThrow: 'unknown',
    status: status('partial', 'evidence-missing'),
  });

  const solvedA = solveInterproceduralSummaries({
    roots: ['A'],
    localSummaries: new Map([['A', A], ['B', B]]),
  }).summaries.get('A');

  assert.equal(solvedA.unknownCallEffects.length, 0);
  assert.equal(solvedA.memoryWriteRegions.length, 0);
  assert.equal(solvedA.status.completeness, 'complete');
  assert.equal(summaryIsPure(solvedA), true);
});
