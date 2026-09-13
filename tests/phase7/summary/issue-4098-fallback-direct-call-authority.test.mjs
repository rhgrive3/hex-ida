import assert from 'node:assert/strict';
import test from 'node:test';

import { createAnalysisStatus } from '../../../js/analysis/status.js';
import {
  createDirectCall,
  createFunctionSummary,
  createMemoryEffect,
  createUnknownCallEffect,
  summaryIsPure,
} from '../../../js/analysis/summary/contract.js';
import {
  solveInterproceduralSummaries,
} from '../../../js/analysis/summary/interprocedural.js';

const SNAPSHOT = 'snapshot_issue_4098';

const completeStatus = () => createAnalysisStatus({
  snapshotId: SNAPSHOT,
  analyzerId: 'test',
  analyzerVersion: '1',
  completeness: 'complete',
  stopReason: null,
});

const partialStatus = () => createAnalysisStatus({
  snapshotId: SNAPSHOT,
  analyzerId: 'test',
  analyzerVersion: '1',
  completeness: 'partial',
  stopReason: 'evidence-missing',
});

const broadFallbackWrite = () => createMemoryEffect({
  regionKind: 'unknown',
  broad: true,
  addressSpaces: ['memory'],
  source: 'unknown-call-fallback',
});

const fallbackCall = (callSiteId = 'call-1', target = 'callee') => createDirectCall({
  callSiteId,
  targetEntityIds: [target],
  summaryId: null,
  effectSource: 'unknown-call-fallback',
});

const unknownAt = (callSiteId = 'call-1', target = 'callee') => createUnknownCallEffect({
  callSiteId,
  reason: 'summary-missing',
  targetEntityIds: [target],
});

test('#4098 the minimal fallback-purity counterexample cannot be constructed', () => {
  assert.throws(() => createFunctionSummary({
    functionId: 'caller',
    directCalls: [{
      callSiteId: 'call-1',
      targetEntityIds: ['callee'],
    }],
    memoryReadRegions: [],
    memoryWriteRegions: [],
    unknownCallEffects: [],
    escapes: [],
    status: completeStatus(),
  }), (error) => error instanceof TypeError
    && error.message === 'function-summary-fallback-direct-call-requires-unknown-effect');

  assert.throws(() => createFunctionSummary({
    functionId: 'caller',
    directCalls: [{
      callSiteId: 'call-1',
      targetEntityIds: ['callee'],
      effectSource: 'unknown-call-fallback',
    }],
    memoryReadRegions: [],
    memoryWriteRegions: [],
    unknownCallEffects: [],
    escapes: [],
    status: completeStatus(),
  }), (error) => error instanceof TypeError
    && error.message === 'function-summary-fallback-direct-call-requires-unknown-effect');
});

test('#4098 a fallback direct call may not launder its unresolved state into a partial summary either', () => {
  assert.throws(() => createFunctionSummary({
    functionId: 'caller',
    directCalls: [fallbackCall()],
    memoryReadRegions: [broadFallbackWrite()],
    memoryWriteRegions: [broadFallbackWrite()],
    unknownCallEffects: [unknownAt('call-2')],
    status: partialStatus(),
  }), (error) => error instanceof TypeError
    && error.message === 'function-summary-fallback-direct-call-requires-unknown-effect');
});

test('#4098 a fallback direct call keeps its conservative spelling with the matching unknown effect', () => {
  const summary = createFunctionSummary({
    functionId: 'caller',
    directCalls: [fallbackCall()],
    memoryReadRegions: [broadFallbackWrite()],
    memoryWriteRegions: [broadFallbackWrite()],
    unknownCallEffects: [unknownAt()],
    noreturn: 'unknown',
    mayThrow: 'unknown',
    status: partialStatus(),
  });
  assert.equal(summary.directCalls[0].effectSource, 'unknown-call-fallback');
  assert.equal(summary.unknownCallEffects[0].callSiteId, 'call-1');
  assert.notEqual(summary.status.completeness, 'complete');
  assert.equal(summaryIsPure(summary), false);

  assert.throws(() => createFunctionSummary({
    functionId: 'caller',
    directCalls: [fallbackCall()],
    memoryReadRegions: [broadFallbackWrite()],
    memoryWriteRegions: [broadFallbackWrite()],
    unknownCallEffects: [unknownAt()],
    status: completeStatus(),
  }), (error) => error instanceof TypeError
    && error.message === 'function-summary-unknown-call-cannot-be-complete');
});

test('#4098 resolved call authorities keep their existing complete summaries', () => {
  for (const source of ['proven-summary', 'library-model', 'abi-rule']) {
    const summary = createFunctionSummary({
      functionId: 'caller',
      directCalls: [createDirectCall({
        callSiteId: 'call-1',
        targetEntityIds: ['callee'],
        summaryId: null,
        effectSource: source,
      })],
      status: completeStatus(),
    });
    assert.equal(summary.directCalls[0].effectSource, source);
    assert.equal(summaryIsPure(summary), true);
  }
});

test('#4098 interprocedural composition publishes resolved call sites with canonical authority', () => {
  const localA = createFunctionSummary({
    functionId: 'A',
    directCalls: [fallbackCall('call_B', 'B')],
    memoryReadRegions: [broadFallbackWrite()],
    memoryWriteRegions: [broadFallbackWrite()],
    unknownCallEffects: [unknownAt('call_B', 'B')],
    noreturn: 'unknown',
    mayThrow: 'unknown',
    status: partialStatus(),
  });
  const localB = createFunctionSummary({ functionId: 'B', status: completeStatus() });

  const summary = solveInterproceduralSummaries({
    roots: ['A'],
    localSummaries: new Map([['A', localA], ['B', localB]]),
  }).summaries.get('A');

  assert.equal(summary.unknownCallEffects.length, 0);
  assert.equal(summary.status.completeness, 'complete');
  assert.equal(summaryIsPure(summary), true);
  assert.equal(summary.directCalls[0].effectSource, 'proven-summary',
    'a call whose targets are all solved complete must publish the solved-summary authority, not the local fallback');
});

test('#4098 an unresolved call site keeps its fallback and matching unknown through composition', () => {
  const localA = createFunctionSummary({
    functionId: 'A',
    directCalls: [fallbackCall('call_B', 'B')],
    memoryReadRegions: [broadFallbackWrite()],
    memoryWriteRegions: [broadFallbackWrite()],
    unknownCallEffects: [unknownAt('call_B', 'B')],
    noreturn: 'unknown',
    mayThrow: 'unknown',
    status: partialStatus(),
  });

  const summary = solveInterproceduralSummaries({
    roots: ['A'],
    localSummaries: new Map([['A', localA]]),
  }).summaries.get('A');

  assert.equal(summary.directCalls[0].effectSource, 'unknown-call-fallback');
  assert.ok(summary.unknownCallEffects.some((unknown) => unknown.callSiteId === 'call_B'));
  assert.ok(summary.memoryWriteRegions.some((effect) => effect.broad));
  assert.notEqual(summary.status.completeness, 'complete');
  assert.equal(summaryIsPure(summary), false);
});

test('#4098 a locally unattributed non-call unknown keeps every local fallback paired', () => {
  const localA = createFunctionSummary({
    functionId: 'A',
    directCalls: [fallbackCall('call_B', 'B')],
    memoryReadRegions: [broadFallbackWrite()],
    memoryWriteRegions: [broadFallbackWrite()],
    unknownCallEffects: [
      createUnknownCallEffect({ callSiteId: 'unresolved_memory_effect', reason: 'unresolved-target' }),
      unknownAt('call_B', 'B'),
    ],
    noreturn: 'unknown',
    mayThrow: 'unknown',
    status: partialStatus(),
  });
  const localB = createFunctionSummary({ functionId: 'B', status: completeStatus() });

  const summary = solveInterproceduralSummaries({
    roots: ['A'],
    localSummaries: new Map([['A', localA], ['B', localB]]),
  }).summaries.get('A');

  assert.ok(summary.unknownCallEffects.some((unknown) => unknown.callSiteId === 'call_B'),
    'the call unknown survives while the fallback is not attributable per site');
  assert.equal(summary.directCalls[0].effectSource, 'unknown-call-fallback',
    'while the call unknown survives, the call record must keep declaring the fallback');
});
