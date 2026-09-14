import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createPhase7ArtifactDescriptor,
  dependencyClassFor,
} from '../../../js/analysis/artifact-identity.js';
import { analyzeLocalPointsTo } from '../../../js/analysis/pointsto/local.js';
import {
  createFunctionSummary,
  functionSummaryDigest,
  summaryIdentityMatches,
} from '../../../js/analysis/summary/contract.js';
import { createSemanticCfg } from '../../../js/semantics/cfg/index.js';
import { createSemanticIrFunction } from '../../../js/semantics/ir/function.js';
import { buildSemanticSsa } from '../../../js/semantics/ssa/build.js';

// Issue #6243: `phase7.pointsto.local` did not key callee summary identity, so a
// caller's A2 artifact kept the same artifactId even after the callee's
// `returnProvenance` changed — while the semantic points-to result itself
// changed with the summary. FM-15 dependency completeness violation.

const base = (overrides = {}) => ({
  kind: 'phase7.pointsto.local',
  binaryId: 'binary_1',
  functionId: 'function_caller',
  architectureId: 'arm64',
  snapshotId: 'snapshot_1',
  analyzerId: 'phase7.pointsto.a2-local',
  analyzerVersion: '1.0.0',
  semanticSchemaVersion: '2',
  cfgVersion: '2.0.0',
  ssaVersion: '2.0.0',
  memorySsaVersion: '2.0.0',
  architectureSemanticVersion: '1',
  abiSemanticVersion: '1',
  // #5751: every completeness-affecting artifact binds its budget generation.
  budgetClass: 'exhaustive',
  ...overrides,
});

test('issue-6243: phase7.pointsto.local declares the calleeSummaries dependency class', () => {
  assert.ok(
    dependencyClassFor('phase7.pointsto.local').includes('calleeSummaries'),
    'A2 call transfer consumes FunctionSummary.returnProvenance, so the artifact must key callee summary identity',
  );
});

test('issue-6243: a changed callee summary id changes the artifact id', () => {
  const withCallee = (ids) => createPhase7ArtifactDescriptor(base({ calleeSummaryIds: ids })).artifactId;
  assert.notEqual(withCallee(['B@summary-v1']), withCallee(['B@summary-v2']),
    'a changed callee summary must invalidate the caller points-to artifact (FM-15)');
});

test('issue-6243: callee summary id order is not semantic', () => {
  const withCallee = (ids) => createPhase7ArtifactDescriptor(base({ calleeSummaryIds: ids })).artifactId;
  assert.equal(withCallee(['B@1', 'C@1']), withCallee(['C@1', 'B@1']),
    'the same callee summary set must produce one identity regardless of order');
});

test('issue-6243: calleeSummaryIds are required to be valid non-empty ids when the class is declared', () => {
  assert.throws(
    () => createPhase7ArtifactDescriptor(base({ calleeSummaryIds: ['B@1', '   '] })),
    /phase7-artifact-invalid-callee-summary-id/,
  );
});

const origin = (id) => ({ instructionIds: [`instruction_${id}`] });

function completeStatus() {
  return {
    snapshotId: 'snapshot_1',
    analyzerId: 'callee-summary',
    analyzerVersion: '1.0.0',
    completeness: 'complete',
  };
}

function calleeSummary(returnProvenance, functionId = 'fn_callee') {
  return createFunctionSummary({
    functionId,
    returnValues: ['ret'],
    returnProvenance,
    noreturn: false,
    mayThrow: false,
    status: completeStatus(),
  });
}

function callerFixture(returnProvenance) {
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
        summarySource: 'issue-6243-fixture',
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
  return { ir, cfg, ssa, summary: calleeSummary(returnProvenance) };
}

const runCaller = (fixture, summary = fixture.summary) => {
  const result = analyzeLocalPointsTo(fixture.ir, fixture.cfg, fixture.ssa, {
    snapshotId: 'snapshot_1',
    summaries: new Map([['fn_callee', summary]]),
  });
  return result.pointsTo.get('call_ret');
};

test('issue-6243: a changed returnProvenance root changes the caller points-to result', () => {
  // The semantic producer really does depend on the summary: v1 and v2 differ
  // only in the callee's return provenance root.
  const v1 = callerFixture([{ kind: 'root', returnIndex: 0, rootEntityId: 'global-A', offset: '0', addressSpace: 'memory' }]);
  const v2 = callerFixture([{ kind: 'root', returnIndex: 0, rootEntityId: 'global-B', offset: '0', addressSpace: 'memory' }]);
  const p1 = runCaller(v1);
  const p2 = runCaller(v2);
  assert.equal(p1.top, false);
  assert.equal(p2.top, false);
  assert.notDeepEqual(
    p1.targets.map((target) => target.rootEntityId).sort(),
    p2.targets.map((target) => target.rootEntityId).sort(),
    'the callee summary is a real semantic input, not just key material',
  );
  // ...and therefore the two runs must not share one artifact identity.
  const artifactIdFor = (rootEntityId) => createPhase7ArtifactDescriptor(base({
    calleeSummaryIds: [`fn_callee@${rootEntityId}`],
  })).artifactId;
  assert.notEqual(artifactIdFor('global-A'), artifactIdFor('global-B'),
    'stale points-to must not be reusable as current after a summary update');
});

test('issue-6243: a changed returnProvenance offset invalidates the artifact', () => {
  const v1 = callerFixture([{ kind: 'root', returnIndex: 0, rootEntityId: 'global-A', offset: '0', addressSpace: 'memory' }]);
  const v2 = callerFixture([{ kind: 'root', returnIndex: 0, rootEntityId: 'global-A', offset: '8', addressSpace: 'memory' }]);
  const p1 = runCaller(v1);
  const p2 = runCaller(v2);
  assert.equal(p1.top, false);
  assert.equal(p2.top, false);
  assert.notEqual(p1.targets[0].offsetRange.min, p2.targets[0].offsetRange.min,
    'the offset is part of the semantic answer');
  assert.notEqual(
    createPhase7ArtifactDescriptor(base({ calleeSummaryIds: ['fn_callee@v1'] })).artifactId,
    createPhase7ArtifactDescriptor(base({ calleeSummaryIds: ['fn_callee@v2'] })).artifactId,
    'an offset-only summary change must still invalidate the artifact',
  );
});

test('issue-6243: arg-return provenance changes invalidate the artifact', () => {
  const v1 = callerFixture([{ kind: 'arg', returnIndex: 0, argIndex: 0, offset: '0' }]);
  const v2 = callerFixture([{ kind: 'arg', returnIndex: 0, argIndex: 0, offset: '16' }]);
  const p1 = runCaller(v1);
  const p2 = runCaller(v2);
  assert.equal(p1.top, false);
  assert.equal(p2.top, false);
  assert.notEqual(p1.targets[0].offsetRange.min, p2.targets[0].offsetRange.min,
    'arg-provenance offset shifts the caller argument root');
  assert.notEqual(
    createPhase7ArtifactDescriptor(base({ calleeSummaryIds: ['fn_callee@v1'] })).artifactId,
    createPhase7ArtifactDescriptor(base({ calleeSummaryIds: ['fn_callee@v2'] })).artifactId,
  );
});

test('issue-6243: an accepted but unhashable callee summary fail-closes to unresolved-call', () => {
  const fixture = callerFixture([{ kind: 'root', returnIndex: 0, rootEntityId: 'global-A', offset: '0', addressSpace: 'memory' }]);
  const cyclicFact = {};
  cyclicFact.self = cyclicFact;
  const accepted = createFunctionSummary({
    functionId: 'fn_callee',
    returnValues: ['ret'],
    returnProvenance: [{ kind: 'root', returnIndex: 0, rootEntityId: 'global-A', offset: '0', addressSpace: 'memory' }],
    noreturn: false,
    mayThrow: false,
    semanticFacts: [cyclicFact],
    status: completeStatus(),
  });
  assert.equal(
    summaryIdentityMatches(accepted, { functionId: 'fn_callee', snapshotId: 'snapshot_1' }),
    true,
    'the summary is accepted by the consumer identity gate before digesting',
  );
  assert.throws(() => functionSummaryDigest(accepted), /identity-cyclic-value/);
  const result = analyzeLocalPointsTo(fixture.ir, fixture.cfg, fixture.ssa, {
    snapshotId: 'snapshot_1',
    summaries: new Map([['fn_callee', accepted]]),
  });
  const pointsTo = result.pointsTo.get('call_ret');
  assert.equal(pointsTo.top, true);
  assert.ok(pointsTo.lossReasons.includes('unresolved-call'),
    'digest failure must not permit provenance transfer under a reused or fabricated identity');
  assert.equal(result.status.completeness, 'unsupported');
  assert.equal(result.status.stopReason, 'dependency-mismatch');
});

test('issue-6243: an incomplete callee summary still fail-closes to unresolved-call', () => {
  const fixture = callerFixture([{ kind: 'root', returnIndex: 0, rootEntityId: 'global-A', offset: '0', addressSpace: 'memory' }]);
  const stale = createFunctionSummary({
    functionId: 'fn_callee',
    returnValues: ['ret'],
    returnProvenance: [{ kind: 'root', returnIndex: 0, rootEntityId: 'global-A', offset: '0', addressSpace: 'memory' }],
    noreturn: false,
    mayThrow: false,
    status: { ...completeStatus(), completeness: 'partial', stopReason: 'budget-exhausted' },
  });
  const pointsTo = runCaller(fixture, stale);
  assert.equal(pointsTo.top, true);
  assert.ok(pointsTo.lossReasons.includes('unresolved-call'),
    'a stale/incomplete summary must never publish provenance-derived points-to');
});

test('issue-6243: a summary for another callee cannot leave the caller complete', () => {
  const fixture = callerFixture([{ kind: 'root', returnIndex: 0, rootEntityId: 'global-A', offset: '0', addressSpace: 'memory' }]);
  const mismatched = createFunctionSummary({
    functionId: 'fn_other',
    returnValues: ['ret'],
    returnProvenance: [{ kind: 'root', returnIndex: 0, rootEntityId: 'global-A', offset: '0', addressSpace: 'memory' }],
    noreturn: false,
    mayThrow: false,
    status: completeStatus(),
  });
  const result = analyzeLocalPointsTo(fixture.ir, fixture.cfg, fixture.ssa, {
    snapshotId: 'snapshot_1',
    summaries: new Map([['fn_callee', mismatched]]),
  });
  const pointsTo = result.pointsTo.get('call_ret');
  assert.equal(pointsTo.top, true);
  assert.ok(pointsTo.lossReasons.includes('unresolved-call'));
  assert.equal(result.status.completeness, 'unsupported');
  assert.equal(result.status.stopReason, 'dependency-mismatch');
});

const runDetailed = (
  fixture,
  summary = fixture.summary,
  provider = false,
  withArtifact = false,
  summaryArtifactIds = null,
) => analyzeLocalPointsTo(
  fixture.ir, fixture.cfg, fixture.ssa, {
    snapshotId: 'snapshot_1',
    ...(withArtifact ? { artifactIdentity: base() } : {}),
    ...(summaryArtifactIds == null ? {} : { summaryArtifactIds }),
    ...(provider
      ? { summaryProvider: () => summary }
      : { summaries: new Map([['fn_callee', summary]]) }),
  },
);

test('issue-6243: A2 exposes the summary identities it actually consumed', () => {
  const fixture = callerFixture([{ kind: 'root', returnIndex: 0, rootEntityId: 'global-provider', offset: '4', addressSpace: 'memory' }]);
  const result = runDetailed(fixture, fixture.summary, true);
  assert.deepEqual(result.calleeSummaryIds, ['summary:' + functionSummaryDigest(fixture.summary)]);
  assert.equal(result.pointsTo.get('call_ret').top, false);
});

test('issue-6243: external summary labels remain additional to the canonical digest', () => {
  const fixture = callerFixture([{ kind: 'root', returnIndex: 0, rootEntityId: 'global-provider', offset: '4', addressSpace: 'memory' }]);
  const result = runDetailed(fixture, fixture.summary, false, false, new Map([['fn_callee', 'callee-artifact-v1']]));
  assert.deepEqual(result.calleeSummaryIds, [
    'callee-artifact-v1',
    'summary:' + functionSummaryDigest(fixture.summary),
  ].sort());
});

test('issue-6243: the production A2 path builds its descriptor from consumed identities', () => {
  const fixture = callerFixture([{ kind: 'root', returnIndex: 0, rootEntityId: 'global-provider', offset: '4', addressSpace: 'memory' }]);
  const result = runDetailed(fixture, fixture.summary, true, true);
  const expected = createPhase7ArtifactDescriptor(base({
    calleeSummaryIds: result.calleeSummaryIds,
  })).artifactId;
  assert.equal(result.artifactDescriptor?.artifactId, expected);
  assert.deepEqual(result.calleeSummaryIds, ['summary:' + functionSummaryDigest(fixture.summary)]);
});

test('issue-6243: a reused explicit summary id cannot hide semantic changes', () => {
  const first = callerFixture([{ kind: 'root', returnIndex: 0, rootEntityId: 'global-A', offset: '0', addressSpace: 'memory' }]);
  const second = callerFixture([{ kind: 'root', returnIndex: 0, rootEntityId: 'global-B', offset: '0', addressSpace: 'memory' }]);
  const reused = new Map([['fn_callee', 'reused-summary-id']]);
  const firstRun = runDetailed(first, first.summary, false, true, reused);
  const secondRun = runDetailed(second, second.summary, false, true, reused);
  assert.notDeepEqual(firstRun.calleeSummaryIds, secondRun.calleeSummaryIds);
  assert.notEqual(firstRun.artifactDescriptor?.artifactId, secondRun.artifactDescriptor?.artifactId);
});

test('issue-6243: descriptors can be built from observed identities across root changes', () => {
  const first = runDetailed(callerFixture([{ kind: 'root', returnIndex: 0, rootEntityId: 'global-A', offset: '0', addressSpace: 'memory' }]));
  const second = runDetailed(callerFixture([{ kind: 'root', returnIndex: 0, rootEntityId: 'global-B', offset: '0', addressSpace: 'memory' }]));
  const firstId = createPhase7ArtifactDescriptor(base({ calleeSummaryIds: first.calleeSummaryIds })).artifactId;
  const secondId = createPhase7ArtifactDescriptor(base({ calleeSummaryIds: second.calleeSummaryIds })).artifactId;
  assert.notEqual(firstId, secondId);
});
