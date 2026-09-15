import assert from 'node:assert/strict';
import test from 'node:test';

import { createAppAnalysisQueryAdapter as createProductAdapter } from '../../js/analysis/query/product-adapter.js';
import { createAppAnalysisQueryAdapter as createBaseAdapter } from '../../js/analysis/query/app-adapter.js';

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

function discoveryApp({ epoch = 1, programRegions = () => [] } = {}) {
  const calls = [];
  const gates = [];
  const app = {
    backend: { gen: epoch },
    programRegions,
    ensureFunctions(region) {
      calls.push(region);
      const gate = deferred();
      gates.push(gate);
      return gate.promise.then(() => ({ observedId: region?.id ?? null }));
    },
  };
  createProductAdapter(app);
  return { app, calls, gates };
}

test('#3980 malformed epoch never becomes canonical discovery authority', async () => {
  for (const epoch of [['1'], '1', true, { valueOf() { throw new Error('must-not-coerce'); } }]) {
    const { app, calls } = discoveryApp({ epoch });
    assert.throws(() => app.ensureFunctions({ id: 'text', exec: true }), TypeError);
    assert.equal(calls.length, 0, 'malformed epoch must fail before producer creation');
  }
});

test('#3980 canonical equal region+epoch requests still single-flight', async () => {
  const { app, calls, gates } = discoveryApp();
  const a = app.ensureFunctions({ id: 'text', exec: true });
  const b = app.ensureFunctions({ id: 'text', exec: true });
  await Promise.resolve();
  assert.equal(calls.length, 1);
  gates[0].resolve();
  await Promise.all([a, b]);
});

test('#3980 structured region ids remain unshared raw producers', async () => {
  const { app, calls, gates } = discoveryApp();
  const structured = { id: ['text'], exec: true };
  const a = app.ensureFunctions(structured);
  const b = app.ensureFunctions({ id: 'text', exec: true });
  await Promise.resolve();
  assert.equal(calls.length, 2);
  assert.equal(calls[0], structured, 'unshared producer must receive the exact raw region');
  gates.forEach((gate) => gate.resolve());
  await Promise.all([a, b]);
});

test('#3980 discovery key has no delimiter collision between canonical region lists', async () => {
  let regions = [{ id: 'a', exec: true }];
  const { app, calls, gates } = discoveryApp({ programRegions: () => regions });
  const a = app.ensureFunctions({ id: 'b', exec: true });
  regions = [];
  const b = app.ensureFunctions({ id: 'a|b', exec: true });
  await Promise.resolve();
  assert.equal(calls.length, 2, 'different canonical region identities must not collide through key delimiters');
  gates.forEach((gate) => gate.resolve());
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.observedId, 'b');
  assert.equal(rb.observedId, 'a|b');
});

test('#3980 base metadata cache rejects malformed epoch before producer creation', async () => {
  let metadataCalls = 0;
  const region = { id: 'text', vmAddr: 0n, size: 0x100n, exec: true };
  const app = {
    store: { architecture: 'riscv64' },
    backend: {
      gen: ['1'],
      async binaryMetadata() { metadataCalls++; return { summary: {}, metadata: { flags: 0 } }; },
      async analyzeSemanticFunction() { return { completeness: 'complete' }; },
    },
    symbols: { functionAt() { return { start: 0n, end: 4n }; }, nameAt() { return null; } },
    validatedFunctionRange() {
      return { ok: true, start: 0n, end: 4n, region, function: { start: 0n, end: 4n }, complete: true, provenance: 'test' };
    },
  };
  const adapter = createBaseAdapter(app);
  await assert.rejects(() => adapter.functionById(null, 0n, {}), TypeError);
  assert.equal(metadataCalls, 0, 'metadata producer must not start under malformed epoch authority');
});
