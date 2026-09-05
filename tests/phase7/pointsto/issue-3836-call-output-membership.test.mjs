import assert from 'node:assert/strict';
import test from 'node:test';

import { analyzeLocalPointsTo } from '../../../js/analysis/pointsto/local.js';
import { createFunctionSummary } from '../../../js/analysis/summary/contract.js';

const SNAPSHOT_ID = 'issue-3836-snapshot';
const SUMMARY_ANALYZER_ID = 'issue-3836-summary';
const SUMMARY_ANALYZER_VERSION = '1';

function makeSummary(returnProvenance, completeness = 'complete') {
  return createFunctionSummary({
    functionId: 'callee',
    returnProvenance,
    status: {
      snapshotId: SNAPSHOT_ID,
      analyzerId: SUMMARY_ANALYZER_ID,
      analyzerVersion: SUMMARY_ANALYZER_VERSION,
      completeness,
      ...(completeness === 'complete' ? {} : { stopReason: 'cancelled' }),
    },
  });
}

function runCall({ valueId = 'v0', outputs = ['v0'], returnProvenance, summaryCompleteness = 'complete' }) {
  const value = {
    id: valueId,
    kind: 'computed',
    definitionNodeId: 'call1',
    machineType: { kind: 'address', widthBits: 64 },
    origin: { instructionIds: ['call1'] },
  };
  const node = {
    id: 'call1',
    blockId: 'entry',
    kind: 'call',
    completeness: 'complete',
    inputs: [],
    ...(outputs === undefined ? {} : { outputs }),
    call: { targetEntityId: 'callee', arguments: [] },
  };
  const ir = { functionId: 'caller', values: [value], nodes: [node] };
  const summary = makeSummary(returnProvenance, summaryCompleteness);
  return analyzeLocalPointsTo(ir, null, { definitions: [], uses: [] }, {
    snapshotId: SNAPSHOT_ID,
    summaries: new Map([['callee', summary]]),
    summaryAnalyzerId: SUMMARY_ANALYZER_ID,
    summaryAnalyzerVersion: SUMMARY_ANALYZER_VERSION,
  }).pointsTo.get(valueId);
}

function assertRoot(set, rootEntityId) {
  assert.equal(set.top, false);
  assert.equal(set.targets.length, 1);
  assert.equal(set.targets[0].rootEntityId, rootEntityId);
}

function assertUnresolved(set) {
  assert.equal(set.top, true);
  assert.ok(set.lossReasons.includes('unresolved-call'));
}

test('#3836 valid call outputs retain their exact return-index provenance', () => {
  assertRoot(runCall({
    outputs: ['v0'],
    returnProvenance: [{ kind: 'root', returnIndex: 0, rootEntityId: 'ret-0' }],
  }), 'ret-0');

  assertRoot(runCall({
    valueId: 'v1',
    outputs: ['v0', 'v1'],
    returnProvenance: [
      { kind: 'root', returnIndex: 0, rootEntityId: 'ret-0' },
      { kind: 'root', returnIndex: 1, rootEntityId: 'ret-1' },
    ],
  }), 'ret-1');
});

test('#3836 a value absent from node.outputs cannot borrow return-0 provenance', () => {
  assertUnresolved(runCall({
    valueId: 'v-missing',
    outputs: ['v0'],
    returnProvenance: [{ kind: 'root', returnIndex: 0, rootEntityId: 'ret-0' }],
  }));

  assertUnresolved(runCall({
    valueId: 'v-missing',
    outputs: [],
    returnProvenance: [{ kind: 'root', returnIndex: 0, rootEntityId: 'ret-0' }],
  }));

  assertUnresolved(runCall({
    valueId: 'v-missing',
    outputs: undefined,
    returnProvenance: [{ kind: 'root', returnIndex: 0, rootEntityId: 'ret-0' }],
  }));
});

test('#3836 incomplete callee summaries remain fail-closed', () => {
  assertUnresolved(runCall({
    outputs: ['v0'],
    returnProvenance: [{ kind: 'root', returnIndex: 0, rootEntityId: 'ret-0' }],
    summaryCompleteness: 'partial',
  }));
});
