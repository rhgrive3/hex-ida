import assert from 'node:assert/strict';
import test from 'node:test';

import { createAnalysisStatus } from '../js/analysis/status.js';
import { createFunctionSummary, createUnknownCallEffect, functionSummaryDigest } from '../js/analysis/summary/contract.js';
import { solveInterproceduralSummaries } from '../js/analysis/summary/interprocedural.js';

const partialStatus = () => createAnalysisStatus({
  snapshotId: 'snapshot_6249',
  analyzerId: 'phase7.summary.local',
  analyzerVersion: '1.1.0',
  completeness: 'partial',
  stopReason: 'evidence-missing',
});

const completeStatus = () => createAnalysisStatus({
  snapshotId: 'snapshot_6249',
  analyzerId: 'phase7.summary.local',
  analyzerVersion: '1.1.0',
  completeness: 'complete',
});

function callerSummary(targetEntityIds) {
  return createFunctionSummary({
    functionId: 'caller',
    directCalls: [{
      callSiteId: 'call-1',
      targetEntityIds,
      summaryId: null,
      effectSource: 'unknown-call-fallback',
    }],
    memoryWriteRegions: [{ regionKind: 'unknown', broad: true, addressSpaces: ['memory'], source: 'unknown-call-fallback' }],
    unknownCallEffects: [createUnknownCallEffect({
      callSiteId: 'call-1',
      reason: 'summary-missing',
      targetEntityIds,
    })],
    noreturn: 'unknown',
    mayThrow: 'unknown',
    status: partialStatus(),
  });
}

const externalB = createFunctionSummary({
  functionId: 'ext_b', status: completeStatus(),
});

const missingBoth = callerSummary(['ext_b', 'ext_c']);
const missingReversed = callerSummary(['ext_c', 'ext_b']);

test('issue-6249: every unresolved target of one call site survives composition', () => {
  const solved = solveInterproceduralSummaries({
    roots: ['caller'],
    localSummaries: new Map([['caller', missingBoth]]),
    snapshotId: 'snapshot_6249',
  });
  const summary = solved.summaries.get('caller');
  const site = summary.unknownCallEffects.filter((unknown) => unknown.callSiteId === 'call-1');
  assert.ok(site.length > 0);
  const targets = new Set(site.flatMap((unknown) => unknown.targetEntityIds));
  assert.ok(targets.has('ext_b'), 'target ext_b vanished from the composed provenance');
  assert.ok(targets.has('ext_c'), 'target ext_c vanished from the composed provenance');
  assert.equal(summary.status.completeness, 'partial');
  assert.equal(summary.status.stopReason, 'evidence-missing');
});

test('issue-6249: the composed effect does not depend on target order', () => {
  const first = solveInterproceduralSummaries({
    roots: ['caller'],
    localSummaries: new Map([['caller', missingBoth]]),
    snapshotId: 'snapshot_6249',
  });
  const second = solveInterproceduralSummaries({
    roots: ['caller'],
    localSummaries: new Map([['caller', missingReversed]]),
    snapshotId: 'snapshot_6249',
  });
  const left = first.summaries.get('caller');
  const right = second.summaries.get('caller');
  const leftTargets = left.unknownCallEffects.flatMap((unknown) => unknown.targetEntityIds).sort();
  const rightTargets = right.unknownCallEffects.flatMap((unknown) => unknown.targetEntityIds).sort();
  assert.deepEqual(leftTargets, rightTargets);
  assert.equal(functionSummaryDigest(left), functionSummaryDigest(right));
});

test('issue-6249: evidence ids union across same site and reason', () => {
  const caller = createFunctionSummary({
    functionId: 'caller',
    directCalls: [
      { callSiteId: 'call-1', targetEntityIds: ['ext_b'], summaryId: null, effectSource: 'unknown-call-fallback' },
    ],
    memoryWriteRegions: [{ regionKind: 'unknown', broad: true, addressSpaces: ['memory'], source: 'unknown-call-fallback' }],
    unknownCallEffects: [createUnknownCallEffect({
      callSiteId: 'call-1',
      reason: 'library-model-missing',
      targetEntityIds: ['ext_b'],
      evidenceIds: ['ev-1'],
    })],
    noreturn: 'unknown',
    mayThrow: 'unknown',
    status: partialStatus(),
  });
  const solved = solveInterproceduralSummaries({
    roots: ['caller'],
    localSummaries: new Map([['caller', caller]]),
    libraryModels: new Map([['ext_c', externalB]]),
    snapshotId: 'snapshot_6249',
  });
  const summary = solved.summaries.get('caller');
  const site = summary.unknownCallEffects.filter((unknown) => unknown.callSiteId === 'call-1');
  const targets = new Set(site.flatMap((unknown) => unknown.targetEntityIds));
  assert.ok(targets.has('ext_b'));
  const evidence = new Set(site.flatMap((unknown) => unknown.evidenceIds));
  assert.ok(evidence.has('ev-1'));
});

test('issue-6249: distinct reasons and call sites stay separate effects', () => {
  const caller = createFunctionSummary({
    functionId: 'caller',
    directCalls: [
      { callSiteId: 'call-1', targetEntityIds: ['ext_b'], summaryId: null, effectSource: 'unknown-call-fallback' },
      { callSiteId: 'call-2', targetEntityIds: ['ext_c'], summaryId: null, effectSource: 'unknown-call-fallback' },
    ],
    memoryWriteRegions: [{ regionKind: 'unknown', broad: true, addressSpaces: ['memory'], source: 'unknown-call-fallback' }],
    unknownCallEffects: [
      createUnknownCallEffect({ callSiteId: 'call-1', reason: 'summary-missing', targetEntityIds: ['ext_b'] }),
      createUnknownCallEffect({ callSiteId: 'call-2', reason: 'library-model-missing', targetEntityIds: ['ext_c'] }),
    ],
    noreturn: 'unknown',
    mayThrow: 'unknown',
    status: partialStatus(),
  });
  const solved = solveInterproceduralSummaries({
    roots: ['caller'],
    localSummaries: new Map([['caller', caller]]),
    snapshotId: 'snapshot_6249',
  });
  const summary = solved.summaries.get('caller');
  const reasons = new Set(summary.unknownCallEffects.map((unknown) => `${unknown.callSiteId}:${unknown.reason}`));
  assert.ok(reasons.has('call-1:summary-missing'));
  assert.ok(reasons.has('call-2:library-model-missing'));
});

test('issue-6249: duplicate targets dedupe to one entry', () => {
  const solved = solveInterproceduralSummaries({
    roots: ['caller'],
    localSummaries: new Map([['caller', callerSummary(['ext_b', 'ext_b'])]]),
    snapshotId: 'snapshot_6249',
  });
  const summary = solved.summaries.get('caller');
  for (const unknown of summary.unknownCallEffects) {
    const targets = unknown.targetEntityIds;
    assert.equal(new Set(targets).size, targets.length, 'duplicate target ids must collapse');
  }
});

test('issue-6249: unresolved targets still clobber broadly and stay incomplete', () => {
  const solved = solveInterproceduralSummaries({
    roots: ['caller'],
    localSummaries: new Map([['caller', missingBoth]]),
    snapshotId: 'snapshot_6249',
  });
  const summary = solved.summaries.get('caller');
  assert.ok(summary.memoryWriteRegions.some((effect) => effect.broad));
  assert.equal(summary.status.completeness, 'partial');
  assert.notEqual(summary.noreturn, false);
});
