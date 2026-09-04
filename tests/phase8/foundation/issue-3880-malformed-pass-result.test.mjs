import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PHASE8_CONTRACT_VERSION,
  createPassDescriptor,
  createPassResult,
  unchangedResult,
} from '../../../js/decompiler/phase8/contract.js';
import { createAnalysisState, runPassTransaction } from '../../../js/decompiler/phase8/transaction.js';

const PASS_ID = 'issue-3880-malformed-pass-result';

function descriptor(produces = []) {
  return createPassDescriptor({
    id: PASS_ID,
    version: '1',
    stage: 'scalar-optimization',
    produces,
  });
}

function malformedPass(value, ownDescriptor = descriptor()) {
  return {
    descriptor: ownDescriptor,
    run() { return value; },
  };
}

function assertMalformedRefused(value) {
  const state = createAnalysisState({});
  const before = state.snapshot();
  let outcome;

  assert.doesNotThrow(() => {
    outcome = runPassTransaction(state, malformedPass(value));
  });
  assert.equal(outcome.committed, false);
  assert.equal(outcome.result, null);
  assert.equal(outcome.stopReason, `malformed-result:${PASS_ID}`);
  assert.deepEqual(outcome.staged, []);
  assert.deepEqual(outcome.invalidated, []);
  assert.deepEqual(state.snapshot(), before);
}

test('null, primitives, arrays and empty objects are refused without escaping the transaction', async (t) => {
  for (const [name, value] of [
    ['null', null],
    ['undefined', undefined],
    ['boolean', true],
    ['number', 1],
    ['string', 'x'],
    ['array', []],
    ['empty object', {}],
  ]) {
    await t.test(name, () => assertMalformedRefused(value));
  }
});

test('contract and required result fields must have their canonical outer shape', async (t) => {
  const ownDescriptor = descriptor();
  const canonical = unchangedResult(ownDescriptor);
  const malformed = [
    ['stale contract', { ...canonical, contractVersion: PHASE8_CONTRACT_VERSION - 1 }],
    ['missing pass id', { ...canonical, passId: null }],
    ['non-boolean changed', { ...canonical, changed: 'false' }],
    ['produced null', { ...canonical, produced: null }],
    ['invalidated object', { ...canonical, invalidated: {} }],
    ['transforms null', { ...canonical, transforms: null }],
    ['diagnostics object', { ...canonical, diagnostics: {} }],
    ['preserved null', { ...canonical, preserved: null }],
  ];

  for (const [name, value] of malformed) {
    await t.test(name, () => assertMalformedRefused(value));
  }
});

test('throwing result accessors are contained by the malformed-result boundary', () => {
  const value = {};
  Object.defineProperty(value, 'contractVersion', {
    get() { throw new Error('hostile getter'); },
  });
  assertMalformedRefused(value);
});

test('staged work is discarded when the pass returns a malformed result', () => {
  const state = createAnalysisState({});
  const before = state.snapshot();
  const ownDescriptor = descriptor(['ranges']);
  const pass = {
    descriptor: ownDescriptor,
    run(_context, _budget, staging) {
      staging.stage('ranges', Object.freeze({ min: 0, max: 1, completeness: 'complete' }));
      return null;
    },
  };

  let outcome;
  assert.doesNotThrow(() => {
    outcome = runPassTransaction(state, pass);
  });
  assert.equal(outcome.committed, false);
  assert.equal(outcome.stopReason, `malformed-result:${PASS_ID}`);
  assert.deepEqual(outcome.staged, []);
  assert.deepEqual(outcome.invalidated, []);
  assert.deepEqual(state.snapshot(), before);
  assert.equal(state.version('ranges'), 0);
  assert.equal(state.get('ranges'), null);
});

test('pass throws keep the existing failed result semantics', () => {
  const state = createAnalysisState({});
  const ownDescriptor = descriptor();
  const pass = {
    descriptor: ownDescriptor,
    run() { throw new Error('boom'); },
  };

  const outcome = runPassTransaction(state, pass);
  assert.equal(outcome.committed, false);
  assert.equal(outcome.stopReason, 'failed:boom');
});

test('canonical pass results still commit normally', () => {
  const state = createAnalysisState({});
  const ownDescriptor = descriptor(['ranges']);
  const value = Object.freeze({ min: -1, max: 4, completeness: 'complete' });
  const pass = {
    descriptor: ownDescriptor,
    run(_context, _budget, staging) {
      staging.stage('ranges', value);
      return createPassResult({
        descriptor: ownDescriptor,
        status: 'changed',
        completeness: 'complete',
        produced: ['ranges'],
      });
    },
  };

  const outcome = runPassTransaction(state, pass);
  assert.equal(outcome.committed, true);
  assert.equal(outcome.stopReason, null);
  assert.equal(state.version('ranges'), 1);
  assert.equal(state.get('ranges'), value);
});
