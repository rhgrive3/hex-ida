import assert from 'node:assert/strict';
import test from 'node:test';

import { createPassDescriptor, createPassResult } from '../../../js/decompiler/phase8/contract.js';
import {
  commitAnalysisState,
  createAnalysisState,
  forkAnalysisState,
  runPassTransaction,
} from '../../../js/decompiler/phase8/transaction.js';

function producer(value) {
  const descriptor = createPassDescriptor({
    id: 'issue-3941-analysis-state-capability',
    version: '1',
    stage: 'canonical-facts',
    produces: ['ranges'],
  });
  return {
    descriptor,
    run(_context, _budget, staging) {
      staging.stage('ranges', value);
      return createPassResult({
        descriptor,
        status: 'changed',
        completeness: 'complete',
        produced: ['ranges'],
      });
    },
  };
}

test('authoritative analysis state exposes read-only capabilities only', () => {
  const cfg = Object.freeze({ blocks: ['trusted'] });
  const state = createAnalysisState({ cfg });

  assert.equal('__write' in state, false);
  assert.equal('__drop' in state, false);
  assert.equal(state.__write, undefined);
  assert.equal(state.__drop, undefined);
  assert.deepEqual(Object.keys(state).sort(), ['available', 'get', 'snapshot', 'version']);

  assert.equal(state.get('cfg'), cfg);
  assert.equal(state.version('cfg'), 1);
});

test('transaction commit retains exclusive mutation and invalidation authority', () => {
  const cfg = Object.freeze({ blocks: ['trusted'] });
  const ssa = Object.freeze({ values: ['trusted'] });
  const ranges = Object.freeze({ min: -4, max: 12, completeness: 'complete' });
  const state = createAnalysisState({ cfg, ssa });

  const outcome = runPassTransaction(state, producer(ranges));

  assert.equal(outcome.committed, true);
  assert.equal(outcome.stopReason, null);
  assert.equal(state.get('ranges'), ranges);
  assert.equal(state.version('ranges'), 1);
  assert.equal(state.get('cfg'), null);
  assert.equal(state.get('ssa'), null);
  assert.equal(state.version('cfg'), 2);
  assert.equal(state.version('ssa'), 2);
  assert.ok(outcome.invalidated.includes('cfg'));
  assert.ok(outcome.invalidated.includes('ssa'));
});

test('vertical state publication still preserves the exact version delta', () => {
  const cfg = Object.freeze({ blocks: ['trusted'] });
  const ranges = Object.freeze({ min: 0, max: 7, completeness: 'complete' });
  const target = createAnalysisState({ cfg });
  const before = target.snapshot();
  const working = forkAnalysisState(target);

  const outcome = runPassTransaction(working, producer(ranges));
  assert.equal(outcome.committed, true);
  assert.equal(commitAnalysisState(target, working, before), true);

  assert.deepEqual(target.snapshot(), working.snapshot());
  assert.equal(target.get('cfg'), null);
  assert.equal(target.get('ranges'), ranges);
  assert.equal(target.version('cfg'), 2);
  assert.equal(target.version('ranges'), 1);
});

test('commitAnalysisState refuses a non-authoritative target surface', () => {
  const source = createAnalysisState({ cfg: Object.freeze({ blocks: ['trusted'] }) });
  const working = forkAnalysisState(source);
  const before = source.snapshot();
  const forgedTarget = {
    get: source.get.bind(source),
    version: source.version.bind(source),
    snapshot: source.snapshot.bind(source),
    available: source.available.bind(source),
  };

  assert.equal(commitAnalysisState(forgedTarget, working, before), false);
});

test('registered analysis state API is frozen against capability replacement', () => {
  const state = createAnalysisState({ cfg: Object.freeze({ blocks: ['trusted'] }) });
  const originalSnapshot = state.snapshot;

  assert.throws(() => {
    state.snapshot = () => ({ cfg: 0 });
  });

  assert.equal(state.snapshot, originalSnapshot);
  const forgedBefore = { cfg: 0 };
  const source = createAnalysisState({ cfg: Object.freeze({ blocks: ['trusted'] }) });
  const working = forkAnalysisState(source);
  assert.equal(
    commitAnalysisState(state, working, forgedBefore),
    false,
    'stale working state must not pass the version check via a replaced snapshot',
  );
});

test('commitAnalysisState refuses a forged working state without registered mutators', () => {
  const target = createAnalysisState({ cfg: Object.freeze({ blocks: ['trusted'] }) });
  const before = target.snapshot();
  const genuineWorking = forkAnalysisState(target);
  const forgedWorking = {
    get: (key) => (key === 'cfg' ? { blocks: ['forged'] } : null),
    version: () => before.cfg + 7,
    snapshot: () => ({ ...before, cfg: before.cfg + 7 }),
    available: () => ['cfg'],
  };

  assert.equal(
    commitAnalysisState(target, forgedWorking, before),
    false,
    'a forged working state must not drive the genuine private mutators',
  );
  assert.equal(target.get('cfg'), target.get('cfg'));
  assert.equal(target.version('cfg'), before.cfg);
  assert.equal(commitAnalysisState(target, genuineWorking, before), true);
});
