import assert from 'node:assert/strict';
import test from 'node:test';

import { createAnalysisStatus } from '../js/analysis/status.js';
import { createFunctionSummary } from '../js/analysis/summary/contract.js';
import { buildLocalFunctionSummary } from '../js/analysis/summary/local.js';
import { solveInterproceduralSummaries } from '../js/analysis/summary/interprocedural.js';

const SNAPSHOT = 'snapshot_6258';

const solvedStatus = () => createAnalysisStatus({
  snapshotId: SNAPSHOT,
  analyzerId: 'phase7.summary.interprocedural',
  analyzerVersion: '1.1.0',
  completeness: 'complete',
});

function calleeWithSource(source) {
  return createFunctionSummary({
    functionId: 'fn_callee',
    memoryWriteRegions: [{
      regionId: 'region_model',
      regionKind: 'global',
      broad: false,
      addressSpaces: ['memory'],
      source,
      evidenceIds: [`model:${source}`],
    }],
    memoryReadRegions: [{
      regionId: 'region_model_read',
      regionKind: 'global',
      broad: false,
      addressSpaces: ['memory'],
      source,
      evidenceIds: [`model:${source}`],
    }],
    noreturn: false,
    mayThrow: false,
    status: solvedStatus(),
  });
}

function callerIr() {
  return {
    functionId: 'fn_caller',
    values: [],
    nodes: [{
      id: 'call_callee',
      kind: 'call',
      inputs: [],
      outputs: [],
      call: {
        targetEntityIds: ['fn_callee'],
        completeness: 'complete',
      },
    }],
  };
}

function composeCaller(callee) {
  return buildLocalFunctionSummary(callerIr(), {}, {}, {}, {
    snapshotId: SNAPSHOT,
    calleeSummaries: new Map([['fn_callee', callee]]),
  }).summary;
}

test('issue-6258: a library-model effect keeps its authority through local composition', () => {
  const summary = composeCaller(calleeWithSource('library-model'));
  assert.equal(summary.memoryWriteRegions[0].source, 'library-model');
  assert.equal(summary.memoryWriteRegions[0].regionId, 'region_model');
  assert.deepEqual(summary.memoryWriteRegions[0].evidenceIds, ['model:library-model']);
  assert.equal(summary.memoryReadRegions[0].source, 'library-model');
});

test('issue-6258: an abi-rule effect keeps its authority through local composition', () => {
  const summary = composeCaller(calleeWithSource('abi-rule'));
  assert.equal(summary.memoryWriteRegions[0].source, 'abi-rule');
  assert.equal(summary.memoryReadRegions[0].source, 'abi-rule');
});

test('issue-6258: proven-summary effects stay proven-summary', () => {
  const summary = composeCaller(calleeWithSource('proven-summary'));
  assert.equal(summary.memoryWriteRegions[0].source, 'proven-summary');
  assert.equal(summary.memoryReadRegions[0].source, 'proven-summary');
});

test('issue-6258: the direct call edge still records that a proven summary was consumed', () => {
  const summary = composeCaller(calleeWithSource('library-model'));
  const edge = summary.directCalls.find((call) => call.callSiteId === 'call_callee');
  assert.ok(edge, 'the resolved call must be recorded');
  assert.equal(edge.summaryId, 'fn_callee');
  assert.equal(edge.effectSource, 'proven-summary');
});

test('issue-6258: local composition and A3 composition agree on effect authority', () => {
  const callee = calleeWithSource('library-model');
  const local = composeCaller(callee);
  const solved = solveInterproceduralSummaries({
    roots: ['fn_caller'],
    localSummaries: new Map([
      ['fn_caller', createFunctionSummary({
        functionId: 'fn_caller',
        directCalls: [{ callSiteId: 'call_callee', targetEntityIds: ['fn_callee'], summaryId: null, effectSource: 'proven-summary' }],
        noreturn: 'unknown',
        mayThrow: 'unknown',
        status: solvedStatus(),
      })],
      ['fn_callee', callee],
    ]),
    snapshotId: SNAPSHOT,
  });
  const composed = solved.summaries.get('fn_caller');
  const a3Write = composed.memoryWriteRegions.find((effect) => effect.regionId === 'region_model');
  const a3Read = composed.memoryReadRegions.find((effect) => effect.regionId === 'region_model_read');
  assert.ok(a3Write, 'A3 composition must carry the callee write effect');
  assert.equal(a3Write.source, 'library-model');
  assert.equal(a3Read.source, 'library-model');
  assert.equal(local.memoryWriteRegions[0].source, a3Write.source);
});

test('issue-6258: an incomplete callee still fails closed through local composition', () => {
  const stale = createFunctionSummary({
    functionId: 'fn_callee',
    memoryWriteRegions: [{ regionId: 'region_model', regionKind: 'global', source: 'proven-summary' }],
    status: createAnalysisStatus({
      snapshotId: 'other_snapshot',
      analyzerId: 'phase7.summary.local',
      analyzerVersion: '1.1.0',
      completeness: 'complete',
    }),
  });
  const summary = composeCaller(stale);
  // The identity mismatch must keep the call an explicit unknown boundary.
  assert.ok(summary.unknownCallEffects.length > 0);
  assert.ok(summary.memoryWriteRegions.some((effect) => effect.broad));
  assert.equal(summary.status.completeness, 'partial');
});
