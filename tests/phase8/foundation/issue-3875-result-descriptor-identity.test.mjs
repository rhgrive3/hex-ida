import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createPassDescriptor,
  createPassResult,
} from '../../../js/decompiler/phase8/contract.js';
import {
  createAnalysisState,
  runPassTransaction,
  transactionDigest,
} from '../../../js/decompiler/phase8/transaction.js';

const descriptor = createPassDescriptor({
  id: 'issue-3875-pass-a',
  version: '1',
  stage: 'scalar-optimization',
  consumes: [],
  preserves: ['cfg'],
  invalidates: [],
  produces: ['ranges'],
});

const invalidatingDescriptor = createPassDescriptor({
  id: 'issue-3875-policy-authority',
  version: '1',
  stage: 'scalar-optimization',
  consumes: [],
  preserves: [],
  invalidates: ['ssa'],
  produces: ['ranges'],
});

function canonicalResult() {
  return createPassResult({
    descriptor,
    status: 'changed',
    changed: true,
    completeness: 'complete',
    produced: ['ranges'],
  });
}

function runWithResult(result, passDescriptor = descriptor) {
  const state = createAnalysisState({
    cfg: Object.freeze({ blocks: [] }),
    ssa: Object.freeze({ values: ['pre-existing'] }),
  });
  const before = state.snapshot();
  const outcome = runPassTransaction(state, {
    descriptor: passDescriptor,
    run(_context, _budget, area) {
      area.stage('ranges', Object.freeze({ source: 'issue-3875-pass-a' }));
      return result;
    },
  });
  return { state, before, outcome };
}

function assertRefusedPolicy(result, passDescriptor) {
  const { state, before, outcome } = runWithResult(result, passDescriptor);
  assert.equal(outcome.committed, false);
  assert.equal(outcome.result, null);
  assert.equal(outcome.stopReason, `malformed-result:${passDescriptor.id}`);
  assert.deepEqual(outcome.invalidated, []);
  assert.deepEqual(outcome.staged, []);
  assert.deepEqual(state.snapshot(), before);
  assert.equal(state.version('ssa'), before.ssa);
  assert.equal(state.get('ranges'), null);
  assert.equal(
    transactionDigest(outcome),
    transactionDigest({
      committed: false,
      result: null,
      invalidated: Object.freeze([]),
      staged: Object.freeze([]),
      stopReason: `malformed-result:${passDescriptor.id}`,
    }),
  );
}

function assertRefusedIdentity(overrides, stopReason = `result-descriptor-mismatch:${descriptor.id}`) {
  const result = Object.freeze({ ...canonicalResult(), ...overrides });
  const { state, before, outcome } = runWithResult(result);
  assert.equal(outcome.committed, false);
  assert.equal(outcome.result, null);
  assert.equal(outcome.stopReason, stopReason);
  assert.deepEqual(outcome.invalidated, []);
  assert.deepEqual(outcome.staged, []);
  assert.deepEqual(state.snapshot(), before);
  assert.deepEqual(state.get('ssa'), { values: ['pre-existing'] });
  assert.equal(state.version('ssa'), before.ssa);
  assert.equal(state.get('ranges'), null);
}

function assertRefusedRawResult(rawResult) {
  const state = createAnalysisState({
    cfg: Object.freeze({ blocks: [] }),
    ssa: Object.freeze({ values: ['pre-existing'] }),
  });
  const before = state.snapshot();
  const outcome = runPassTransaction(state, {
    descriptor,
    run(_context, _budget, area) {
      area.stage('ranges', Object.freeze({ source: 'issue-3875-pass-a' }));
      return rawResult;
    },
  });
  assert.equal(outcome.committed, false);
  assert.equal(outcome.result, null);
  assert.equal(outcome.stopReason, `malformed-result:${descriptor.id}`);
  assert.deepEqual(outcome.invalidated, []);
  assert.deepEqual(outcome.staged, []);
  assert.deepEqual(state.snapshot(), before);
  assert.deepEqual(state.get('ssa'), { values: ['pre-existing'] });
  assert.equal(state.get('ranges'), null);
}

test('exact descriptor identity retains transaction authority', () => {
  const { state, outcome } = runWithResult(canonicalResult());

  assert.equal(outcome.committed, true);
  assert.equal(outcome.stopReason, null);
  assert.equal(outcome.result.passId, descriptor.id);
  assert.equal(outcome.result.passVersion, descriptor.version);
  assert.equal(outcome.result.stage, descriptor.stage);
  assert.equal(outcome.result.contractVersion, descriptor.contractVersion);
  assert.deepEqual(state.get('ranges'), { source: 'issue-3875-pass-a' });
  assert.equal(typeof transactionDigest(outcome), 'string');
});

test('result passId is bound to the invoked descriptor', () => {
  assertRefusedIdentity({ passId: 'issue-3875-pass-b' });
});

test('result passVersion is bound to the invoked descriptor', () => {
  assertRefusedIdentity({ passVersion: '99' });
});

test('result stage is bound to the invoked descriptor', () => {
  assertRefusedIdentity({ stage: 'providers' });
});

test('result contractVersion is bound to the invoked descriptor', () => {
  // The canonical shape guard owns the global contract version and runs before
  // descriptor identity, so a stale contract is a malformed-result refusal.
  assertRefusedIdentity(
    { contractVersion: descriptor.contractVersion + 1 },
    `malformed-result:${descriptor.id}`,
  );
});

test('descriptor policy metadata is bound before commit and digesting', () => {
  const canonical = createPassResult({
    descriptor: invalidatingDescriptor,
    status: 'changed',
    changed: true,
    completeness: 'complete',
    produced: ['ranges'],
    invalidated: ['ssa'],
  });

  assertRefusedPolicy(
    Object.freeze({ ...canonical, preserved: ['cfg'] }),
    invalidatingDescriptor,
  );
  assertRefusedPolicy(
    Object.freeze({ ...canonical, invalidated: ['cfg'] }),
    invalidatingDescriptor,
  );
});

test('null and undefined pass results are refused without mutation', () => {
  assertRefusedRawResult(null);
  assertRefusedRawResult(undefined);
});
