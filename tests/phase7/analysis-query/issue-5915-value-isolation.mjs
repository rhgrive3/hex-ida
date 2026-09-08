// Regression for #5915: AnalysisQueryAPI results are an immutable consistent
// view — the exposed value must not be a live reference into adapter-owned
// analysis/cache state, and the frozen tree must reject consumer mutations.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AnalysisQueryAPI } from '../../../js/analysis/query/api.js';

const shared = {
  blocks: [{ id: 'b0', instructions: [{ op: 'add' }] }],
  counts: new Map([['b0', 1]]),
  ids: new Set(['b0']),
  offsets: new Uint8Array([1, 2, 3]),
  raw: Uint8Array.from([4, 5, 6]).buffer,
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

test('#5915 mutable collection copies are detached from internal state', async () => {
  const api = new AnalysisQueryAPI(adapter());
  const snap = await api.snapshot();
  const result = await api.semanticIR(snap, 'fn:0');
  result.value.offsets[0] = 99;
  result.value.counts.set('b0', 999);
  result.value.ids.add('b1');
  new Uint8Array(result.value.raw)[0] = 88;
  assert.deepEqual([...shared.offsets], [1, 2, 3]);
  assert.equal(shared.counts.get('b0'), 1);
  assert.deepEqual([...shared.ids], ['b0']);
  assert.deepEqual([...new Uint8Array(shared.raw)], [4, 5, 6]);
});

test('#5915 unclonable mixed trees fail closed instead of sharing adapter state', async () => {
  const fnOwned = {
    handlers: [() => 1],
    counts: new Map([['b0', 1]]),
    ids: new Set(['b0']),
    offsets: new Uint8Array([1, 2, 3]),
    raw: Uint8Array.from([4, 5, 6]).buffer,
    note: 'adapter-owned',
  };
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
  await assert.rejects(api.semanticIR(snap, 'fn:0'), /analysis-query-value-unclonable/);
  assert.equal(Object.isFrozen(fnOwned), false, 'rejection must not freeze adapter-owned state in place');
  assert.equal(fnOwned.counts.get('b0'), 1);
  assert.deepEqual([...fnOwned.ids], ['b0']);
  assert.deepEqual([...fnOwned.offsets], [1, 2, 3]);
  assert.deepEqual([...new Uint8Array(fnOwned.raw)], [4, 5, 6]);
  assert.equal(fnOwned.note, 'adapter-owned');
});

test('#5915 top-level functions and symbols are rejected as non-snapshot values', async () => {
  for (const value of [() => 1, Symbol('owned')]) {
    const unclonableAdapter = {
      async currentIdentity() {
        return { binaryId: 'bin-5915', projectRevision: 0, analysisEpoch: 1, artifactVersions: {} };
      },
      async semanticIR() {
        return { value, status: { completeness: 'complete' } };
      },
    };
    const api = new AnalysisQueryAPI(unclonableAdapter);
    const snap = await api.snapshot();
    await assert.rejects(api.semanticIR(snap, 'fn:0'), /analysis-query-value-unclonable/);
  }
});

test('#5915 page and cost are detached from adapter-owned response metadata', async () => {
  const pageOwned = {
    cursor: { n: 1 },
    offsets: new Uint8Array([7, 8]),
  };
  const costOwned = {
    budget: { used: 1 },
    buckets: new Map([['query', 1]]),
  };
  const metadataAdapter = {
    async currentIdentity() {
      return { binaryId: 'bin-5915', projectRevision: 0, analysisEpoch: 1, artifactVersions: {} };
    },
    async semanticIR() {
      return {
        value: { ok: true },
        status: { completeness: 'complete' },
        page: pageOwned,
        cost: costOwned,
      };
    },
  };
  const api = new AnalysisQueryAPI(metadataAdapter);
  const snap = await api.snapshot();
  const result = await api.semanticIR(snap, 'fn:0');

  assert.equal(Object.isFrozen(result.page), true);
  assert.equal(Object.isFrozen(result.page.cursor), true);
  assert.equal(Object.isFrozen(result.cost), true);
  assert.equal(Object.isFrozen(result.cost.budget), true);
  assert.throws(() => { result.page.cursor.n = 2; }, TypeError);
  assert.throws(() => { result.cost.budget.used = 999; }, TypeError);

  // Keyed/buffered collection facades may remain mutable, but must be detached.
  result.page.offsets[0] = 99;
  result.cost.buckets.set('query', 999);
  assert.equal(pageOwned.cursor.n, 1);
  assert.deepEqual([...pageOwned.offsets], [7, 8]);
  assert.equal(costOwned.budget.used, 1);
  assert.equal(costOwned.buckets.get('query'), 1);
});
