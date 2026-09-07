// Regression for #5915: AnalysisQueryAPI results are an immutable consistent
// view — the exposed value must not be a live reference into adapter-owned
// analysis/cache state, and the frozen tree must reject consumer mutations.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AnalysisQueryAPI } from '../../../js/analysis/query/api.js';

const shared = {
  blocks: [{ id: 'b0', instructions: [{ op: 'add' }] }],
  counts: new Map([['b0', 1]]),
  offsets: new Uint8Array([1, 2, 3]),
};

function adapter() {
  return {
    async currentIdentity() {
      return { binaryId: 'bin-5915', projectRevision: 0, analysisEpoch: 1, artifactVersions: {} };
    },
    async semanticIR() {
      return { value: shared, status: { completeness: 'complete', detail: { nested: true } } };
    },
  };
}

test('#5915 the exposed value is deeply frozen', async () => {
  const api = new AnalysisQueryAPI(adapter());
  const snap = await api.snapshot();
  const result = await api.semanticIR(snap, 'fn:0');
  assert.equal(Object.isFrozen(result.value), true);
  assert.equal(Object.isFrozen(result.value.blocks), true);
  assert.equal(Object.isFrozen(result.value.blocks[0].instructions), true);
  assert.equal(Object.isFrozen(result.status), true);
  assert.equal(Object.isFrozen(result.status.detail), true);
});

test('#5915 consumer mutation cannot reach adapter-owned state', async () => {
  const api = new AnalysisQueryAPI(adapter());
  const snap = await api.snapshot();
  const result = await api.semanticIR(snap, 'fn:0');
  assert.throws(() => { result.value.blocks[0].instructions[0].op = 'ret'; }, TypeError);
  assert.equal(shared.blocks[0].instructions[0].op, 'add', 'the adapter-owned artifact must be unchanged');
  assert.throws(() => { result.status.detail.nested = false; }, TypeError);
});

test('#5915 typed arrays and Maps are detached from internal state', async () => {
  const api = new AnalysisQueryAPI(adapter());
  const snap = await api.snapshot();
  const result = await api.semanticIR(snap, 'fn:0');
  // structuredClone detaches them: mutating the exposed copies must not flow back.
  result.value.offsets[0] = 99;
  result.value.counts.set('b0', 999);
  assert.deepEqual([...shared.offsets], [1, 2, 3]);
  assert.equal(shared.counts.get('b0'), 1);
});

test('#5915 values that cannot be structured-cloned stay mutation-proof via in-place freezing', async () => {
  const fnOwned = { handlers: [() => 1], note: 'adapter-owned' };
  const cloningAdapter = {
    async currentIdentity() {
      return { binaryId: 'bin-5915', projectRevision: 0, analysisEpoch: 1, artifactVersions: {} };
    },
    async semanticIR() {
      return { value: fnOwned, status: { completeness: 'complete' } };
    },
  };
  const api = new AnalysisQueryAPI(cloningAdapter);
  const snap = await api.snapshot();
  const result = await api.semanticIR(snap, 'fn:0');
  assert.equal(Object.isFrozen(result.value), true);
  assert.throws(() => { result.value.note = 'mutated'; }, TypeError);
  assert.equal(fnOwned.note, 'adapter-owned');
});
