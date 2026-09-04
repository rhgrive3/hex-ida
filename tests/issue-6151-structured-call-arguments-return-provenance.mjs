import assert from 'node:assert/strict';
import test from 'node:test';

import { buildLocalFunctionSummary } from '../js/analysis/summary/local.js';
import { createFunctionSummary } from '../js/analysis/summary/contract.js';
import { createSemanticCfg } from '../js/semantics/cfg/index.js';

// Issue #6151: composeCallReturnProvenance passed call argument entries
// straight into formalArgumentIndex. A structured `{ valueId: 'arg0' }`
// argument reached ir.inputs.indexOf / valueById.get as an object, matched
// nothing, and a fully-proven `return = arg[i] + offset` callee provenance was
// demoted to unknown — purely because of the wire representation.

const origin = (id) => ({ instructionIds: [`instruction_${id}`] });

const completeStatus = () => ({
  snapshotId: 'snapshot-6151',
  analyzerId: 'callee-summary',
  analyzerVersion: '1.0.0',
  completeness: 'complete',
});

const calleeReturnArg = (offset = '0') => createFunctionSummary({
  functionId: 'fn_callee',
  inputs: ['x0'],
  returnValues: ['ret'],
  returnProvenance: [{ kind: 'arg', returnIndex: 0, argIndex: 0, offset }],
  noreturn: false,
  mayThrow: false,
  status: completeStatus(),
});

const callerIr = (callArguments) => ({
  functionId: 'fn_caller',
  inputs: ['arg0'],
  entryBlockId: 'entry',
  values: [
    { id: 'arg0', kind: 'definition', definitionNodeId: 'node_arg0', machineType: { kind: 'bitvector', widthBits: 64 }, metadata: { argumentIndex: 0 }, origin: origin('arg0') },
    { id: 'ret0', kind: 'definition', definitionNodeId: 'node_call', machineType: { kind: 'bitvector', widthBits: 64 }, origin: origin('ret0') },
  ],
  nodes: [
    {
      id: 'node_arg0', kind: 'state-read', blockId: 'entry', inputs: [], outputs: ['arg0'],
      variable: { key: 'state:x0', kind: 'physical-state', scope: 'function' }, origin: origin('node_arg0'),
    },
    {
      id: 'node_call', kind: 'call', blockId: 'entry', inputs: ['arg0'], outputs: ['ret0'],
      call: {
        targetValueIds: [], targetEntityIds: ['fn_callee'], arguments: callArguments, returns: ['ret0'],
        memoryRead: { scope: 'none' }, memoryWrite: { scope: 'none' }, stateReads: [], stateWrites: [],
        controlEffects: [], determinism: 'deterministic', noreturn: false, mayThrow: false,
        summarySource: 'issue-6151-fixture', completeness: 'complete',
      },
      origin: origin('node_call'),
    },
    { id: 'node_return', kind: 'return', blockId: 'entry', inputs: ['ret0'], outputs: [], origin: origin('node_return') },
  ],
  completeness: 'complete',
  unknowns: [],
});

const cfg = createSemanticCfg({
  functionId: 'fn_caller',
  entryBlockId: 'entry',
  blocks: [{ id: 'entry', successors: [] }],
});

const summarize = (callArguments) => buildLocalFunctionSummary(
  callerIr(callArguments), cfg, null, null,
  { snapshotId: 'snapshot-6151', calleeSummaries: new Map([['fn_callee', calleeReturnArg()]]) },
).summary;

test('issue-6151: raw id arguments keep their arg provenance', () => {
  assert.deepEqual(summarize(['arg0']).returnProvenance, [{
    kind: 'arg', argIndex: 0, offset: '0', rootEntityId: null, returnIndex: 0,
  }]);
});

test('issue-6151: structured {valueId} arguments compose the same provenance', () => {
  assert.deepEqual(summarize([{ valueId: 'arg0' }]).returnProvenance,
    summarize(['arg0']).returnProvenance,
    'the wire representation alone must not change the composed provenance');
});

test('issue-6151: metadata on the structured record does not affect the identity', () => {
  assert.deepEqual(
    summarize([{ valueId: 'arg0', provenance: 'abi-projection' }]).returnProvenance,
    summarize(['arg0']).returnProvenance,
  );
});

test('issue-6151: malformed structured records stay unknown instead of coercing', () => {
  for (const malformed of [{}, { valueId: null }, { valueId: '   ' }, { valueId: 7 }]) {
    const facts = summarize([malformed]).returnProvenance;
    assert.equal(facts.length, 1);
    assert.equal(facts[0].kind, 'unknown',
      `malformed record ${JSON.stringify(malformed)} must remain an explicit unknown`);
    assert.equal(facts[0].argIndex ?? null, null,
      'a malformed record must not coerce onto a real caller formal');
  }
});

test('issue-6151: structured arguments compose callee offsets onto the caller argument', () => {
  const offsetSummary = buildLocalFunctionSummary(
    callerIr([{ valueId: 'arg0' }]), cfg, null, null,
    { snapshotId: 'snapshot-6151', calleeSummaries: new Map([['fn_callee', calleeReturnArg('8')]]) },
  ).summary;
  assert.deepEqual(offsetSummary.returnProvenance, [{
    kind: 'arg', argIndex: 0, offset: '8', rootEntityId: null, returnIndex: 0,
  }]);
});

test('issue-6151: an incomplete callee summary still degrades to unknown', () => {
  // The unwrap must never promote authority: fail-closed behavior for
  // identity-mismatched or incomplete callees is unchanged.
  const incomplete = createFunctionSummary({
    functionId: 'fn_callee',
    inputs: ['x0'],
    returnValues: ['ret'],
    returnProvenance: [{ kind: 'arg', returnIndex: 0, argIndex: 0, offset: '0' }],
    noreturn: false,
    mayThrow: false,
    status: { ...completeStatus(), completeness: 'partial', stopReason: 'budget-exhausted' },
  });
  const summary = buildLocalFunctionSummary(
    callerIr([{ valueId: 'arg0' }]), cfg, null, null,
    { snapshotId: 'snapshot-6151', calleeSummaries: new Map([['fn_callee', incomplete]]) },
  ).summary;
  assert.ok(summary.returnProvenance.every((fact) => fact.kind === 'unknown'),
    'an incomplete callee must not publish arg provenance');
});
