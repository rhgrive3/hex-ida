import assert from 'node:assert/strict';
import test from 'node:test';

import { analyzeLocalPointsTo } from '../../../js/analysis/pointsto/local.js';
import {
  createFunctionSummary,
  summaryIdentityMatches,
} from '../../../js/analysis/summary/contract.js';
import { solveInterproceduralSummaries } from '../../../js/analysis/summary/interprocedural.js';
import { createSemanticCfg } from '../../../js/semantics/cfg/index.js';
import { createSemanticIrFunction } from '../../../js/semantics/ir/function.js';
import { buildSemanticSsa } from '../../../js/semantics/ssa/build.js';

const origin = (id) => ({ instructionIds: [`instruction_${id}`] });

function completeStatus(analyzerId = 'c1-02-matrix-callee', snapshotId = 'snapshot-c1-02-matrix') {
  return {
    snapshotId,
    analyzerId,
    analyzerVersion: '1.0.0',
    completeness: 'complete',
  };
}

function partialStatus(analyzerId = 'c1-02-matrix-callee', snapshotId = 'snapshot-c1-02-matrix') {
  return {
    snapshotId,
    analyzerId,
    analyzerVersion: '1.0.0',
    completeness: 'partial',
    stopReason: 'evidence-missing',
  };
}

function calleeSummary(returnProvenance, {
  functionId = 'fn_callee',
  returnValues = ['ret'],
  status = completeStatus(),
  memoryWriteRegions = [],
  unknownCallEffects = [],
  directCalls = [],
  indirectCallSets = [],
} = {}) {
  return createFunctionSummary({
    functionId,
    returnValues,
    returnProvenance,
    memoryWriteRegions,
    unknownCallEffects,
    directCalls,
    indirectCallSets,
    noreturn: false,
    mayThrow: false,
    status,
  });
}

function callerFixture({
  functionId = 'fn_caller',
  calleeEntityId = 'fn_callee',
  returnProvenance,
  calleeStatus,
  summaryIdentity = 'fn_callee',
  outputs = ['call_ret'],
  argumentIds = ['arg0', 'arg1'],
  budget = {},
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

  for (const retId of outputs) {
    values.push({
      id: retId,
      kind: 'definition',
      definitionNodeId: 'node_call',
      machineType: { kind: 'bitvector', widthBits: 64 },
      origin: origin(retId),
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
      targetEntityIds: calleeEntityId ? [calleeEntityId] : [],
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
      summarySource: 'c1-02-matrix-fixture',
      completeness: 'complete',
    },
    origin: origin('node_call'),
  });

  const ir = createSemanticIrFunction({
    functionId,
    entryBlockId: 'entry',
    origin: origin(functionId),
    blocks: [{ id: 'entry', nodeIds: nodes.map((node) => node.id), origin: origin('entry') }],
    values,
    nodes,
    completeness: 'complete',
    unknowns: [],
  });

  const cfg = createSemanticCfg({
    functionId,
    entryBlockId: 'entry',
    blocks: [{ id: 'entry', successors: [] }],
  });

  const ssa = buildSemanticSsa(ir, cfg);

  const provenance = returnProvenance ?? [{ kind: 'arg', returnIndex: 0, argIndex: 0, offset: '0' }];
  const summary = calleeSummary(provenance, {
    functionId: summaryIdentity ?? 'fn_callee',
    status: calleeStatus ?? completeStatus(),
  });

  const summaries = summaryIdentity == null
    ? new Map()
    : new Map([[summaryIdentity, summary]]);

  return { ir, cfg, ssa, summaries, budget };
}

function targetlessCallerFixture() {
  const fixture = callerFixture({ calleeEntityId: null });
  const node = fixture.ir.nodes.find((n) => n.kind === 'call');
  const originInst = { instructionIds: ['instruction_retarget'] };
  const retargeted = {
    ...node,
    call: {
      ...node.call,
      targetEntityIds: [],
      completeness: 'partial',
      unknownEffects: { reason: 'non-exhaustive-indirect-targets', categories: ['control'] },
    },
    completeness: 'partial',
    unknown: { reason: 'non-exhaustive-indirect-targets', categories: ['control'] },
    origin: originInst,
  };

  const nodes = fixture.ir.nodes.map((n) => (n.id === retargeted.id ? retargeted : n));
  const ir = createSemanticIrFunction({
    functionId: fixture.ir.functionId,
    entryBlockId: fixture.ir.entryBlockId,
    origin: fixture.ir.origin,
    blocks: fixture.ir.blocks,
    values: fixture.ir.values,
    nodes,
    completeness: 'partial',
    unknowns: [{ reason: 'non-exhaustive-indirect-targets', categories: ['control'] }],
  });
  const cfg = createSemanticCfg({
    functionId: ir.functionId,
    entryBlockId: ir.entryBlockId,
    blocks: [{ id: ir.entryBlockId, successors: [] }],
  });
  const ssa = buildSemanticSsa(ir, cfg);
  return { ...fixture, ir, cfg, ssa };
}

function assertUnresolvedCall(fixture, { returnId = 'call_ret', options = {} } = {}) {
  const result = analyzeLocalPointsTo(fixture.ir, fixture.cfg, fixture.ssa, {
    snapshotId: 'snapshot-c1-02-matrix',
    summaries: fixture.summaries,
    ...fixture.budget,
    ...options,
  });
  const pointsTo = result.pointsTo.get(returnId);
  assert.ok(pointsTo, `${returnId} must have a points-to entry`);
  assert.equal(pointsTo.top, true, `${returnId} must be TOP`);
  assert.ok(pointsTo.lossReasons.includes('unresolved-call'), `${returnId} must include unresolved-call loss reason`);
  return result;
}

// =============================================================================
// Positive User Scenario: Complete, Valid Summary Joins Return Provenance
// =============================================================================

test('HEX-C1-02 positive: complete callee yields precise joined target set (arg provenance)', () => {
  const fixture = callerFixture({
    returnProvenance: [
      { kind: 'arg', returnIndex: 0, argIndex: 0, offset: '0' },
      { kind: 'arg', returnIndex: 0, argIndex: 1, offset: '16' },
    ],
  });
  const result = analyzeLocalPointsTo(fixture.ir, fixture.cfg, fixture.ssa, {
    snapshotId: 'snapshot-c1-02-matrix',
    summaries: fixture.summaries,
  });
  const pointsTo = result.pointsTo.get('call_ret');
  assert.equal(pointsTo.top, false);
  assert.equal(pointsTo.targets.length, 2);
  const roots = pointsTo.targets.map((target) => target.rootEntityId).sort();
  const expected = [
    result.pointsTo.get('arg0').targets[0].rootEntityId,
    result.pointsTo.get('arg1').targets[0].rootEntityId,
  ].sort();
  assert.deepEqual(roots, expected);
});

test('HEX-C1-02 positive: complete callee yields precise target for root and allocation provenance', () => {
  const fixture = callerFixture({
    returnProvenance: [
      { kind: 'root', returnIndex: 0, rootEntityId: 'global_table', offset: '8' },
      { kind: 'allocation', returnIndex: 0, allocationSiteId: 'alloc_site_42', offset: '0' },
    ],
  });
  const result = analyzeLocalPointsTo(fixture.ir, fixture.cfg, fixture.ssa, {
    snapshotId: 'snapshot-c1-02-matrix',
    summaries: fixture.summaries,
  });
  const pointsTo = result.pointsTo.get('call_ret');
  assert.equal(pointsTo.top, false);
  assert.equal(pointsTo.targets.length, 2);
  const rootTarget = pointsTo.targets.find((t) => t.rootEntityId === 'global_table');
  const allocTarget = pointsTo.targets.find((t) => t.rootEntityId === 'alloc_site_42');
  assert.ok(rootTarget);
  assert.ok(allocTarget);
  assert.equal(rootTarget.rootKind, 'rooted');
  assert.equal(allocTarget.rootKind, 'allocation');
});

// =============================================================================
// 13-Axis Fail-Closed Negative Matrix
// =============================================================================

// Axis 1: Summary missing
test('HEX-C1-02 matrix axis 1: missing summary stays unresolved', () => {
  const fixture = callerFixture({});
  fixture.summaries.delete('fn_callee');
  fixture.summaries.set('fn_other', calleeSummary([{ kind: 'arg', returnIndex: 0, argIndex: 0, offset: '0' }]));
  assertUnresolvedCall(fixture);
});

// Axis 2: Targetless call
test('HEX-C1-02 matrix axis 2: targetless call stays unresolved', () => {
  const fixture = targetlessCallerFixture();
  assertUnresolvedCall(fixture);
});

// Axis 3: Analyzer / Snapshot / Schema / Identity mismatch
test('HEX-C1-02 matrix axis 3a: snapshot identity mismatch stays unresolved', () => {
  const fixture = callerFixture({
    calleeStatus: completeStatus('c1-02-matrix-callee', 'snapshot-other'),
  });
  assertUnresolvedCall(fixture);
});

test('HEX-C1-02 matrix axis 3b: pinned analyzer identity mismatch stays unresolved', () => {
  const fixture = callerFixture({
    calleeStatus: completeStatus('different-analyzer', 'snapshot-c1-02-matrix'),
  });
  assertUnresolvedCall(fixture, {
    options: { summaryAnalyzerId: 'c1-02-matrix-callee' },
  });
});

test('HEX-C1-02 matrix axis 3c: schema version mismatch fails closed', () => {
  const fixture = callerFixture({});
  const forged = {
    ...fixture.summaries.get('fn_callee'),
    schemaVersion: 999,
  };
  assertUnresolvedCall({ ...fixture, summaries: new Map([['fn_callee', forged]]) });
});

test('HEX-C1-02 matrix axis 3d: contract version mismatch fails closed', () => {
  const fixture = callerFixture({});
  const forged = {
    ...fixture.summaries.get('fn_callee'),
    contractVersion: '99.0.0',
  };
  assertUnresolvedCall({ ...fixture, summaries: new Map([['fn_callee', forged]]) });
});

test('HEX-C1-02 matrix axis 3e: functionId mismatch fails closed', () => {
  const fixture = callerFixture({});
  const forged = {
    ...fixture.summaries.get('fn_callee'),
    functionId: 'fn_mismatched',
  };
  assertUnresolvedCall({ ...fixture, summaries: new Map([['fn_callee', forged]]) });
});

// Axis 4: Incomplete / partial / unsupported status
test('HEX-C1-02 matrix axis 4a: partial status stays unresolved', () => {
  const fixture = callerFixture({
    calleeStatus: partialStatus('c1-02-matrix-callee', 'snapshot-c1-02-matrix'),
  });
  assertUnresolvedCall(fixture);
});

test('HEX-C1-02 matrix axis 4b: truncated/unsupported status stays unresolved', () => {
  const fixture = callerFixture({
    calleeStatus: {
      snapshotId: 'snapshot-c1-02-matrix',
      analyzerId: 'c1-02-matrix-callee',
      analyzerVersion: '1.0.0',
      completeness: 'truncated',
      stopReason: 'budget-exhausted',
    },
  });
  assertUnresolvedCall(fixture);
});

// Axis 5: Unknown call effects
test('HEX-C1-02 matrix axis 5: unknown call effects stay unresolved', () => {
  const fixture = callerFixture({});
  const effectful = { ...fixture.summaries.get('fn_callee') };
  Object.defineProperty(effectful, 'unknownCallEffects', {
    value: [{ callSiteId: 'call_site_1', reason: 'unknown-call-fallback', evidenceIds: [] }],
    enumerable: true,
  });
  fixture.summaries.set('fn_callee', effectful);
  assertUnresolvedCall(fixture);
});

// Axis 6: Empty return provenance
test('HEX-C1-02 matrix axis 6: empty return provenance stays unresolved', () => {
  const fixture = callerFixture({ returnProvenance: [] });
  assertUnresolvedCall(fixture);
});

// Axis 7: Wrong or missing return index
test('HEX-C1-02 matrix axis 7: wrong returnIndex stays unresolved', () => {
  const fixture = callerFixture({
    returnProvenance: [{ kind: 'arg', returnIndex: 1, argIndex: 0, offset: '0' }],
  });
  assertUnresolvedCall(fixture);
});

// Axis 8: Argument points-to = TOP
test('HEX-C1-02 matrix axis 8: top argument set stays unresolved', () => {
  const fixture = callerFixture({
    returnProvenance: [{ kind: 'arg', returnIndex: 0, argIndex: 0, offset: '0' }],
  });
  const originInst = { instructionIds: ['instruction_toparg'] };
  const ir = createSemanticIrFunction({
    functionId: 'fn_caller',
    entryBlockId: 'entry',
    origin: originInst,
    blocks: [{ id: 'entry', nodeIds: ['node_arg0_top', 'node_arg1', 'node_call'], origin: originInst }],
    values: [
      { id: 'arg0', kind: 'definition', definitionNodeId: 'node_arg0_top', machineType: { kind: 'bitvector', widthBits: 64 }, origin: originInst },
      { id: 'arg1', kind: 'definition', definitionNodeId: 'node_arg1', machineType: { kind: 'bitvector', widthBits: 64 }, origin: originInst },
      { id: 'call_ret', kind: 'definition', definitionNodeId: 'node_call', machineType: { kind: 'bitvector', widthBits: 64 }, origin: originInst },
    ],
    nodes: [
      {
        id: 'node_arg0_top', kind: 'unknown-value', blockId: 'entry', inputs: [], outputs: ['arg0'],
        completeness: 'unknown', unknown: { reason: 'non-exhaustive-indirect-targets', categories: ['control'] }, origin: originInst,
      },
      fixture.ir.nodes.find((n) => n.id === 'node_arg1'),
      fixture.ir.nodes.find((n) => n.id === 'node_call'),
    ],
    completeness: 'partial',
    unknowns: [{ reason: 'non-exhaustive-indirect-targets', categories: ['control'] }],
  });
  const cfg = createSemanticCfg({
    functionId: ir.functionId,
    entryBlockId: ir.entryBlockId,
    blocks: [{ id: ir.entryBlockId, successors: [] }],
  });
  const ssa = buildSemanticSsa(ir, cfg);
  const result = analyzeLocalPointsTo(ir, cfg, ssa, {
    snapshotId: 'snapshot-c1-02-matrix',
    summaries: fixture.summaries,
  });
  const pointsTo = result.pointsTo.get('call_ret');
  assert.equal(pointsTo.top, true);
  assert.ok(pointsTo.lossReasons.includes('unresolved-call'));
});

// Axis 9: Argument absent
test('HEX-C1-02 matrix axis 9: absent argument stays unresolved', () => {
  const fixture = callerFixture({
    returnProvenance: [{ kind: 'arg', returnIndex: 0, argIndex: 5, offset: '0' }],
  });
  assertUnresolvedCall(fixture);
});

// Axis 10: Malformed offset
test('HEX-C1-02 matrix axis 10: malformed offset stays unresolved', () => {
  const fixture = callerFixture({});
  const canonical = fixture.summaries.get('fn_callee');
  const forged = {
    ...canonical,
    returnProvenance: [{
      kind: 'arg',
      returnIndex: 0,
      argIndex: 0,
      offset: 'not-a-number',
    }],
  };
  assertUnresolvedCall({ ...fixture, summaries: new Map([['fn_callee', forged]]) });
});

// Axis 11: Unknown provenance kind
test('HEX-C1-02 matrix axis 11: unknown provenance kind stays unresolved', () => {
  const fixture = callerFixture({
    returnProvenance: [{ kind: 'unknown-custom-kind', returnIndex: 0, argIndex: 0, offset: '0' }],
  });
  assertUnresolvedCall(fixture);
});

// Axis 12: Candidate construction / join overflow / budget failure
test('HEX-C1-02 matrix axis 12: points-to budget overflow falls back to conservative top', () => {
  const fixture = callerFixture({
    returnProvenance: [
      { kind: 'root', returnIndex: 0, rootEntityId: 'root_A', offset: '0' },
      { kind: 'root', returnIndex: 0, rootEntityId: 'root_B', offset: '0' },
    ],
  });
  const result = analyzeLocalPointsTo(fixture.ir, fixture.cfg, fixture.ssa, {
    snapshotId: 'snapshot-c1-02-matrix',
    summaries: fixture.summaries,
    budget: { maxTargetsPerSet: 1 },
  });
  const pointsTo = result.pointsTo.get('call_ret');
  assert.equal(pointsTo.top, true);
  assert.ok(pointsTo.lossReasons.includes('target-cap'));
});

// Axis 13: Self-recursive and mutually recursive summaries through real fixed point
test('HEX-C1-02 matrix axis 13a: self-recursive callee summary bounded by fixed point', () => {
  const local = (functionId, calls, provenance) => createFunctionSummary({
    functionId,
    returnValues: ['ret'],
    returnProvenance: provenance,
    directCalls: calls.map((target) => ({
      callSiteId: `call_${functionId}_${target}`,
      targetEntityIds: [target],
      effectSource: 'abi-rule',
    })),
    noreturn: false,
    mayThrow: false,
    status: completeStatus('interprocedural-test', 'snapshot-c1-02-matrix'),
  });

  const locals = new Map([
    ['fn_callee', local('fn_callee', ['fn_callee'], [
      { kind: 'arg', returnIndex: 0, argIndex: 0, offset: '0' },
    ])],
    ['fn_caller', local('fn_caller', ['fn_callee'], [])],
  ]);

  const solved = solveInterproceduralSummaries({
    roots: ['fn_caller'],
    localSummaries: locals,
    snapshotId: 'snapshot-c1-02-matrix',
  });
  assert.ok(solved.summaries.has('fn_callee'), 'recursive callee must be solved');
  assert.ok(
    solved.status.completeness === 'complete' || solved.status.stopReason != null,
    'unconverged recursive solve must carry explicit stop reason',
  );

  const fixture = callerFixture();
  const result = analyzeLocalPointsTo(fixture.ir, fixture.cfg, fixture.ssa, {
    snapshotId: 'snapshot-c1-02-matrix',
    summaries: solved.summaries,
  });
  const pointsTo = result.pointsTo.get('call_ret');
  if (!pointsTo.top) {
    const argSet = result.pointsTo.get('arg0');
    assert.deepEqual([...pointsTo.targets].sort(), [...argSet.targets].sort());
  } else {
    assert.ok(pointsTo.lossReasons.includes('unresolved-call'));
  }
});

test('HEX-C1-02 matrix axis 13b: mutually recursive callees terminate without unbounded growth', () => {
  const local = (functionId, calls, provenance) => createFunctionSummary({
    functionId,
    returnValues: ['ret'],
    returnProvenance: provenance,
    directCalls: calls.map((target) => ({
      callSiteId: `call_${functionId}_${target}`,
      targetEntityIds: [target],
      effectSource: 'abi-rule',
    })),
    noreturn: false,
    mayThrow: false,
    status: completeStatus('interprocedural-test', 'snapshot-c1-02-matrix'),
  });

  const locals = new Map([
    ['fn_a', local('fn_a', ['fn_b'], [{ kind: 'arg', returnIndex: 0, argIndex: 0, offset: '0' }])],
    ['fn_b', local('fn_b', ['fn_a'], [{ kind: 'arg', returnIndex: 0, argIndex: 0, offset: '0' }])],
    ['fn_caller', local('fn_caller', ['fn_a'], [])],
  ]);

  const solved = solveInterproceduralSummaries({
    roots: ['fn_caller'],
    localSummaries: locals,
    snapshotId: 'snapshot-c1-02-matrix',
  });
  assert.ok(solved.summaries.has('fn_a'));
  assert.ok(solved.summaries.has('fn_b'));
  assert.ok(solved.iterations > 0 && solved.iterations <= 32);
});

test('HEX-C1-02 matrix axis 13c: unconverged recursion publishes conservative status and stays unresolved', () => {
  const local = (functionId, calls, provenance) => createFunctionSummary({
    functionId,
    returnValues: ['ret'],
    returnProvenance: provenance,
    directCalls: calls.map((target) => ({
      callSiteId: `call_${functionId}_${target}`,
      targetEntityIds: [target],
      effectSource: 'abi-rule',
    })),
    noreturn: false,
    mayThrow: false,
    status: completeStatus('interprocedural-test', 'snapshot-c1-02-matrix'),
  });

  const locals = new Map([
    ['fn_a', local('fn_a', ['fn_b'], [{ kind: 'arg', returnIndex: 0, argIndex: 0, offset: '0' }])],
    ['fn_b', local('fn_b', ['fn_a'], [{ kind: 'arg', returnIndex: 0, argIndex: 0, offset: '0' }])],
    ['fn_caller', local('fn_caller', ['fn_a'], [])],
  ]);

  // Set maxIterationsPerComponent to 0 to force immediate budget exhaustion / non-convergence
  const solved = solveInterproceduralSummaries({
    roots: ['fn_caller'],
    localSummaries: locals,
    budget: { maxIterationsPerComponent: 0 },
    snapshotId: 'snapshot-c1-02-matrix',
  });
  const summaryA = solved.summaries.get('fn_a');
  assert.ok(summaryA);
  assert.notEqual(summaryA.status.completeness, 'complete');
  assert.ok(summaryA.unknownCallEffects.some((e) => e.reason === 'recursion-unconverged'));

  const fixture = callerFixture({ calleeEntityId: 'fn_a' });
  const result = analyzeLocalPointsTo(fixture.ir, fixture.cfg, fixture.ssa, {
    snapshotId: 'snapshot-c1-02-matrix',
    summaries: solved.summaries,
  });
  const pointsTo = result.pointsTo.get('call_ret');
  assert.equal(pointsTo.top, true);
  assert.ok(pointsTo.lossReasons.includes('unresolved-call'));
});
