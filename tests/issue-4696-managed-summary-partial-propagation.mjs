import assert from 'node:assert/strict';
import { createVMEffectBundle, createVMEffectFunction } from '../js/managed/shared/vm-effects.js';
import { lowerVMEffectsToSemanticIr, buildManagedMethodSummary } from '../js/managed/shared/bridge-v2.js';

const broadEffects = (effects) => effects.filter((effect) => effect.broad === true);

{
  const methodId = 'managed-method:test';
  const bundle = createVMEffectBundle({
    frontendId: 'jvm',
    methodId,
    operationId: 'vm-op:test:0',
    bytecodeOffset: 0,
    mnemonic: 'unsupported-op',
    completeness: 'unknown',
    unknownEffects: [{ category: 'memory', reason: 'unsupported-opcode' }],
  });
  const fn = createVMEffectFunction({ frontendId: 'jvm', methodId, bundles: [bundle] });
  const lowered = lowerVMEffectsToSemanticIr(fn);
  assert.equal(lowered.semanticIr.completeness, 'partial', 'the canonical lowering must mark the function partial');
  const barrier = lowered.semanticIr.nodes.find((node) => node.kind === 'barrier');
  assert.ok(barrier, 'the unsupported opcode must lower to a barrier node');

  const result = buildManagedMethodSummary(fn);
  assert.equal(result.completeness, 'partial', '#4696 an unknown non-call effect must not mint a complete bridge report');
  assert.equal(result.summary.status.completeness, 'partial', '#4696 the summary status must inherit the partial lowering');
  assert.equal(result.summary.status.stopReason, 'evidence-missing', '#4696 the partial status must keep its stop reason');
  assert.equal(broadEffects(result.summary.memoryWriteRegions).length, 1,
    '#4696 the unknown memory effect must survive as a broad write region in the summary contract');
  assert.equal(broadEffects(result.summary.memoryReadRegions).length, 1,
    '#4696 the unknown memory effect must survive as a broad read region in the summary contract');
  const write = broadEffects(result.summary.memoryWriteRegions)[0];
  const read = broadEffects(result.summary.memoryReadRegions)[0];
  assert.deepEqual([...write.evidenceIds], [barrier.id], 'the broad write must cite the barrier evidence');
  assert.deepEqual([...read.evidenceIds], [barrier.id], 'the broad read must cite the barrier evidence');
  assert.equal(write.source, 'unknown-call-fallback', 'unknown-effect fallback regions are not proven-summary claims');
  assert.equal(read.source, 'unknown-call-fallback', 'unknown-effect fallback regions are not proven-summary claims');
}

{
  const result = buildManagedMethodSummary({
    methodId: 'managed-method:function-level-unknown',
    semanticIr: {
      nodes: [{ id: 'node_1', kind: 'barrier', completeness: 'partial', unknown: { reason: 'partial-vm-effect', categories: ['other'] } }],
      values: [],
      completeness: 'partial',
      unknowns: [{ reason: 'unsupported-vm-region', categories: ['memory'] }],
    },
    cfg: { blocks: [] },
  });
  assert.equal(result.completeness, 'partial', 'function-level unknowns keep the bridge report partial');
  assert.equal(broadEffects(result.summary.memoryWriteRegions).length, 1,
    '#4696 semanticIr.unknowns memory categories must contribute a broad write region');
  assert.equal(broadEffects(result.summary.memoryReadRegions).length, 1,
    '#4696 semanticIr.unknowns memory categories must contribute a broad read region');
}

{
  const result = buildManagedMethodSummary({
    methodId: 'managed-method:unknown-calls',
    semanticIr: {
      nodes: [{ id: 'barrier_1', kind: 'barrier', completeness: 'unknown', unknown: { reason: 'vm-call-unmodeled', categories: ['calls'] } }],
      values: [],
      completeness: 'partial',
      unknowns: [{ reason: 'vm-call-unmodeled', categories: ['calls'] }],
    },
    cfg: { blocks: [] },
  });
  assert.equal(result.completeness, 'partial', 'unknown call effects keep the bridge report partial');
  assert.equal(result.summary.unknownCallEffects.length, 1,
    '#4696 a non-call node carrying unknown call categories must publish an unknown call effect');
  assert.equal(result.summary.unknownCallEffects[0].callSiteId, 'barrier_1', 'the unknown call effect cites its carrier node');
  assert.equal(result.summary.unknownCallEffects[0].reason, 'summary-incomplete', 'the unknown call effect keeps a canonical reason');
  assert.equal(broadEffects(result.summary.memoryWriteRegions).length, 1,
    'the unknown call effect must contribute its broad fallback write');
}

{
  const complete = buildManagedMethodSummary({
    methodId: 'managed-method:known-complete',
    semanticIr: {
      nodes: [
        { id: 'load_1', kind: 'load', completeness: 'complete', memory: { addressSpace: 'memory' } },
        { id: 'store_1', kind: 'store', completeness: 'complete', memory: { addressSpace: 'memory' } },
        {
          id: 'call_1',
          kind: 'call',
          completeness: 'complete',
          call: { targetEntityIds: ['callee'], completeness: 'complete' },
          metadata: { dispatchKind: 'direct', targetUnresolved: false },
        },
      ],
      values: [],
      completeness: 'complete',
      unknowns: [],
    },
    cfg: { blocks: [] },
  });
  assert.equal(complete.completeness, 'complete', '#4696 a fully known load/store/direct-call method stays complete');
  assert.equal(complete.summary.status.completeness, 'complete', 'the summary status stays complete for fully known input');
  assert.equal(complete.summary.status.stopReason, null, 'a complete status carries no stop reason');
  assert.equal(complete.summary.unknownCallEffects.length, 0, 'known effects must not be laundered into unknown effects');
  assert.equal(complete.summary.memoryReadRegions.length, 1, 'complete input must not gain spurious broad regions');
  assert.equal(complete.summary.memoryWriteRegions.length, 1, 'complete input must not gain spurious broad write regions');
}

{
  const control = buildManagedMethodSummary({
    methodId: 'managed-method:unknown-control',
    semanticIr: {
      nodes: [{ id: 'ctrl_1', kind: 'barrier', completeness: 'partial', unknown: { reason: 'unresolved-control-effect', categories: ['control'] } }],
      values: [],
      completeness: 'partial',
      unknowns: [{ reason: 'unresolved-control-effect', categories: ['control'] }],
    },
    cfg: { blocks: [] },
  });
  assert.equal(control.completeness, 'partial', 'unknown control effects keep the bridge report partial');
  assert.equal(control.summary.status.completeness, 'partial', 'unknown control effects keep the summary status partial');
}

console.log('issue #4696 managed bridge partial/unknown summary propagation: PASS');
