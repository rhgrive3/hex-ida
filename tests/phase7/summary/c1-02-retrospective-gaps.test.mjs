import assert from 'node:assert/strict';
import test from 'node:test';

import { analyzeLocalPointsTo } from '../../../js/analysis/pointsto/local.js';
import { createFunctionSummary } from '../../../js/analysis/summary/contract.js';
import { solveInterproceduralSummaries } from '../../../js/analysis/summary/interprocedural.js';
import { buildLocalFunctionSummary } from '../../../js/analysis/summary/local.js';
import { createSemanticCfg } from '../../../js/semantics/cfg/index.js';
import { createSemanticIrFunction } from '../../../js/semantics/ir/function.js';
import { buildSemanticSsa } from '../../../js/semantics/ssa/build.js';

const origin = (id) => ({ instructionIds: [`instruction_${id}`] });

function completeStatus(snapshotId = 'snapshot-c1-02') {
  return {
    snapshotId,
    analyzerId: 'c1-02-regression',
    analyzerVersion: '1.0.0',
    completeness: 'complete',
  };
}

function makeCaller({
  functionId = 'fn_caller',
  arguments: argumentIds = ['arg0', 'arg1'],
  outputs = ['ret0'],
  targetEntityId = 'fn_callee',
  includeReturn = false,
} = {}) {
  const values = argumentIds.map((id, index) => ({
    id,
    kind: 'definition',
    definitionNodeId: `node_${id}`,
    machineType: { kind: 'bitvector', widthBits: 64 },
    metadata: { argumentIndex: index },
    origin: origin(id),
  }));
  const nodes = argumentIds.map((id, index) => ({
    id: `node_${id}`,
    kind: 'state-read',
    blockId: 'entry',
    inputs: [],
    outputs: [id],
    variable: { key: `state:x${index}`, kind: 'physical-state', scope: 'function' },
    origin: origin(id),
  }));
  for (const id of outputs) {
    values.push({
      id,
      kind: 'definition',
      definitionNodeId: 'node_call',
      machineType: { kind: 'bitvector', widthBits: 64 },
      origin: origin(id),
    });
  }
  nodes.push({
    id: 'node_call',
    kind: 'call',
    blockId: 'entry',
    inputs: argumentIds,
    outputs,
    call: {
      targetValueIds: [],
      targetEntityIds: [targetEntityId],
      arguments: argumentIds,
      returns: outputs,
      memoryRead: { scope: 'none' },
      memoryWrite: { scope: 'none' },
      stateReads: [],
      stateWrites: [],
      controlEffects: [],
      determinism: 'deterministic',
      noreturn: false,
      mayThrow: false,
      summarySource: 'c1-02-regression',
      completeness: 'complete',
    },
    origin: origin('node_call'),
  });
  if (includeReturn) {
    nodes.push({
      id: 'node_return',
      kind: 'return',
      blockId: 'entry',
      inputs: outputs,
      outputs: [],
      origin: origin('node_return'),
    });
  }
  const ir = createSemanticIrFunction({
    functionId,
    entryBlockId: 'entry',
    origin: origin(functionId),
    blocks: [{ id: 'entry', nodeIds: nodes.map((node) => node.id), origin: origin('entry') }],
    values,
    nodes,
  });
  const cfg = createSemanticCfg({
    functionId,
    entryBlockId: 'entry',
    blocks: [{ id: 'entry', successors: [] }],
  });
  const ssa = buildSemanticSsa(ir, cfg);
  return { ir, cfg, ssa };
}

function calleeSummary(returnProvenance, snapshotId = 'snapshot-c1-02') {
  return createFunctionSummary({
    functionId: 'fn_callee',
    inputs: ['arg0', 'arg1'],
    returnValues: ['ret0', 'ret1'],
    returnProvenance,
    noreturn: false,
    mayThrow: false,
    status: completeStatus(snapshotId),
  });
}

test('HEX-C1-02 E: ABI return positions stay separated', () => {
  const fixture = makeCaller({ outputs: ['ret0', 'ret1'] });
  const summary = calleeSummary([
    { kind: 'arg', returnIndex: 0, argIndex: 0, offset: '0' },
    { kind: 'arg', returnIndex: 1, argIndex: 1, offset: '0' },
  ]);
  const result = analyzeLocalPointsTo(fixture.ir, fixture.cfg, fixture.ssa, {
    snapshotId: 'snapshot-c1-02',
    summaries: new Map([['fn_callee', summary]]),
  });
  const ret0 = result.pointsTo.get('ret0');
  const ret1 = result.pointsTo.get('ret1');
  assert.equal(ret0.top, false);
  assert.equal(ret1.top, false);
  assert.equal(ret0.targets[0].rootEntityId, result.pointsTo.get('arg0').targets[0].rootEntityId);
  assert.equal(ret1.targets[0].rootEntityId, result.pointsTo.get('arg1').targets[0].rootEntityId);
  assert.notEqual(ret0.targets[0].rootEntityId, ret1.targets[0].rootEntityId);
});

test('HEX-C1-02 I: a complete summary from another snapshot stays unresolved', () => {
  const fixture = makeCaller({ outputs: ['ret0'] });
  const stale = calleeSummary([{ kind: 'arg', returnIndex: 0, argIndex: 0, offset: '0' }], 'snapshot-old');
  const result = analyzeLocalPointsTo(fixture.ir, fixture.cfg, fixture.ssa, {
    snapshotId: 'snapshot-new',
    summaries: new Map([['fn_callee', stale]]),
  });
  const ret0 = result.pointsTo.get('ret0');
  assert.equal(ret0.top, true);
  assert.ok(ret0.lossReasons.includes('unresolved-call'));
});

test('HEX-C1-02 I: malformed summary shape stays unresolved without throwing', () => {
  const fixture = makeCaller({ outputs: ['ret0'] });
  const malformed = {
    ...calleeSummary([{ kind: 'arg', returnIndex: 0, argIndex: 0, offset: '0' }]),
    returnProvenance: null,
  };
  const result = analyzeLocalPointsTo(fixture.ir, fixture.cfg, fixture.ssa, {
    snapshotId: 'snapshot-c1-02',
    summaries: new Map([['fn_callee', malformed]]),
  });
  const ret0 = result.pointsTo.get('ret0');
  assert.equal(ret0.top, true);
  assert.ok(ret0.lossReasons.includes('unresolved-call'));
});

test('HEX-C1-02 K: a converged wrapper carries the proven callee return', () => {
  const identity = createFunctionSummary({
    functionId: 'fn_identity',
    inputs: ['arg0'],
    returnValues: ['ret0'],
    returnProvenance: [{ kind: 'arg', returnIndex: 0, argIndex: 0, offset: '0' }],
    noreturn: false,
    mayThrow: false,
    status: completeStatus('snapshot-c1-02'),
  });
  const wrapper = makeCaller({
    functionId: 'fn_wrapper',
    arguments: ['arg0'],
    outputs: ['ret0'],
    targetEntityId: 'fn_identity',
    includeReturn: true,
  });
  const local = buildLocalFunctionSummary(wrapper.ir, wrapper.cfg, wrapper.ssa, null, {
    snapshotId: 'snapshot-c1-02',
    calleeSummaries: new Map([['fn_identity', identity]]),
  }).summary;
  const solved = solveInterproceduralSummaries({
    roots: ['fn_wrapper'],
    localSummaries: new Map([['fn_identity', identity], ['fn_wrapper', local]]),
    snapshotId: 'snapshot-c1-02',
  }).summaries.get('fn_wrapper');
  assert.ok(solved);
  assert.deepEqual(solved.returnProvenance, [{
    kind: 'arg', returnIndex: 0, argIndex: 0, offset: '0', rootEntityId: null,
  }]);
});

for (const kind of ['root', 'allocation']) {
  test(`HEX-C1-02 P: ${kind}-derived return remains a canonical pointer fact`, () => {
    const fixture = makeCaller({ arguments: [], outputs: ['ret0'] });
    const summary = calleeSummary([{
      kind,
      returnIndex: 0,
      rootEntityId: `${kind}-site-1`,
      offset: '16',
    }]);
    const result = analyzeLocalPointsTo(fixture.ir, fixture.cfg, fixture.ssa, {
      snapshotId: 'snapshot-c1-02',
      summaries: new Map([['fn_callee', summary]]),
    });
    const ret0 = result.pointsTo.get('ret0');
    assert.equal(ret0.top, false);
    assert.equal(ret0.targets[0].rootEntityId, `${kind}-site-1`);
    assert.equal(ret0.targets[0].offsetRange.min, 16n);
  });
}
