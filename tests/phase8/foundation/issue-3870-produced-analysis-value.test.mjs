import assert from 'node:assert/strict';
import test from 'node:test';

import { createAnalysisState, runPassTransaction } from '../../../js/decompiler/phase8/transaction.js';

const CONTRACT_VERSION = 6;

function descriptor(produces = ['ranges'], consumes = []) {
  return Object.freeze({
    contractVersion: CONTRACT_VERSION,
    id: 'issue-3870-produced-analysis-value',
    version: '1',
    stage: 'canonical-facts',
    budgetClass: 'standard',
    consumes: Object.freeze([...consumes]),
    preserves: Object.freeze([]),
    invalidates: Object.freeze([]),
    produces: Object.freeze([...produces]),
    required: false,
    description: '',
  });
}

function producer(value) {
  const ownDescriptor = descriptor();
  return {
    descriptor: ownDescriptor,
    run(_context, _budget, staging) {
      staging.stage('ranges', value);
      return Object.freeze({
        changed: true,
        completeness: 'complete',
        produced: Object.freeze(['ranges']),
      });
    },
  };
}

test('nullish produced analyses fail closed without publishing availability', async (t) => {
  for (const [name, value] of [['undefined', undefined], ['null', null]]) {
    await t.test(name, () => {
      const state = createAnalysisState({});
      const before = state.snapshot();
      const outcome = runPassTransaction(state, producer(value));

      assert.equal(outcome.committed, false);
      assert.equal(outcome.stopReason, 'failed:phase8-pass-produced-analysis-value-required:ranges');
      assert.deepEqual(state.snapshot(), before);
      assert.equal(state.version('ranges'), 0);
      assert.equal(state.get('ranges'), null);
      assert.ok(!state.available().includes('ranges'));
    });
  }
});

test('a later nullish production aborts the whole staged transaction', () => {
  const state = createAnalysisState({});
  const before = state.snapshot();
  const ownDescriptor = descriptor(['ranges', 'dominators']);
  const pass = {
    descriptor: ownDescriptor,
    run(_context, _budget, staging) {
      staging.stage('ranges', Object.freeze({ min: 0, max: 1 }));
      staging.stage('dominators', null);
      return Object.freeze({
        changed: true,
        completeness: 'complete',
        produced: Object.freeze(['dominators', 'ranges']),
      });
    },
  };

  const outcome = runPassTransaction(state, pass);
  assert.equal(outcome.committed, false);
  assert.equal(outcome.stopReason, 'failed:phase8-pass-produced-analysis-value-required:dominators');
  assert.deepEqual(state.snapshot(), before);
  assert.equal(state.version('ranges'), 0);
  assert.equal(state.version('dominators'), 0);
});

test('downstream consumers still observe missing input after rejected production', () => {
  const state = createAnalysisState({});
  const rejected = runPassTransaction(state, producer(undefined));
  assert.equal(rejected.committed, false);

  let ran = false;
  const consumer = {
    descriptor: descriptor([], ['ranges']),
    run() {
      ran = true;
      return Object.freeze({ changed: false, completeness: 'complete', produced: Object.freeze([]) });
    },
  };
  const outcome = runPassTransaction(state, consumer);

  assert.equal(ran, false);
  assert.equal(outcome.committed, false);
  assert.equal(outcome.stopReason, 'missing-input:ranges');
});

test('a concrete produced analysis still commits with one authoritative version', () => {
  const state = createAnalysisState({});
  const value = Object.freeze({ min: -4, max: 12, completeness: 'complete' });
  const outcome = runPassTransaction(state, producer(value));

  assert.equal(outcome.committed, true);
  assert.equal(outcome.stopReason, null);
  assert.equal(state.version('ranges'), 1);
  assert.deepEqual(state.available(), ['ranges']);
  assert.equal(state.get('ranges'), value);
});
