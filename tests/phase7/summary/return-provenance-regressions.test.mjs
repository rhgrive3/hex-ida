import assert from 'node:assert/strict';
import test from 'node:test';

import { analyzeLocalPointsTo } from '../../../js/analysis/pointsto/local.js';
import {
  classifyCallTargetProof,
  createFunctionSummary,
  functionSummaryDigest,
} from '../../../js/analysis/summary/contract.js';
import { solveInterproceduralSummaries } from '../../../js/analysis/summary/interprocedural.js';
import { buildLocalFunctionSummary } from '../../../js/analysis/summary/local.js';
import { createSemanticCfg } from '../../../js/semantics/cfg/index.js';
import { createSemanticIrFunction } from '../../../js/semantics/ir/function.js';
import { buildSemanticSsa } from '../../../js/semantics/ssa/build.js';

const origin = (id) => ({ instructionIds: [`instruction_${id}`] });

function completeStatus(analyzerId = 'summary-regression') {
  return {
    snapshotId: 'snapshot-240x',
    analyzerId,
    analyzerVersion: '1.0.0',
    completeness: 'complete',
  };
}

function calleeSummary(returnProvenance) {
  return createFunctionSummary({
    functionId: 'fn_callee',
    returnValues: ['ret'],
    returnProvenance,
    noreturn: false,
    mayThrow: false,
    status: completeStatus('callee-summary'),
  });
}

function callerFixture({ returnProvenance, indirectPartial = false } = {}) {
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
  ];

  if (indirectPartial) {
    values.push({ id: 'target', kind: 'definition', definitionNodeId: 'node_target', machineType: { kind: 'bitvector', widthBits: 64 }, origin: origin('target') });
    nodes.push({
      id: 'node_target', kind: 'state-read', blockId: 'entry', inputs: [], outputs: ['target'],
      variable: { key: 'state:x16', kind: 'physical-state', scope: 'function' }, origin: origin('node_target'),
    });
  }

  nodes.push({
    id: 'node_call',
    kind: 'call',
    blockId: 'entry',
    inputs: ['arg0', 'arg1'],
    outputs: ['call_ret'],
    call: {
      targetValueIds: indirectPartial ? ['target'] : [],
      targetEntityIds: ['fn_callee'],
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
      summarySource: 'regression-fixture',
      completeness: indirectPartial ? 'partial' : 'complete',
      ...(indirectPartial ? {
        unknownEffects: { reason: 'non-exhaustive-indirect-targets', categories: ['control'] },
      } : {}),
    },
    ...(indirectPartial ? {
      completeness: 'partial',
      unknown: { reason: 'non-exhaustive-indirect-targets', categories: ['control'] },
    } : {}),
    origin: origin('node_call'),
  });

  const ir = createSemanticIrFunction({
    functionId: 'fn_caller',
    entryBlockId: 'entry',
    origin: origin('fn_caller'),
    blocks: [{ id: 'entry', nodeIds: nodes.map((node) => node.id), origin: origin('entry') }],
    values,
    nodes,
    completeness: indirectPartial ? 'partial' : 'complete',
    unknowns: indirectPartial
      ? [{ reason: 'non-exhaustive-indirect-targets', categories: ['control'] }]
      : [],
  });
  const cfg = createSemanticCfg({
    functionId: 'fn_caller',
    entryBlockId: 'entry',
    blocks: [{ id: 'entry', successors: [] }],
  });
  const ssa = buildSemanticSsa(ir, cfg);
  return { ir, cfg, ssa, summary: calleeSummary(returnProvenance) };
}

test('Issue #2402: a non-exhaustive indirect singleton is not an exact target proof', () => {
  const proof = classifyCallTargetProof({
    targetValueIds: ['target-value'],
    targetEntityIds: ['fn_callee'],
    completeness: 'partial',
  });
  assert.equal(proof.kind, 'indirect');
  assert.equal(proof.exhaustive, false);
  assert.equal(proof.exactSingletonEntityId, null);

  const completeIndirect = classifyCallTargetProof({
    targetValueIds: ['target-value'],
    targetEntityIds: ['fn_callee'],
    completeness: 'complete',
  });
  assert.equal(completeIndirect.exhaustive, true);
  assert.equal(completeIndirect.exactSingletonEntityId, 'fn_callee');
});

test('Issue #2402: points-to keeps a partial indirect singleton unresolved', () => {
  const fixture = callerFixture({
    returnProvenance: [{ kind: 'arg', returnIndex: 0, argIndex: 0, offset: '16' }],
    indirectPartial: true,
  });
  const result = analyzeLocalPointsTo(fixture.ir, fixture.cfg, fixture.ssa, {
    snapshotId: 'snapshot-240x',
    summaries: new Map([['fn_callee', fixture.summary]]),
  });
  const pointsTo = result.pointsTo.get('call_ret');
  assert.ok(pointsTo);
  assert.equal(pointsTo.top, true);
  assert.ok(pointsTo.lossReasons.includes('unresolved-call'));
});

test('Issue #2402: local summary retains unknown effect for a partial indirect singleton', () => {
  const fixture = callerFixture({
    returnProvenance: [{ kind: 'arg', returnIndex: 0, argIndex: 0, offset: '0' }],
    indirectPartial: true,
  });
  const { summary } = buildLocalFunctionSummary(fixture.ir, fixture.cfg, fixture.ssa, null, {
    snapshotId: 'snapshot-240x',
    calleeSummaries: new Map([['fn_callee', fixture.summary]]),
  });
  assert.equal(summary.status.completeness, 'partial');
  assert.equal(summary.directCalls.length, 0);
  assert.equal(summary.indirectCallSets.length, 1);
  assert.deepEqual(summary.indirectCallSets[0].candidateEntityIds, ['fn_callee']);
  assert.equal(summary.indirectCallSets[0].exhaustive, false);
  assert.ok(summary.unknownCallEffects.some((effect) => effect.reason === 'indirect-incomplete-target-set'));
  assert.ok(summary.memoryWriteRegions.some((effect) => effect.broad));
});

test('Issue #2403: all return provenance roots are joined instead of taking the first', () => {
  const fixture = callerFixture({
    returnProvenance: [
      { kind: 'arg', returnIndex: 0, argIndex: 0, offset: '0' },
      { kind: 'arg', returnIndex: 0, argIndex: 1, offset: '0' },
    ],
  });
  const result = analyzeLocalPointsTo(fixture.ir, fixture.cfg, fixture.ssa, {
    snapshotId: 'snapshot-240x',
    summaries: new Map([['fn_callee', fixture.summary]]),
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

test('Issue #2403: same-root return alternatives join their offset range', () => {
  const fixture = callerFixture({
    returnProvenance: [
      { kind: 'arg', returnIndex: 0, argIndex: 0, offset: '16' },
      { kind: 'arg', returnIndex: 0, argIndex: 0, offset: '8' },
    ],
  });
  const result = analyzeLocalPointsTo(fixture.ir, fixture.cfg, fixture.ssa, {
    snapshotId: 'snapshot-240x',
    summaries: new Map([['fn_callee', fixture.summary]]),
  });
  const pointsTo = result.pointsTo.get('call_ret');
  assert.equal(pointsTo.top, false);
  assert.equal(pointsTo.targets.length, 1);
  assert.equal(pointsTo.targets[0].offsetRange.min, 8n);
  assert.equal(pointsTo.targets[0].offsetRange.max, 16n);
  assert.equal(pointsTo.targets[0].offsetRange.exact, false);
});

test('Issue #2403: one unknown return alternative makes call points-to conservative', () => {
  const fixture = callerFixture({
    returnProvenance: [
      { kind: 'arg', returnIndex: 0, argIndex: 0, offset: '0' },
      { kind: 'unknown', returnIndex: 0 },
    ],
  });
  const result = analyzeLocalPointsTo(fixture.ir, fixture.cfg, fixture.ssa, {
    snapshotId: 'snapshot-240x',
    summaries: new Map([['fn_callee', fixture.summary]]),
  });
  assert.equal(result.pointsTo.get('call_ret').top, true);
});

test('Issue #2404: every dependency-relevant FunctionSummary field affects the digest', () => {
  const make = (overrides = {}) => createFunctionSummary({
    functionId: 'fn_digest',
    inputs: ['in0'],
    returnValues: ['ret0'],
    returnProvenance: [{ kind: 'arg', returnIndex: 0, argIndex: 0, offset: '0' }],
    registerEffects: ['state:x1'],
    allocations: ['alloc0'],
    frees: ['free0'],
    semanticFacts: [{ kind: 'fact', value: 1 }],
    noreturn: false,
    mayThrow: false,
    status: completeStatus('digest-test'),
    ...overrides,
  });
  const base = functionSummaryDigest(make());
  const variants = [
    make({ inputs: ['in1'] }),
    make({ returnValues: ['ret1'] }),
    make({ returnProvenance: [{ kind: 'arg', returnIndex: 0, argIndex: 0, offset: '8' }] }),
    make({ registerEffects: ['state:x2'] }),
    make({ allocations: ['alloc1'] }),
    make({ frees: ['free1'] }),
    make({ semanticFacts: [{ kind: 'fact', value: 2 }] }),
  ];
  for (const variant of variants) assert.notEqual(functionSummaryDigest(variant), base);
});

test('Issue #2404: return provenance ordering is canonical and digest-stable', () => {
  const left = createFunctionSummary({
    functionId: 'fn_order',
    returnValues: ['ret'],
    returnProvenance: [
      { kind: 'arg', returnIndex: 0, argIndex: 1, offset: '8' },
      { kind: 'arg', returnIndex: 0, argIndex: 0, offset: '0' },
    ],
    status: completeStatus('digest-order'),
  });
  const right = createFunctionSummary({
    functionId: 'fn_order',
    returnValues: ['ret'],
    returnProvenance: [
      { kind: 'arg', returnIndex: 0, argIndex: 0, offset: '0' },
      { kind: 'arg', returnIndex: 0, argIndex: 1, offset: '8' },
    ],
    status: completeStatus('digest-order'),
  });
  assert.deepEqual(left.returnProvenance, right.returnProvenance);
  assert.equal(functionSummaryDigest(left), functionSummaryDigest(right));
});

test('Issue #2406: interprocedural composition preserves converged return provenance', () => {
  const local = createFunctionSummary({
    functionId: 'fn_identity',
    returnValues: ['ret'],
    returnProvenance: [{ kind: 'arg', returnIndex: 0, argIndex: 0, offset: '24' }],
    noreturn: false,
    mayThrow: false,
    status: completeStatus('local-summary'),
  });
  const result = solveInterproceduralSummaries({
    roots: ['fn_identity'],
    localSummaries: new Map([['fn_identity', local]]),
    snapshotId: 'snapshot-240x',
  });
  const solved = result.summaries.get('fn_identity');
  assert.ok(solved);
  assert.deepEqual(solved.returnProvenance, local.returnProvenance);
});

test('Issue #2406: an unconverged recursive component does not publish exact return provenance', () => {
  const local = createFunctionSummary({
    functionId: 'fn_recursive',
    returnValues: ['ret'],
    returnProvenance: [{ kind: 'arg', returnIndex: 0, argIndex: 0, offset: '0' }],
    directCalls: [{
      callSiteId: 'call_self',
      targetEntityIds: ['fn_recursive'],
      summaryId: 'fn_recursive',
      effectSource: 'proven-summary',
    }],
    noreturn: false,
    mayThrow: false,
    status: completeStatus('recursive-local'),
  });
  const result = solveInterproceduralSummaries({
    roots: ['fn_recursive'],
    localSummaries: new Map([['fn_recursive', local]]),
    snapshotId: 'snapshot-240x',
    budget: { maxIterationsPerComponent: 1 },
  });
  const solved = result.summaries.get('fn_recursive');
  assert.ok(solved);
  assert.equal(solved.status.completeness, 'truncated');
  assert.deepEqual(solved.returnProvenance, []);
  assert.ok(solved.unknownCallEffects.some((effect) => effect.reason === 'recursion-unconverged'));
});
