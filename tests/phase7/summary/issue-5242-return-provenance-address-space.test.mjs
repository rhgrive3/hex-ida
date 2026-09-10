import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createFunctionSummary,
  functionSummaryDigest,
  summaryIdentityMatches,
} from '../../../js/analysis/summary/contract.js';
import { buildLocalFunctionSummary } from '../../../js/analysis/summary/local.js';
import { analyzeLocalPointsTo } from '../../../js/analysis/pointsto/local.js';
import { createSemanticCfg } from '../../../js/semantics/cfg/index.js';
import { createSemanticIrFunction } from '../../../js/semantics/ir/function.js';
import { buildSemanticSsa } from '../../../js/semantics/ssa/build.js';

// Issue #5242: the canonical FunctionSummary return provenance dropped the
// storage identity a points-to consumer needs. A root/allocation fact without
// `addressSpace` silently became an ordinary flat-memory target at the caller,
// so an io/tls-rooted return could never survive the summary boundary. The
// canonical schema now carries `addressSpace` on root/allocation facts
// (required, fail-closed) and the A2 consumer builds the target from it
// instead of defaulting to `memory`.

const status = (snapshotId = 'snapshot-5242') => ({
  snapshotId,
  analyzerId: 'summary-5242',
  analyzerVersion: '1',
  completeness: 'complete',
  stopReason: null,
});

const origin = (id) => ({ instructionIds: [`instruction_${id}`] });

function summaryInput(returnProvenance) {
  return {
    functionId: 'fn_callee',
    inputs: [],
    returnValues: ['ret0'],
    returnProvenance,
    noreturn: false,
    mayThrow: false,
    status: status(),
  };
}

test('#5242 root/allocation provenance keeps its address space through the canonical round-trip', () => {
  const summary = createFunctionSummary(summaryInput([
    { kind: 'root', returnIndex: 0, rootEntityId: 'io-root', offset: '0', addressSpace: 'io' },
  ]));
  assert.equal(summary.returnProvenance.length, 1);
  assert.equal(summary.returnProvenance[0].addressSpace, 'io');
  assert.equal(summaryIdentityMatches(summary, { functionId: 'fn_callee', snapshotId: 'snapshot-5242' }), true);
});

test('#5242 a space-less root/allocation fact is rejected instead of becoming memory', () => {
  assert.throws(
    () => createFunctionSummary(summaryInput([{ kind: 'root', rootEntityId: 'r', offset: '0' }])),
    /function-summary-invalid-return-provenance-address-space/,
  );
  assert.throws(
    () => createFunctionSummary(summaryInput([{ kind: 'allocation', allocationSiteId: 'a', offset: '0' }])),
    /function-summary-invalid-return-provenance-address-space/,
  );
  // A serialized lookalike fails the identity gate: a space-less root cannot
  // be distinguished from flat memory, so it is not current evidence.
  const serialized = summaryInput([{ kind: 'root', rootEntityId: 'r', offset: '0', addressSpace: 'memory' }]);
  const forged = structuredClone(serialized);
  delete forged.returnProvenance[0].addressSpace;
  assert.equal(summaryIdentityMatches(forged, { functionId: 'fn_callee', snapshotId: 'snapshot-5242' }), false);
});

test('#5242 address space participates in dedupe and digest identity', () => {
  const io = createFunctionSummary(summaryInput([
    { kind: 'root', returnIndex: 0, rootEntityId: 'shared-root', offset: '0', addressSpace: 'io' },
  ]));
  const memory = createFunctionSummary(summaryInput([
    { kind: 'root', returnIndex: 0, rootEntityId: 'shared-root', offset: '0', addressSpace: 'memory' },
  ]));
  assert.equal(io.returnProvenance.length, 1);
  assert.notEqual(functionSummaryDigest(io), functionSummaryDigest(memory),
    'a memory-rooted and an io-rooted return with the same root id are different facts');
  const joined = createFunctionSummary(summaryInput([
    { kind: 'root', returnIndex: 0, rootEntityId: 'shared-root', offset: '0', addressSpace: 'io' },
    { kind: 'root', returnIndex: 0, rootEntityId: 'shared-root', offset: '0', addressSpace: 'memory' },
  ]));
  assert.equal(joined.returnProvenance.length, 2,
    'dedupe must keep both storage spaces as distinct alternatives');
});

function callerFixture(calleeSummaryObject) {
  const call = {
    targetEntityIds: ['fn_callee'], targetValueIds: [], arguments: [], returns: ['ret0'],
    stateReads: [], stateWrites: [], controlEffects: [],
    memoryRead: { scope: 'none' }, memoryWrite: { scope: 'none' },
    summarySource: 'fixture', completeness: 'complete', determinism: 'deterministic',
    noreturn: false, mayThrow: false,
  };
  const nodes = [
    { id: 'call_node', kind: 'call', blockId: 'entry', inputs: [], outputs: ['ret0'], call, origin: origin('call') },
    { id: 'ret_node', kind: 'return', blockId: 'entry', inputs: ['ret0'], outputs: [], origin: origin('ret') },
  ];
  const ir = createSemanticIrFunction({
    functionId: 'fn_caller', entryBlockId: 'entry', origin: origin('function'),
    blocks: [{ id: 'entry', nodeIds: nodes.map((n) => n.id), origin: origin('block') }], nodes,
    values: ['ret0'].map((id) => ({ id, kind: 'definition', definitionNodeId: 'call_node',
      machineType: { kind: 'bitvector', widthBits: 64 }, origin: origin(id) })),
  });
  const cfg = createSemanticCfg({ functionId: 'fn_caller', entryBlockId: 'entry', blocks: [{ id: 'entry', successors: [] }] });
  const ssa = buildSemanticSsa(ir, cfg);
  return { ir, cfg, ssa, calleeSummaryObject };
}

test('#5242 call composition preserves the callee storage space across the summary boundary', () => {
  const ioCallee = createFunctionSummary({
    ...summaryInput([{ kind: 'root', returnIndex: 0, rootEntityId: 'io-root', offset: '8', addressSpace: 'io' }]),
    status: { ...status(), analyzerId: 'local-5242', analyzerVersion: '1' },
  });
  const fixture = callerFixture(ioCallee);
  const callerSummary = buildLocalFunctionSummary(fixture.ir, fixture.cfg, fixture.ssa, null, {
    snapshotId: 'snapshot-5242',
    calleeSummaries: new Map([['fn_callee', ioCallee]]),
  }).summary;
  assert.equal(callerSummary.returnProvenance.length, 1);
  assert.equal(callerSummary.returnProvenance[0].kind, 'root');
  assert.equal(callerSummary.returnProvenance[0].addressSpace, 'io',
    'the composed fact keeps the callee storage space');
});

test('#5242 A2 builds the call-return target in the callee storage space, not memory', () => {
  const ioCallee = createFunctionSummary({
    ...summaryInput([{ kind: 'root', returnIndex: 0, rootEntityId: 'io-root', offset: '8', addressSpace: 'io' }]),
    status: { ...status(), analyzerId: 'local-5242', analyzerVersion: '1' },
  });
  const fixture = callerFixture(ioCallee);
  const result = analyzeLocalPointsTo(fixture.ir, fixture.cfg, fixture.ssa, {
    snapshotId: 'snapshot-5242',
    summaries: new Map([['fn_callee', ioCallee]]),
  });
  const ret0 = result.pointsTo.get('ret0');
  assert.equal(ret0.top, false);
  assert.equal(ret0.targets.length, 1);
  assert.equal(ret0.targets[0].addressSpace, 'io',
    'the caller target must match the callee storage semantics');
  assert.equal(ret0.targets[0].rootEntityId, 'io-root');
  assert.equal(ret0.targets[0].offsetRange.min, 8n);
});

test('#5242 a legacy space-less root fact composes to an explicit unknown, never a memory root', () => {
  const legacyCallee = {
    ...summaryInput([{ kind: 'root', returnIndex: 0, rootEntityId: 'r', offset: '0', addressSpace: 'memory' }]),
    returnProvenance: [{
      kind: 'root', returnIndex: 0, rootEntityId: 'r', offset: '0',
      argIndex: null,
    }],
    status: { ...status(), analyzerId: 'legacy-5242', analyzerVersion: '1' },
  };
  // The legacy shape is not current evidence (identity gate fails closed).
  assert.equal(summaryIdentityMatches(legacyCallee, { functionId: 'fn_callee', snapshotId: 'snapshot-5242' }), false);
  const fixture = callerFixture(legacyCallee);
  const callerSummary = buildLocalFunctionSummary(fixture.ir, fixture.cfg, fixture.ssa, null, {
    snapshotId: 'snapshot-5242',
    calleeSummaries: new Map([['fn_callee', legacyCallee]]),
  }).summary;
  // Without an identity-matched callee the caller stays conservative: no
  // fabricated memory-rooted fact may appear.
  assert.ok(!callerSummary.returnProvenance.some(
    (fact) => fact.kind === 'root' && (fact.addressSpace == null || fact.addressSpace === 'memory'),
  ) || callerSummary.status.completeness !== 'complete',
  'a legacy callee must not be laundered into a complete memory-rooted fact');
});

test('#5242 arg provenance keeps its legacy shape (address space stays optional there)', () => {
  const summary = createFunctionSummary(summaryInput([
    { kind: 'arg', returnIndex: 0, argIndex: 0, offset: '8' },
  ]));
  assert.equal(summary.returnProvenance[0].addressSpace, undefined);
  assert.equal(summaryIdentityMatches(summary, { functionId: 'fn_callee', snapshotId: 'snapshot-5242' }), true);
});
