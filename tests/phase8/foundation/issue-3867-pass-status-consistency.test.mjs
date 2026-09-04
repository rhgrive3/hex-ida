import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createPassDescriptor,
  createPassResult,
  unchangedResult,
} from '../../../js/decompiler/phase8/contract.js';
import {
  createAnalysisState,
  runPassTransaction,
} from '../../../js/decompiler/phase8/transaction.js';

const descriptor = createPassDescriptor({
  id: 'issue-3867-status-contract',
  version: '1',
  stage: 'scalar-optimization',
  consumes: [],
  preserves: [],
  invalidates: ['cfg'],
  produces: ['valueNumbers'],
});

const transform = Object.freeze({
  kind: 'rewrite',
  targets: ['ir:1'],
  proof: 'issue-3867-counterexample',
  originRefs: [],
});

function result(overrides = {}) {
  return createPassResult({
    descriptor,
    status: 'unchanged',
    completeness: 'complete',
    ...overrides,
  });
}

test('unchanged and unsupported statuses cannot acquire mutation authority', () => {
  assert.throws(
    () => result({ status: 'unchanged', changed: true, transforms: [transform] }),
    /phase8-pass-result-unchanged-changed/,
  );
  assert.throws(
    () => result({ status: 'unchanged', transforms: [transform] }),
    /phase8-pass-result-transform-without-change/,
  );
  assert.throws(
    () => result({ status: 'unchanged', produced: ['valueNumbers'] }),
    /phase8-pass-result-production-without-change/,
  );
  assert.throws(
    () => result({ status: 'unchanged', invalidated: ['cfg'] }),
    /phase8-pass-result-unchanged-invalidates/,
  );

  assert.throws(
    () => result({ status: 'unsupported', changed: true, completeness: 'partial', transforms: [transform] }),
    /phase8-pass-result-unsupported-changed/,
  );
  assert.throws(
    () => result({ status: 'unsupported', completeness: 'partial', transforms: [transform] }),
    /phase8-pass-result-transform-without-change/,
  );
  assert.throws(
    () => result({ status: 'unsupported', completeness: 'partial', produced: ['valueNumbers'] }),
    /phase8-pass-result-production-without-change/,
  );
  assert.throws(
    () => result({ status: 'unsupported', completeness: 'partial', invalidated: ['cfg'] }),
    /phase8-pass-result-unsupported-invalidates/,
  );
});

test('changed status cannot contradict its mutation bit', () => {
  assert.throws(
    () => result({ status: 'changed', changed: false }),
    /phase8-pass-result-changed-not-changed/,
  );

  const transformed = result({ status: 'changed', transforms: [transform] });
  assert.equal(transformed.changed, true);
  assert.equal(transformed.transforms.length, 1);

  const analysisOnly = result({ status: 'changed', produced: ['valueNumbers'] });
  assert.equal(analysisOnly.changed, true);
  assert.deepEqual(analysisOnly.produced, ['valueNumbers']);
});

test('canonical unchanged/unsupported and degraded semantics remain available', () => {
  const unchanged = unchangedResult(descriptor);
  assert.equal(unchanged.status, 'unchanged');
  assert.equal(unchanged.changed, false);

  const unsupported = result({ status: 'unsupported', completeness: 'partial' });
  assert.equal(unsupported.status, 'unsupported');
  assert.equal(unsupported.changed, false);

  const degradedWithoutMutation = result({ status: 'degraded', changed: false, completeness: 'partial' });
  assert.equal(degradedWithoutMutation.changed, false);

  const degradedWithMutation = result({
    status: 'degraded',
    completeness: 'partial',
    transforms: [transform],
  });
  assert.equal(degradedWithMutation.changed, true);
});

test('a rejected status contradiction cannot move authoritative state', () => {
  const state = createAnalysisState({
    cfg: Object.freeze({ blocks: [] }),
    ssa: Object.freeze({ values: [] }),
  });
  const before = state.snapshot();
  const pass = {
    descriptor,
    run() {
      return result({ status: 'unchanged', changed: true, transforms: [transform] });
    },
  };

  const outcome = runPassTransaction(state, pass);

  assert.equal(outcome.committed, false);
  assert.match(outcome.stopReason, /^failed:phase8-pass-result-unchanged-changed$/);
  assert.deepEqual(state.snapshot(), before);
  assert.deepEqual(state.get('cfg'), { blocks: [] });
  assert.deepEqual(state.get('ssa'), { values: [] });
});
