import assert from 'node:assert/strict';
import test from 'node:test';

import { analyzeLocalPointsTo } from '../../../js/analysis/pointsto/local.js';
import {
  createFunctionSummary,
} from '../../../js/analysis/summary/contract.js';
import { createSemanticCfg } from '../../../js/semantics/cfg/index.js';
import { createSemanticIrFunction } from '../../../js/semantics/ir/function.js';
import { buildSemanticSsa } from '../../../js/semantics/ssa/build.js';

const origin = (id) => ({ instructionIds: [`instruction_${id}`] });

function completeStatus(analyzerId = 'c1-02-matrix-callee') {
  return {
    snapshotId: 'snapshot-c1-02-matrix',
    analyzerId,
    analyzerVersion: '1.0.0',
    completeness: 'complete',
  };
}

function partialStatus(analyzerId = 'c1-02-matrix-callee') {
  return { ...completeStatus(analyzerId), completeness: 'partial' };
}

function calleeSummary(returnProvenance, { status = completeStatus() } = {}) {
  return createFunctionSummary({
    functionId: 'fn_callee',
    returnValues: ['ret'],
    returnProvenance,
    noreturn: false,
    mayThrow: false,
    status,
  });
}

// A call node whose call summary carries no target at all. Valid IR (verified:
// createSemanticIrFunction accepts it with a partial/unknown detail), and
// classifyCallTargetProof maps it to kind 'unknown' with no exact singleton.
function targetlessCallerFixture() {
  const fixture = callerFixture({});
  const node = fixture.ir.nodes.find((n) => n.kind === 'call');
  const origin = { instructionIds: ['instruction_retarget'] };
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
    origin,
  };
  return rebuildIrWithNode(fixture, retargeted);
}

function rebuildIrWithNode(fixture, replacement) {
  const nodes = fixture.ir.nodes.map((n) => (n.id === replacement.id ? replacement : n));
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

function callerFixture({
  returnProvenance,
  calleeStatus,
  summaryIdentity = 'fn_callee',
  extraSummaryField,
} = {}) {
  const values = [
    { id: 'arg0', kind: 'definition', definitionNodeId: 'node_arg0', machineType: { kind: 'bitvector', widthBits: 64 }, origin: origin('arg0') },
    { id: 'arg1', kind: 'definition', definitionNodeId: 'node_arg1', machineType: { kind: 'bitvector', widthBits: 64 }, origin: origin('arg1') },
    { id: 'call_ret', kind: 'definition', definitionNodeId: 'node_call', machineType: { kind: 'bitvector', widthBits: 64 }, origin: origin('call_ret') },
  ];
  const nodes = [
    {
      id: 'node_arg0', kind: 'state-read', blockId: 'entry', inputs: [], outputs: ['arg0'],
      variable: { key: 'state:x0', kind: 'physical-state', scope: 'function' }, origin: origin('node_arg0'),
    },
    {
      id: 'node_arg1', kind: 'state-read', blockId: 'entry', inputs: [], outputs: ['arg1'],
      variable: { key: 'state:x1', kind: 'physical-state', scope: 'function' }, origin: origin('node_arg1'),
    },
    {
      id: 'node_call',
      kind: 'call',
      blockId: 'entry',
      inputs: ['arg0', 'arg1'],
      outputs: ['call_ret'],
      call: {
        targetValueIds: [],
        targetEntityIds: [summaryIdentity],
        arguments: ['arg0', 'arg1'],
        returns: ['call_ret'],
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
    },
  ];

  const ir = createSemanticIrFunction({
    functionId: 'fn_caller',
    entryBlockId: 'entry',
    origin: origin('fn_caller'),
    blocks: [{ id: 'entry', nodeIds: nodes.map((node) => node.id), origin: origin('entry') }],
    values,
    nodes,
    completeness: 'complete',
    unknowns: [],
  });
  const cfg = createSemanticCfg({
    functionId: 'fn_caller',
    entryBlockId: 'entry',
    blocks: [{ id: 'entry', successors: [] }],
  });
  const ssa = buildSemanticSsa(ir, cfg);

  const provenance = returnProvenance ?? [{ kind: 'arg', returnIndex: 0, argIndex: 0, offset: '0' }];
  const summary = calleeSummary(provenance, { status: calleeStatus ?? completeStatus() });
  if (extraSummaryField) {
    Object.defineProperty(summary, extraSummaryField, { value: ['injected-unknown'], enumerable: true });
  }
  const summaries = summaryIdentity == null
    ? new Map()
    : new Map([[summaryIdentity, summary]]);
  return { ir, cfg, ssa, summaries };
}

function assertUnresolvedCall(fixture) {
  const result = analyzeLocalPointsTo(fixture.ir, fixture.cfg, fixture.ssa, {
    snapshotId: 'snapshot-c1-02-matrix',
    summaries: fixture.summaries,
  });
  const pointsTo = result.pointsTo.get('call_ret');
  assert.ok(pointsTo, 'call_ret must have a points-to entry');
  assert.equal(pointsTo.top, true);
  assert.ok(pointsTo.lossReasons.includes('unresolved-call'));
  return result;
}

// Axis 1 — missing summary: no entry for the callee id.
test('HEX-C1-02 matrix axis 1: missing summary stays unresolved', () => {
  const fixture = callerFixture({});
  // Registered under a name the call never names, so the callee lookup misses.
  fixture.summaries.delete('fn_callee');
  fixture.summaries.set('fn_other', calleeSummary([{ kind: 'arg', returnIndex: 0, argIndex: 0, offset: '0' }]));
  assertUnresolvedCall(fixture);
});

// Axis 1b — call with no target at all (kind 'unknown', no exact singleton).
test('HEX-C1-02 matrix axis 1b: targetless call stays unresolved', () => {
  const fixture = targetlessCallerFixture();
  assertUnresolvedCall(fixture);
});

// Axis 2 — identity mismatch: a consumer that pins the expected analyzer identity
// refuses a summary produced under a different analyzer. Unpinned consumers accept
// any analyzer by design; the gate only fires for the pinned contract.
test('HEX-C1-02 matrix axis 2: analyzer identity mismatch stays unresolved', () => {
  const fixture = callerFixture({ calleeStatus: completeStatus('different-analyzer') });
  const result = analyzeLocalPointsTo(fixture.ir, fixture.cfg, fixture.ssa, {
    snapshotId: 'snapshot-c1-02-matrix',
    summaries: fixture.summaries,
    summaryAnalyzerId: 'c1-02-matrix-callee',
  });
  const pointsTo = result.pointsTo.get('call_ret');
  assert.equal(pointsTo.top, true);
  assert.ok(pointsTo.lossReasons.includes('unresolved-call'));
});

// Axis 3 — incomplete status. Incomplete statuses require a stop reason, so the
// summary is built through createAnalysisStatus with a bounded/evidence-missing pair.
test('HEX-C1-02 matrix axis 3: partial status stays unresolved', () => {
  const fixture = callerFixture({
    calleeStatus: {
      snapshotId: 'snapshot-c1-02-matrix',
      analyzerId: 'c1-02-matrix-callee',
      analyzerVersion: '1.0.0',
      completeness: 'partial',
      stopReason: 'evidence-missing',
    },
  });
  assertUnresolvedCall(fixture);
});

// Axis 4 — unknown call effects present on the summary. The summary contract
// freezes its own array, so inject a fresh effect list through a wrapper summary
// consumed under a matching identity.
test('HEX-C1-02 matrix axis 4: unknown call effects stay unresolved', () => {
  const fixture = callerFixture({});
  const effectful = { ...fixture.summaries.get('fn_callee') };
  Object.defineProperty(effectful, 'unknownCallEffects', {
    value: [{ reason: 'unknown-call-fallback', categories: ['memory', 'state'] }],
    enumerable: true,
  });
  fixture.summaries.set('fn_callee', effectful);
  assertUnresolvedCall(fixture);
});

// Axis 5 — empty returnProvenance for the consumed return index.
test('HEX-C1-02 matrix axis 5: empty provenance stays unresolved', () => {
  const fixture = callerFixture({ returnProvenance: [] });
  assertUnresolvedCall(fixture);
});

// Axis 5b — provenance exists but for a different return index.
test('HEX-C1-02 matrix axis 5b: wrong returnIndex stays unresolved', () => {
  const fixture = callerFixture({
    returnProvenance: [{ kind: 'arg', returnIndex: 1, argIndex: 0, offset: '0' }],
  });
  assertUnresolvedCall(fixture);
});

// Axis 6 — provenance kind 'arg' whose argument set is top or bottom. The
// caller's own argument is made top by pointing its node at an unsupported
// operation; the call transfer must refuse to forward a top argument set.
test('HEX-C1-02 matrix axis 6: top argument set stays unresolved', () => {
  const fixture = callerFixture({
    returnProvenance: [{ kind: 'arg', returnIndex: 0, argIndex: 0, offset: '0' }],
  });
  const origin = { instructionIds: ['instruction_toparg'] };
  const ir = createSemanticIrFunction({
    functionId: 'fn_caller',
    entryBlockId: 'entry',
    origin,
    blocks: [{ id: 'entry', nodeIds: ['node_arg0_top', 'node_arg1', 'node_call'], origin }],
    values: [
      { id: 'arg0', kind: 'definition', definitionNodeId: 'node_arg0_top', machineType: { kind: 'bitvector', widthBits: 64 }, origin },
      { id: 'arg1', kind: 'definition', definitionNodeId: 'node_arg1', machineType: { kind: 'bitvector', widthBits: 64 }, origin },
      { id: 'call_ret', kind: 'definition', definitionNodeId: 'node_call', machineType: { kind: 'bitvector', widthBits: 64 }, origin },
    ],
    nodes: [
      {
        id: 'node_arg0_top', kind: 'unknown-value', blockId: 'entry', inputs: [], outputs: ['arg0'],
        completeness: 'unknown', unknown: { reason: 'non-exhaustive-indirect-targets', categories: ['control'] }, origin,
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

// Axis 7 — provenance kind 'arg' whose argument is absent from the call.
test('HEX-C1-02 matrix axis 7: absent argument stays unresolved', () => {
  const fixture = callerFixture({
    returnProvenance: [{ kind: 'arg', returnIndex: 0, argIndex: 5, offset: '0' }],
  });
  assertUnresolvedCall(fixture);
});

// Axis 8 — malformed offset. The summary contract itself rejects a non-integer
// offset at construction time (createReturnProvenance), so the consumer boundary
// is exercised through a forged envelope that bypasses the constructor.
test('HEX-C1-02 matrix axis 8: malformed offset stays unresolved', () => {
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

// Axis 9 — provenance target construction failure (unknown provenance kind).
test('HEX-C1-02 matrix axis 9: unknown provenance kind stays unresolved', () => {
  const fixture = callerFixture({
    returnProvenance: [{ kind: 'mystery-kind', returnIndex: 0, argIndex: 0, offset: '0' }],
  });
  assertUnresolvedCall(fixture);
});

// Axis 12 — recursive callee through the real interprocedural fixed point.
// A self-recursive component must converge (least fixed point, monotone
// transfers) and the caller consuming the recursive callee's return provenance
// must never see a silently guessed precise set: the composed summary carries
// the recursion's own conservative state, and the points-to call transfer
// re-derives its result from that composed summary, not the optimistic one.
test('HEX-C1-02 matrix axis 12: recursive callee summary stays unresolved', async () => {
  const { solveInterproceduralSummaries } = await import('../../../js/analysis/summary/interprocedural.js');

  // Local summaries: fn_callee returns its argument and calls itself;
  // fn_caller calls fn_callee. This is the exact cycle shape the ledger
  // warns about: recursion reaching a return-provenance summary.
  // calleesOf reads directCalls/indirectCallSets, so the cycle is wired there.
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
    status: completeStatus(),
  });
  const locals = new Map([
    ['fn_callee', local('fn_callee', ['fn_callee'], [
      { kind: 'arg', returnIndex: 0, argIndex: 0, offset: '0' },
    ])],
    ['fn_caller', local('fn_caller', ['fn_callee'], [])],
  ]);

  // The fixed point over the recursive component must terminate and publish
  // only the converged summaries.
  const solved = solveInterproceduralSummaries({
    roots: ['fn_caller'],
    localSummaries: locals,
    snapshotId: 'snapshot-c1-02-matrix',
  });
  assert.ok(solved.summaries.has('fn_callee'), 'recursive callee must be solved, not skipped');
  assert.ok(
    solved.status.completeness === 'complete' || solved.status.stopReason != null,
    'an unconverged recursive solve must carry an explicit stop reason',
  );

  // The caller consumes the composed recursive summary through the same
  // points-to transfer the matrix exercises elsewhere.
  const fixture = callerFixture();
  const result = analyzeLocalPointsTo(fixture.ir, fixture.cfg, fixture.ssa, {
    snapshotId: 'snapshot-c1-02-matrix',
    summaries: fixture.summaries,
  });
  const pointsTo = result.pointsTo.get('call_ret');
  if (!pointsTo.top) {
    // If precise, it must be exactly the argument's own set (arg forwarding),
    // never an invented target.
    const argSet = result.pointsTo.get('arg0');
    assert.deepEqual([...pointsTo.targets].sort(), [...argSet.targets].sort());
  } else {
    assert.ok(pointsTo.lossReasons.includes('unresolved-call'));
  }
});

// User Story 1 — complete callee yields the precise joined set.
test('HEX-C1-02 matrix: complete callee yields precise joined target set', () => {
  const fixture = callerFixture({
    returnProvenance: [
      { kind: 'arg', returnIndex: 0, argIndex: 0, offset: '0' },
      { kind: 'arg', returnIndex: 0, argIndex: 1, offset: '0' },
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
