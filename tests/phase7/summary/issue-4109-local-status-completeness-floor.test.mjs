import assert from 'node:assert/strict';
import test from 'node:test';

import { createAnalysisStatus } from '../../../js/analysis/status.js';
import {
  createFunctionSummary,
  createDirectCall,
  createMemoryEffect,
  createUnknownCallEffect,
} from '../../../js/analysis/summary/contract.js';
import { solveInterproceduralSummaries } from '../../../js/analysis/summary/interprocedural.js';

const SNAPSHOT = 'snapshot_issue_4109';

const statusOf = (completeness, stopReason = null) => createAnalysisStatus({
  snapshotId: SNAPSHOT,
  analyzerId: 'phase7.summary.local',
  analyzerVersion: '1.0.0',
  completeness,
  ...(stopReason ? { stopReason } : {}),
});

const broadFallback = (kind) => createMemoryEffect({
  regionKind: 'unknown',
  broad: true,
  addressSpaces: ['memory'],
  source: 'unknown-call-fallback',
  ...(kind === 'write' ? {} : {}),
});

const calllessLocal = (functionId, status) => createFunctionSummary({
  functionId,
  memoryReadRegions: [],
  memoryWriteRegions: [],
  unknownCallEffects: [],
  status,
});

const completeCallee = (functionId) => createFunctionSummary({
  functionId,
  status: statusOf('complete'),
});

const solve = (entries) => solveInterproceduralSummaries({
  roots: entries.map(([id]) => id),
  localSummaries: new Map(entries),
  snapshotId: SNAPSHOT,
});

test('#4109 a call-less partial local summary is never strengthened to complete by A3', () => {
  const partial = calllessLocal('F', statusOf('partial', 'evidence-missing'));
  const solved = solve([['F', partial]]);
  assert.equal(partial.status.completeness, 'partial');
  assert.equal(solved.summaries.get('F').status.completeness, 'partial',
    'A3 must not launder an input local partial into complete');
});

test('#4109 truncated local input is preserved as truncated', () => {
  const truncated = calllessLocal('F', statusOf('truncated', 'iteration-limit'));
  const solved = solve([['F', truncated]]);
  assert.equal(solved.summaries.get('F').status.completeness, 'truncated',
    'truncated local input must not be upgraded');
});

test('#4109 unsupported local input is preserved as unsupported', () => {
  const unsupported = calllessLocal('F', statusOf('unsupported', 'unsupported-input'));
  const solved = solve([['F', unsupported]]);
  assert.equal(solved.summaries.get('F').status.completeness, 'unsupported',
    'unsupported local input must not be upgraded');
});

test('#4109 a partial caller with a complete callee keeps the partial floor', () => {
  const caller = createFunctionSummary({
    functionId: 'A',
    directCalls: [createDirectCall({
      callSiteId: 'call_B',
      targetEntityIds: ['B'],
      summaryId: null,
      effectSource: 'proven-summary',
    })],
    memoryReadRegions: [],
    memoryWriteRegions: [createMemoryEffect({
      regionKind: 'global-absolute',
      addressSpaces: ['memory'],
      source: 'proven-summary',
      regionId: 'region_a',
    })],
    unknownCallEffects: [],
    status: statusOf('partial', 'evidence-missing'),
  });
  const solved = solve([['A', caller], ['B', completeCallee('B')]]);
  assert.equal(solved.summaries.get('A').status.completeness, 'partial',
    'caller-local incompleteness (independent of call resolution) must survive complete callees');
});

test('#4109 complete local + complete callee stays complete', () => {
  const caller = createFunctionSummary({
    functionId: 'A',
    directCalls: [createDirectCall({
      callSiteId: 'call_B',
      targetEntityIds: ['B'],
      summaryId: null,
      effectSource: 'proven-summary',
    })],
    memoryReadRegions: [],
    memoryWriteRegions: [],
    unknownCallEffects: [],
    status: statusOf('complete'),
  });
  const solved = solve([['A', caller], ['B', completeCallee('B')]]);
  assert.equal(solved.summaries.get('A').status.completeness, 'complete',
    'a fully complete local with complete callees must remain complete');
});

test('#4109 callee-side weak status still propagates', () => {
  const caller = createFunctionSummary({
    functionId: 'A',
    directCalls: [createDirectCall({
      callSiteId: 'call_B',
      targetEntityIds: ['B'],
      summaryId: null,
      effectSource: 'proven-summary',
    })],
    memoryReadRegions: [],
    memoryWriteRegions: [],
    unknownCallEffects: [],
    status: statusOf('complete'),
  });
  const callee = createFunctionSummary({
    functionId: 'B',
    status: statusOf('truncated', 'iteration-limit'),
  });
  const solved = solve([['A', caller], ['B', callee]]);
  assert.equal(solved.summaries.get('A').status.completeness, 'truncated',
    'a weak callee status must propagate to the caller');
});

test('#4109 the #5851 call-fallback replacement is not regressed by the floor', () => {
  const caller = createFunctionSummary({
    functionId: 'A',
    directCalls: [createDirectCall({
      callSiteId: 'call_B',
      targetEntityIds: ['B'],
      summaryId: null,
      effectSource: 'unknown-call-fallback',
    })],
    memoryReadRegions: [broadFallback('read')],
    memoryWriteRegions: [broadFallback('write')],
    unknownCallEffects: [createUnknownCallEffect({
      callSiteId: 'call_B',
      reason: 'summary-missing',
      targetEntityIds: ['B'],
    })],
    noreturn: 'unknown',
    mayThrow: 'unknown',
    status: statusOf('partial', 'evidence-missing'),
  });
  const solved = solve([['A', caller], ['B', completeCallee('B')]]);
  assert.equal(solved.summaries.get('A').status.completeness, 'complete',
    'a partial caused only by a now-closed unknown call fallback may still strengthen (#5851)');
});

test('#4109 the #5851 exception does not relax truncated/unsupported call fallbacks', () => {
  const callerFor = (completeness, stopReason) => createFunctionSummary({
    functionId: 'A',
    directCalls: [createDirectCall({
      callSiteId: 'call_B',
      targetEntityIds: ['B'],
      summaryId: null,
      effectSource: 'unknown-call-fallback',
    })],
    memoryReadRegions: [broadFallback('read')],
    memoryWriteRegions: [broadFallback('write')],
    unknownCallEffects: [createUnknownCallEffect({
      callSiteId: 'call_B',
      reason: 'summary-missing',
      targetEntityIds: ['B'],
    })],
    noreturn: 'unknown',
    mayThrow: 'unknown',
    status: statusOf(completeness, stopReason),
  });
  const truncated = solve([['A', callerFor('truncated', 'iteration-limit')], ['B', completeCallee('B')]]);
  assert.equal(truncated.summaries.get('A').status.completeness, 'truncated',
    'a truncated local must not be relaxed by the call-fallback exception');
});
