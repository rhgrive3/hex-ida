import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createFunctionSummary,
  createMemoryEffect,
  summaryIsPure,
} from '../../../js/analysis/summary/contract.js';

const status = {
  snapshotId: 'snap-5346',
  analyzerId: 'summary',
  analyzerVersion: '1',
  completeness: 'complete',
};

const base = {
  functionId: 'f',
  inputs: [],
  returnValues: [],
  returnProvenance: [],
  registerEffects: [],
  memoryReadRegions: [],
  memoryWriteRegions: [],
  escapes: [],
  allocations: [],
  frees: [],
  directCalls: [],
  indirectCallSets: [],
  unknownCallEffects: [],
  noreturn: false,
  mayThrow: false,
  stackDelta: null,
  semanticFacts: [],
  status,
};

// #5346: `exhaustive:true` claims the candidate universe is complete and lets
// the summary drop the unknown-call fallback. An empty candidate set makes
// that claim describe an indirect call with *no possible target* — a
// contradiction that published complete/pure summaries with an unresolved
// call silently deleted.

test('#5346 an empty exhaustive indirect set fails closed', () => {
  assert.throws(
    () => createFunctionSummary({
      ...base,
      indirectCallSets: [{ callSiteId: 'call-1', candidateEntityIds: [], exhaustive: true, evidenceIds: [] }],
    }),
    /function-summary-exhaustive-indirect-requires-candidates/,
  );
});

test('#5346 an empty non-exhaustive indirect set stays valid (it carries a fallback)', () => {
  const summary = createFunctionSummary({
    ...base,
    status: { ...status, completeness: 'partial', stopReason: 'evidence-missing' },
    noreturn: 'unknown',
    mayThrow: 'unknown',
    status: { ...status, completeness: 'partial', stopReason: 'evidence-missing' },
    memoryWriteRegions: [createMemoryEffect({ regionKind: 'unknown', broad: true, addressSpaces: ['memory'], source: 'unknown-call-fallback', evidenceIds: ['ev-5346'] })],
    unknownCallEffects: [{
      callSiteId: 'call-1',
      reason: 'indirect-incomplete-target-set',
      targetEntityIds: [],
      evidenceIds: [],
    }],
    indirectCallSets: [{ callSiteId: 'call-1', candidateEntityIds: [], exhaustive: false, evidenceIds: [] }],
  });
  assert.equal(summary.status.completeness, 'partial');
  assert.notEqual(summaryIsPure(summary), true, 'a call with an unknown target universe is not pure');
});

test('#5346 a non-empty exhaustive indirect set keeps its exact semantics', () => {
  const summary = createFunctionSummary({
    ...base,
    memoryWriteRegions: [],
    indirectCallSets: [{ callSiteId: 'call-1', candidateEntityIds: ['callee-1'], exhaustive: true, evidenceIds: [] }],
  });
  assert.equal(summary.indirectCallSets[0].exhaustive, true);
  assert.equal(summary.indirectCallSets[0].candidateEntityIds.length, 1);
});
