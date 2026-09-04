import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyCallTargetProof } from '../../../js/analysis/summary/contract.js';
import { buildLocalFunctionSummary } from '../../../js/analysis/summary/local.js';

function callNode(call = {}) {
  return {
    id: 'call_0',
    kind: 'call',
    inputs: [],
    outputs: [],
    call: {
      targetValueIds: [],
      targetEntityIds: [],
      memoryRead: { scope: 'none' },
      memoryWrite: { scope: 'none' },
      completeness: 'complete',
      mayThrow: false,
      noreturn: false,
      ...call,
    },
    origin: { instructionIds: ['instruction_call_0'] },
  };
}

function summaryFor(call) {
  return buildLocalFunctionSummary(
    { functionId: 'fn_caller', values: [], nodes: [callNode(call)] },
    {},
    { definitions: [], uses: [] },
    {},
    { snapshotId: 'snapshot-3466' },
  ).summary;
}

test('non-exhaustive direct candidate sets retain an unknown-target boundary', () => {
  const call = {
    targetEntityIds: ['A', 'B'],
    completeness: 'complete',
  };
  const proof = classifyCallTargetProof(call);
  assert.equal(proof.kind, 'direct');
  assert.equal(proof.exhaustive, false);
  assert.equal(proof.exactSingletonEntityId, null);
  assert.deepEqual(proof.candidateEntityIds, ['A', 'B']);

  const summary = summaryFor(call);
  assert.equal(summary.status.completeness, 'partial');
  assert.equal(summary.unknownCallEffects.length, 1);
  assert.equal(summary.unknownCallEffects[0].reason, 'unresolved-target');
  assert.deepEqual(summary.unknownCallEffects[0].targetEntityIds, ['A', 'B']);
  assert.equal(summary.directCalls.length, 0);
  assert.ok(summary.memoryWriteRegions.some(
    (effect) => effect.broad && effect.source === 'unknown-call-fallback',
  ));
  assert.equal(summary.noreturn, 'unknown');
  assert.equal(summary.mayThrow, 'unknown');
});

test('an exhaustive singleton direct target keeps the existing direct-call representation', () => {
  const summary = summaryFor({ targetEntityIds: ['A'] });
  assert.equal(summary.status.completeness, 'complete');
  assert.equal(summary.unknownCallEffects.length, 0);
  assert.equal(summary.directCalls.length, 1);
  assert.deepEqual(summary.directCalls[0].targetEntityIds, ['A']);
});

test('a targetless complete call keeps the existing ABI-rule semantics', () => {
  const proof = classifyCallTargetProof({ completeness: 'complete' });
  assert.equal(proof.kind, 'unknown');
  assert.equal(proof.exhaustive, false);

  const summary = summaryFor({ completeness: 'complete' });
  assert.equal(summary.status.completeness, 'complete');
  assert.equal(summary.unknownCallEffects.length, 0);
  assert.equal(summary.directCalls.length, 0);
  assert.equal(summary.indirectCallSets.length, 0);
});

test('an exhaustive indirect candidate set keeps the existing finite-set representation', () => {
  const summary = summaryFor({
    targetValueIds: ['callee_pointer'],
    targetEntityIds: ['A', 'B'],
    completeness: 'complete',
  });
  assert.equal(summary.status.completeness, 'complete');
  assert.equal(summary.unknownCallEffects.length, 0);
  assert.equal(summary.directCalls.length, 0);
  assert.equal(summary.indirectCallSets.length, 1);
  assert.equal(summary.indirectCallSets[0].exhaustive, true);
  assert.deepEqual(summary.indirectCallSets[0].candidateEntityIds, ['A', 'B']);
});

test('a non-exhaustive indirect candidate set remains partial', () => {
  const summary = summaryFor({
    targetValueIds: ['callee_pointer'],
    targetEntityIds: ['A', 'B'],
    completeness: 'partial',
  });
  assert.equal(summary.status.completeness, 'partial');
  assert.equal(summary.unknownCallEffects.length, 1);
  assert.equal(summary.unknownCallEffects[0].reason, 'indirect-incomplete-target-set');
  assert.equal(summary.indirectCallSets.length, 1);
  assert.equal(summary.indirectCallSets[0].exhaustive, false);
});
