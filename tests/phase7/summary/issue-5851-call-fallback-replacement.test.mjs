import assert from 'node:assert/strict';
import test from 'node:test';

import { createAnalysisStatus } from '../../../js/analysis/status.js';
import {
  createFunctionSummary,
  createDirectCall,
  createIndirectCallSet,
  createMemoryEffect,
  createUnknownCallEffect,
  summaryIsPure,
} from '../../../js/analysis/summary/contract.js';
import { solveInterproceduralSummaries } from '../../../js/analysis/summary/interprocedural.js';

const completeStatus = () => createAnalysisStatus({
  snapshotId: 'snapshot_issue_5851',
  analyzerId: 'phase7.summary.local',
  analyzerVersion: '1.0.0',
  completeness: 'complete',
});

const partialStatus = () => createAnalysisStatus({
  snapshotId: 'snapshot_issue_5851',
  analyzerId: 'phase7.summary.local',
  analyzerVersion: '1.0.0',
  completeness: 'partial',
  stopReason: 'evidence-missing',
});

const broadFallbackWrite = () => createMemoryEffect({
  regionKind: 'unknown',
  broad: true,
  addressSpaces: ['memory'],
  source: 'unknown-call-fallback',
});

const broadFallbackRead = () => createMemoryEffect({
  regionKind: 'unknown',
  broad: true,
  addressSpaces: ['memory'],
  source: 'unknown-call-fallback',
});

const pureCallee = (functionId) => createFunctionSummary({
  functionId,
  status: completeStatus(),
});

const writingCallee = (functionId, regionId) => createFunctionSummary({
  functionId,
  memoryWriteRegions: [createMemoryEffect({
    regionId,
    regionKind: 'global-absolute',
    addressSpaces: ['memory'],
    source: 'proven-summary',
  })],
  status: completeStatus(),
});

function callerWithFallback(functionId, target, { indirect = false, exhaustive = false } = {}) {
  const callSiteId = indirect ? `indirect_${functionId}` : `call_${target}`;
  return createFunctionSummary({
    functionId,
    directCalls: indirect ? [] : [createDirectCall({
      callSiteId,
      targetEntityIds: [target],
      summaryId: null,
      effectSource: 'unknown-call-fallback',
    })],
    indirectCallSets: indirect ? [createIndirectCallSet({
      callSiteId,
      candidateEntityIds: [target],
      exhaustive,
    })] : [],
    memoryReadRegions: [broadFallbackRead()],
    memoryWriteRegions: [broadFallbackWrite()],
    unknownCallEffects: [createUnknownCallEffect({
      callSiteId,
      reason: 'summary-missing',
      targetEntityIds: [target],
    })],
    noreturn: 'unknown',
    mayThrow: 'unknown',
    status: partialStatus(),
  });
}

test('#5851 a solved pure callee closes the call boundary left open by the local fallback', () => {
  const localA = callerWithFallback('A', 'B');
  const localB = pureCallee('B');

  const solved = solveInterproceduralSummaries({
    roots: ['A'],
    localSummaries: new Map([['A', localA], ['B', localB]]),
  });
  const summary = solved.summaries.get('A');

  assert.equal(summary.unknownCallEffects.length, 0,
    'a resolved call site must not keep its local summary-missing placeholder');
  assert.ok(!summary.memoryWriteRegions.some((effect) => effect.broad),
    'the local unknown-call-fallback broad write must be replaced by the callee effects');
  assert.ok(!summary.memoryReadRegions.some((effect) => effect.broad),
    'the local unknown-call-fallback broad read must be replaced by the callee effects');
  assert.equal(summary.status.completeness, 'complete');
  assert.equal(summaryIsPure(summary), true);
});

test('#5851 a solved writing callee replaces the fallback with its specific write', () => {
  const localA = callerWithFallback('A', 'B');
  const localB = writingCallee('B', 'region_b');

  const summary = solveInterproceduralSummaries({
    roots: ['A'],
    localSummaries: new Map([['A', localA], ['B', localB]]),
  }).summaries.get('A');

  assert.equal(summary.unknownCallEffects.length, 0);
  assert.ok(summary.memoryWriteRegions.some((effect) => effect.regionId === 'region_b'),
    'the callee write must be inherited');
  assert.ok(!summary.memoryWriteRegions.some((effect) => effect.broad),
    'the fallback must be replaced, not unioned with the resolved callee effect');
  assert.equal(summary.status.completeness, 'complete');
});

test('#5851 a missing callee summary keeps the local fallback exactly as before', () => {
  const localA = callerWithFallback('A', 'B');

  const summary = solveInterproceduralSummaries({
    roots: ['A'],
    localSummaries: new Map([['A', localA]]),
  }).summaries.get('A');

  assert.ok(summary.unknownCallEffects.length > 0);
  assert.ok(summary.memoryWriteRegions.some((effect) => effect.broad));
  assert.notEqual(summary.status.completeness, 'complete');
  assert.equal(summaryIsPure(summary), false);
});

test('#5851 a non-exhaustive indirect call keeps its fallback even when every current candidate is solved', () => {
  const localA = callerWithFallback('A', 'B', { indirect: true, exhaustive: false });
  const localB = pureCallee('B');

  const summary = solveInterproceduralSummaries({
    roots: ['A'],
    localSummaries: new Map([['A', localA], ['B', localB]]),
  }).summaries.get('A');

  // A non-exhaustive candidate set may still gain targets, so the fallback
  // cannot be replaced: the composition must add a fresh unresolved effect.
  assert.ok(summary.unknownCallEffects.length > 0);
  assert.ok(summary.memoryWriteRegions.some((effect) => effect.broad));
  assert.notEqual(summary.status.completeness, 'complete');
});

test('#5851 a proven exhaustive indirect call replaces the fallback with the solved candidates', () => {
  const localA = callerWithFallback('A', 'B', { indirect: true, exhaustive: true });
  const localB = writingCallee('B', 'region_b');

  const summary = solveInterproceduralSummaries({
    roots: ['A'],
    localSummaries: new Map([['A', localA], ['B', localB]]),
  }).summaries.get('A');

  assert.equal(summary.unknownCallEffects.length, 0);
  assert.ok(summary.memoryWriteRegions.some((effect) => effect.regionId === 'region_b'));
  assert.ok(!summary.memoryWriteRegions.some((effect) => effect.broad));
  assert.equal(summary.status.completeness, 'complete');
});

test('#5851 non-call unknowns keep the local fallback; only fully resolved call sites are replaced', () => {
  const localA = createFunctionSummary({
    functionId: 'A',
    directCalls: [createDirectCall({
      callSiteId: 'call_B',
      targetEntityIds: ['B'],
      summaryId: null,
      effectSource: 'unknown-call-fallback',
    })],
    memoryReadRegions: [broadFallbackRead()],
    memoryWriteRegions: [broadFallbackWrite()],
    // One unknown from a non-call node (unresolved memory effect) plus the
    // call fallback: the broad effects are not per-call-site attributable, so
    // nothing may be dropped.
    unknownCallEffects: [
      createUnknownCallEffect({ callSiteId: 'unresolved_memory_effect', reason: 'unresolved-target' }),
      createUnknownCallEffect({ callSiteId: 'call_B', reason: 'summary-missing', targetEntityIds: ['B'] }),
    ],
    noreturn: 'unknown',
    mayThrow: 'unknown',
    status: partialStatus(),
  });
  const localB = pureCallee('B');

  const summary = solveInterproceduralSummaries({
    roots: ['A'],
    localSummaries: new Map([['A', localA], ['B', localB]]),
  }).summaries.get('A');

  assert.ok(summary.unknownCallEffects.some((unknown) => unknown.callSiteId === 'unresolved_memory_effect'),
    'the non-call unknown must survive');
  assert.ok(summary.unknownCallEffects.some((unknown) => unknown.callSiteId === 'call_B'),
    'the call unknown survives with the fallback because the fallback is not attributable per site');
  assert.ok(summary.memoryWriteRegions.some((effect) => effect.broad),
    'the local broad fallback must be kept while a non-call unknown exists');
  assert.notEqual(summary.status.completeness, 'complete');
});

test('#5851 a partially resolved direct call keeps its fallback', () => {
  // A calls B and C; only B is solved. The call site is not fully resolved,
  // so the conservative fallback must stay.
  const localA = createFunctionSummary({
    functionId: 'A',
    directCalls: [createDirectCall({
      callSiteId: 'call_BC',
      targetEntityIds: ['B', 'C'],
      summaryId: null,
      effectSource: 'unknown-call-fallback',
    })],
    memoryReadRegions: [broadFallbackRead()],
    memoryWriteRegions: [broadFallbackWrite()],
    unknownCallEffects: [createUnknownCallEffect({
      callSiteId: 'call_BC',
      reason: 'summary-missing',
      targetEntityIds: ['B', 'C'],
    })],
    noreturn: 'unknown',
    mayThrow: 'unknown',
    status: partialStatus(),
  });
  const localB = pureCallee('B');

  const summary = solveInterproceduralSummaries({
    roots: ['A'],
    localSummaries: new Map([['A', localA], ['B', localB]]),
  }).summaries.get('A');

  assert.ok(summary.unknownCallEffects.length > 0,
    'the unsolved C must keep the call boundary open');
  assert.ok(summary.memoryWriteRegions.some((effect) => effect.broad));
  assert.notEqual(summary.status.completeness, 'complete');
});

test('#5851 a library-model-covered external call keeps its conservative treatment', () => {
  // The model path adds the model's effects, but a model is not a proven
  // summary: the site was never solved, so the local fallback must stay in
  // place and the boundary remains explicitly unresolved.
  const localA = callerWithFallback('A', 'ext');
  const model = {
    memoryWriteRegions: [createMemoryEffect({
      regionId: 'region_model',
      regionKind: 'global-absolute',
      addressSpaces: ['memory'],
      source: 'library-model',
    })],
    noreturn: false,
    mayThrow: false,
  };

  const summary = solveInterproceduralSummaries({
    roots: ['A'],
    localSummaries: new Map([['A', localA]]),
    libraryModels: new Map([['ext', model]]),
  }).summaries.get('A');

  assert.ok(summary.memoryWriteRegions.some((effect) => effect.regionId === 'region_model'),
    'the model write must be applied');
  assert.ok(summary.unknownCallEffects.some((unknown) => unknown.callSiteId === 'call_ext'),
    'an unsolved, model-covered call keeps its unresolved boundary');
  assert.ok(summary.memoryWriteRegions.some((effect) => effect.broad),
    'the local fallback stays because the call site was not solved');
  assert.notEqual(summary.status.completeness, 'complete');
});

test('#5851 a chain closes each boundary: caller of a caller reaches complete', () => {
  const localA = callerWithFallback('A', 'B');
  const localB = callerWithFallback('B', 'C');
  const localC = pureCallee('C');

  const solved = solveInterproceduralSummaries({
    roots: ['A'],
    localSummaries: new Map([['A', localA], ['B', localB], ['C', localC]]),
  });

  const b = solved.summaries.get('B');
  assert.equal(b.unknownCallEffects.length, 0);
  assert.equal(b.status.completeness, 'complete');
  const a = solved.summaries.get('A');
  assert.equal(a.unknownCallEffects.length, 0);
  assert.equal(a.status.completeness, 'complete');
  assert.equal(summaryIsPure(a), true);
});

test('#5851 recursion stays conservative: a self call cannot close its own boundary', () => {
  // A recursive call's callee IS the caller; its own summary can never prove
  // the effects of the call that defines it, so the boundary stays open at
  // the fixed point. Only an explicit non-convergence may republish the
  // stronger recursion-unconverged marker.
  const localSelf = createFunctionSummary({
    functionId: 'fn_self',
    directCalls: [createDirectCall({
      callSiteId: 'call_self',
      targetEntityIds: ['fn_self'],
      summaryId: null,
      effectSource: 'unknown-call-fallback',
    })],
    memoryReadRegions: [broadFallbackRead()],
    memoryWriteRegions: [broadFallbackWrite()],
    unknownCallEffects: [createUnknownCallEffect({
      callSiteId: 'call_self',
      reason: 'summary-missing',
      targetEntityIds: ['fn_self'],
    })],
    noreturn: 'unknown',
    mayThrow: 'unknown',
    status: partialStatus(),
  });

  const converged = solveInterproceduralSummaries({
    roots: ['fn_self'],
    localSummaries: new Map([['fn_self', localSelf]]),
  });
  const summary = converged.summaries.get('fn_self');
  assert.equal(converged.status.completeness, 'partial');
  assert.ok(summary.unknownCallEffects.some((unknown) => unknown.callSiteId === 'call_self'));
  assert.ok(summary.memoryWriteRegions.some((effect) => effect.broad));
  assert.equal(summaryIsPure(summary), false);

  const capped = solveInterproceduralSummaries({
    roots: ['fn_self'],
    localSummaries: new Map([['fn_self', localSelf]]),
    budget: { maxIterationsPerComponent: 1 },
  });
  const cappedSummary = capped.summaries.get('fn_self');
  assert.equal(capped.status.completeness, 'truncated');
  assert.ok(cappedSummary.unknownCallEffects.some((unknown) => unknown.reason === 'recursion-unconverged'));
  assert.ok(cappedSummary.memoryWriteRegions.some((effect) => effect.broad));
});
