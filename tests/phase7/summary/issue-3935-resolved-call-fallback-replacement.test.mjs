import assert from 'node:assert/strict';
import test from 'node:test';

import { createAnalysisStatus } from '../../../js/analysis/status.js';
import {
  createFunctionSummary,
  summaryIsPure,
} from '../../../js/analysis/summary/contract.js';
import { solveInterproceduralSummaries } from '../../../js/analysis/summary/interprocedural.js';

function status(completeness, stopReason = null, analyzerId = 'issue-3935-local') {
  return createAnalysisStatus({
    snapshotId: 'issue-3935',
    analyzerId,
    analyzerVersion: '1',
    completeness,
    stopReason,
  });
}

function completeSummary(functionId, overrides = {}) {
  return createFunctionSummary({
    functionId,
    noreturn: false,
    mayThrow: false,
    status: status('complete', null, `issue-3935-${functionId}`),
    ...overrides,
  });
}

function fallbackCaller({
  functionId = 'A',
  callSiteId = 'call-B',
  targetEntityIds = ['B'],
  extraUnknowns = [],
  extraWrites = [],
} = {}) {
  return createFunctionSummary({
    functionId,
    directCalls: [{
      callSiteId,
      targetEntityIds,
      effectSource: 'unknown-call-fallback',
    }],
    unknownCallEffects: [{
      callSiteId,
      reason: 'summary-missing',
      targetEntityIds,
    }, ...extraUnknowns],
    memoryWriteRegions: [{
      regionKind: 'unknown',
      broad: true,
      addressSpaces: ['memory'],
      source: 'unknown-call-fallback',
    }, ...extraWrites],
    noreturn: 'unknown',
    mayThrow: 'unknown',
    status: status('partial', 'evidence-missing'),
  });
}

function solve(localSummaries, roots = ['A'], libraryModels = new Map()) {
  return solveInterproceduralSummaries({
    roots,
    localSummaries,
    libraryModels,
    snapshotId: 'issue-3935',
  }).summaries.get(roots[0]);
}

test('#3935 a complete pure callee replaces its local summary-missing fallback', () => {
  const caller = fallbackCaller();
  const callee = completeSummary('B');
  const solved = solve(new Map([['A', caller], ['B', callee]]));

  assert.deepEqual(solved.unknownCallEffects, []);
  assert.deepEqual(solved.memoryReadRegions, []);
  assert.deepEqual(solved.memoryWriteRegions, []);
  assert.equal(solved.status.completeness, 'complete');
  assert.equal(summaryIsPure(solved), true);
});

test('#3935 a complete writing callee replaces fallback with only its specific effect', () => {
  const caller = fallbackCaller();
  const callee = completeSummary('B', {
    memoryWriteRegions: [{
      regionId: 'global-B',
      regionKind: 'global-absolute',
      addressSpaces: ['memory'],
      source: 'proven-summary',
    }],
  });
  const solved = solve(new Map([['A', caller], ['B', callee]]));

  assert.deepEqual(solved.unknownCallEffects, []);
  assert.equal(solved.memoryWriteRegions.some((effect) => effect.broad), false);
  assert.deepEqual(solved.memoryWriteRegions.map((effect) => effect.regionId), ['global-B']);
  assert.equal(solved.status.completeness, 'complete');
});

test('#3935 missing or incomplete callees retain the conservative local fallback', () => {
  const caller = fallbackCaller();
  const missing = solve(new Map([['A', caller]]));
  assert.ok(missing.unknownCallEffects.some((effect) => effect.callSiteId === 'call-B'));
  assert.ok(missing.memoryWriteRegions.some((effect) => effect.broad));
  assert.notEqual(missing.status.completeness, 'complete');

  const incompleteB = createFunctionSummary({
    functionId: 'B',
    unknownCallEffects: [{ callSiteId: 'body-unknown', reason: 'unresolved-target' }],
    memoryWriteRegions: [{
      regionKind: 'unknown',
      broad: true,
      addressSpaces: ['memory'],
      source: 'unknown-call-fallback',
    }],
    noreturn: 'unknown',
    mayThrow: 'unknown',
    status: status('partial', 'evidence-missing', 'issue-3935-B'),
  });
  const incomplete = solve(new Map([['A', caller], ['B', incompleteB]]));
  assert.ok(incomplete.unknownCallEffects.some((effect) => effect.callSiteId === 'call-B'));
  assert.ok(incomplete.unknownCallEffects.some((effect) => effect.callSiteId === 'body-unknown'));
  assert.ok(incomplete.memoryWriteRegions.some((effect) => effect.broad));
  assert.notEqual(incomplete.status.completeness, 'complete');
});

test('#3935 a non-exhaustive indirect set keeps residual unknown authority', () => {
  const caller = createFunctionSummary({
    functionId: 'A',
    indirectCallSets: [{
      callSiteId: 'dispatch-B',
      candidateEntityIds: ['B'],
      exhaustive: false,
    }],
    unknownCallEffects: [{
      callSiteId: 'dispatch-B',
      reason: 'indirect-incomplete-target-set',
      targetEntityIds: ['B'],
    }],
    memoryWriteRegions: [{
      regionKind: 'unknown', broad: true, addressSpaces: ['memory'], source: 'unknown-call-fallback',
    }],
    noreturn: 'unknown',
    mayThrow: 'unknown',
    status: status('partial', 'evidence-missing'),
  });
  const solved = solve(new Map([['A', caller], ['B', completeSummary('B')]]));

  assert.ok(solved.unknownCallEffects.some((effect) =>
    effect.callSiteId === 'dispatch-B' && effect.reason === 'indirect-incomplete-target-set'));
  assert.ok(solved.memoryWriteRegions.some((effect) => effect.broad));
  assert.notEqual(solved.status.completeness, 'complete');
});

test('#3935 a separate own-body unknown prevents fallback pruning', () => {
  const caller = fallbackCaller({
    extraUnknowns: [{ callSiteId: 'body-unknown', reason: 'unresolved-target' }],
  });
  const solved = solve(new Map([['A', caller], ['B', completeSummary('B')]]));

  assert.equal(solved.unknownCallEffects.some((effect) => effect.callSiteId === 'call-B'), false);
  assert.ok(solved.unknownCallEffects.some((effect) => effect.callSiteId === 'body-unknown'));
  assert.ok(solved.memoryWriteRegions.some((effect) => effect.broad),
    'unattributed local fallback must remain while any local unknown is unresolved');
  assert.notEqual(solved.status.completeness, 'complete');
});

test('#3935 a library model can close the local fallback without laundering its authority', () => {
  const caller = fallbackCaller({ targetEntityIds: ['external-B'] });
  const solved = solve(
    new Map([['A', caller]]),
    ['A'],
    new Map([['external-B', {
      memoryReadRegions: [],
      memoryWriteRegions: [{
        regionId: 'modeled-global',
        regionKind: 'global-absolute',
        addressSpaces: ['memory'],
        source: 'library-model',
      }],
      noreturn: false,
      mayThrow: false,
    }]]),
  );

  assert.deepEqual(solved.unknownCallEffects, []);
  assert.equal(solved.memoryWriteRegions.some((effect) => effect.broad), false);
  assert.equal(solved.memoryWriteRegions[0].regionId, 'modeled-global');
  assert.equal(solved.memoryWriteRegions[0].source, 'library-model');
  assert.equal(solved.status.completeness, 'complete');
});
