import assert from 'node:assert/strict';
import test from 'node:test';

import { analyzeLocalPointsTo } from '../../js/analysis/pointsto/local.js';
import { buildLocalFunctionSummary } from '../../js/analysis/summary/local.js';
import { createFunctionSummary } from '../../js/analysis/summary/contract.js';

const SNAPSHOT_ID = 'issue-5883-snapshot';
const SUMMARY_ANALYZER_ID = 'issue-5883-summary';
const SUMMARY_ANALYZER_VERSION = '1';

function completeStatus() {
  return {
    snapshotId: SNAPSHOT_ID,
    analyzerId: SUMMARY_ANALYZER_ID,
    analyzerVersion: SUMMARY_ANALYZER_VERSION,
    completeness: 'complete',
    stopReason: null,
  };
}

// Production-shaped zero-argument indirect call: the callee target value is an
// operand of the call, never an argument (the same shape
// js/semantics/ir/from-machine-effects.js emits for ABI-neutral calls).
// The target value is a defined computed value whose canonical root descriptor
// rides on the value metadata, so the alias derivation resolves the root the
// same way it does for machine-effects-lowered pointers.
function zeroArgIndirectCallIr({ arguments: callArguments = [], inputs = ['fnptr'] } = {}) {
  const fnptr = {
    id: 'fnptr',
    kind: 'computed',
    definitionNodeId: 'def-fnptr',
    machineType: { kind: 'address', widthBits: 64 },
    metadata: { canonicalRoot: { kind: 'rooted-object', rootEntityId: 'F', baseOffset: 0, addressSpace: 'memory', linearOffsets: true } },
  };
  const ret0 = {
    id: 'ret0',
    kind: 'computed',
    definitionNodeId: 'call0',
    machineType: { kind: 'address', widthBits: 64 },
  };
  const callNode = {
    id: 'call0',
    blockId: 'entry',
    kind: 'call',
    completeness: 'complete',
    inputs,
    outputs: ['ret0'],
    call: {
      targetValueIds: ['fnptr'],
      targetEntityIds: ['callee'],
      arguments: callArguments,
      returns: ['ret0'],
      completeness: 'complete',
      memoryRead: { scope: 'none' },
      memoryWrite: { scope: 'none' },
      stateReads: [],
      stateWrites: [],
      controlEffects: [],
      determinism: 'deterministic',
      noreturn: false,
      mayThrow: false,
      summarySource: 'issue-5883-fixture',
    },
  };
  return { ir: { functionId: 'caller', values: [fnptr, ret0], nodes: [{ id: 'def-fnptr', kind: 'copy', inputs: ['fnptr'], blockId: 'entry' }, callNode], blocks: [] }, fnptr, ret0 };
}

function calleeSummary() {
  return createFunctionSummary({
    functionId: 'callee',
    returnProvenance: [{ kind: 'arg', returnIndex: 0, argIndex: 0, offset: '0' }],
    status: completeStatus(),
  });
}

const POINTSTO_OPTIONS = {
  snapshotId: SNAPSHOT_ID,
  summaries: new Map([['callee', calleeSummary()]]),
  summaryAnalyzerId: SUMMARY_ANALYZER_ID,
  summaryAnalyzerVersion: SUMMARY_ANALYZER_VERSION,
};

test('#5883 a canonical zero-argument call never treats its callee target as argument 0', () => {
  const { ir } = zeroArgIndirectCallIr();
  const result = analyzeLocalPointsTo(ir, null, { definitions: [], uses: [] }, POINTSTO_OPTIONS);
  const set = result.pointsTo.get('ret0');
  assert.equal(set.top, true, 'argIndex 0 does not exist in the caller; the transfer must fail closed');
  assert.ok(set.lossReasons.includes('unresolved-call'));
  assert.equal(set.targets.length, 0, 'the callee target root F must not leak into the call result');
});

test('#5883 legacy fixtures without the canonical field keep the inputs fallback', () => {
  // A pre-canonical fixture omits `call.arguments` entirely (undefined). The
  // legacy compatibility path still resolves arg 0 through node.inputs.
  const { ir } = zeroArgIndirectCallIr();
  const callNode = ir.nodes.find((node) => node.kind === 'call');
  callNode.call = Object.fromEntries(
    Object.entries(callNode.call).filter(([key]) => key !== 'arguments'),
  );
  const result = analyzeLocalPointsTo(ir, null, { definitions: [], uses: [] }, POINTSTO_OPTIONS);
  const set = result.pointsTo.get('ret0');
  assert.equal(set.top, false);
  assert.equal(set.targets.length, 1);
  assert.equal(set.targets[0].rootEntityId, 'F');
});

test('#5883 an explicit argument list still transfers arg provenance', () => {
  const arg0 = {
    id: 'arg0',
    kind: 'computed',
    definitionNodeId: 'def-arg0',
    machineType: { kind: 'address', widthBits: 64 },
    metadata: { canonicalRoot: { kind: 'rooted-object', rootEntityId: 'A0', baseOffset: 0, addressSpace: 'memory', linearOffsets: true } },
  };
  const ret0 = {
    id: 'ret0',
    kind: 'computed',
    definitionNodeId: 'call0',
    machineType: { kind: 'address', widthBits: 64 },
  };
  const ir = {
    functionId: 'caller',
    values: [arg0, ret0],
    nodes: [{
      id: 'def-arg0',
      kind: 'copy',
      inputs: ['arg0'],
      blockId: 'entry',
    }, {
      id: 'call0',
      blockId: 'entry',
      kind: 'call',
      completeness: 'complete',
      inputs: ['arg0'],
      outputs: ['ret0'],
      call: {
        targetEntityIds: ['callee'],
        arguments: ['arg0'],
        returns: ['ret0'],
        completeness: 'complete',
        memoryRead: { scope: 'none' },
        memoryWrite: { scope: 'none' },
        stateReads: [],
        stateWrites: [],
        controlEffects: [],
        determinism: 'deterministic',
        noreturn: false,
        mayThrow: false,
        summarySource: 'issue-5883-fixture',
      },
    }],
    blocks: [],
  };
  const result = analyzeLocalPointsTo(ir, null, { definitions: [], uses: [] }, POINTSTO_OPTIONS);
  const set = result.pointsTo.get('ret0');
  assert.equal(set.top, false);
  assert.equal(set.targets.length, 1);
  assert.equal(set.targets[0].rootEntityId, 'A0');
});

test('#5883 local summary composition does not compose a target-only input as arg 0', () => {
  const { ir } = zeroArgIndirectCallIr();
  ir.inputs = ['fnptr'];
  // fnptr is a caller input, but the call carries canonical arguments: [].
  // The target value must not become argument 0 of this zero-argument call.
  const { summary } = buildLocalFunctionSummary(ir, null, { definitions: [], uses: [] }, null, {
    snapshotId: SNAPSHOT_ID,
    calleeSummaries: new Map([['callee', calleeSummary()]]),
  });
  assert.ok(summary, 'the caller summary still publishes');
  const composed = summary.returnProvenance ?? [];
  assert.ok(!composed.some((prov) => prov.kind === 'arg' && prov.argIndex === 0 && prov.returnIndex === 0),
    'a zero-argument call must not manufacture kind:arg provenance from the callee target');
});
