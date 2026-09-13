import assert from 'node:assert/strict';
import { HypothesisVerifier } from '../js/dynamic/experiments.js';

// Issue #4933: an external AbortSignal aborted while launch()/resume() are
// awaiting must be classified from the signal state, not only from
// error.code, so a standard AbortError rejection ends as `cancelled`
// (coverage.cancelled=true) instead of `exception`.

const makeCase = (id) => ({
  id,
  input: { arguments: [0n, 1n] },
  initialState: { objectBase: 0n, fields: [] },
  watch: [],
  expected: { returnValue: 1n },
});
const makeExperiment = (id, n) => ({ id, functionAddress: 0x1000n, cases: Array.from({ length: n }, (_, i) => makeCase(`${id}:case-${i}`)) });

const abortError = () => new DOMException('The operation was aborted', 'AbortError');

function abortingAdapter(ac, mode, signalError = abortError) {
  const launches = { count: 0 };
  return {
    launches,
    async launch() {
      launches.count += 1;
      if (mode === 'launch') { ac.abort(); throw signalError(); }
    },
    async resume() {
      if (mode === 'resume') { ac.abort(); throw signalError(); }
      return { stop: { kind: 'return' }, returnValue: 1n };
    },
  };
}

async function verifyWith(adapter, n = 1, options = {}) {
  const verifier = new HypothesisVerifier(adapter);
  return verifier.verify(makeExperiment('cancel', n), options);
}

{
  const ac = new AbortController();
  ac.abort();
  const result = await verifyWith(abortingAdapter(ac, 'none'), 1, { signal: ac.signal });
  assert.equal(result.cases[0].observation.stop.kind, 'cancelled', 'pre-aborted signal stays cancelled');
  assert.equal(result.coverage.cancelled, true, 'pre-aborted signal keeps cancelled coverage');
}

{
  const ac = new AbortController();
  const result = await verifyWith(abortingAdapter(ac, 'launch'), 1, { signal: ac.signal });
  assert.equal(result.cases[0].observation.stop.kind, 'cancelled', 'AbortError during launch with aborted signal is cancelled');
  assert.equal(result.coverage.cancelled, true, 'coverage.cancelled is true for 1-case cancel during launch');
  assert.ok(result.coverage.reasons.includes('cancelled'), 'cancelled reason recorded');
}

{
  const ac = new AbortController();
  const result = await verifyWith(abortingAdapter(ac, 'resume'), 1, { signal: ac.signal });
  assert.equal(result.cases[0].observation.stop.kind, 'cancelled', 'AbortError during resume with aborted signal is cancelled');
  assert.equal(result.coverage.cancelled, true, 'coverage.cancelled is true for 1-case cancel during resume');
  assert.equal(result.coverage.reasons.includes('cancelled'), true);
  assert.equal(result.cases.length, 1);
}

{
  const ac = new AbortController();
  const adapter = {
    async launch() { ac.abort(new Error('user stop')); },
    async resume() { throw new Error('generic rejection after abort'); },
  };
  const result = await verifyWith(adapter, 1, { signal: ac.signal });
  assert.equal(result.cases[0].observation.stop.kind, 'cancelled', 'arbitrary reject with aborted signal is cancelled by signal state');
  assert.equal(result.coverage.cancelled, true, 'abort(reason) cancel sets coverage.cancelled');
}

{
  const ac = new AbortController();
  const adapter = {
    async launch() {},
    async resume() { throw new Error('boom'); },
  };
  const result = await verifyWith(adapter, 1, { signal: ac.signal });
  assert.equal(result.cases[0].observation.stop.kind, 'exception', 'non-cancel exception with live signal stays exception');
  assert.equal(result.coverage.cancelled, false, 'live signal exceptions never set cancelled');
}

{
  const adapter = {
    async launch() {},
    async resume() { const e = new Error('adapter cancelled'); e.code = 'cancelled'; throw e; },
  };
  const result = await verifyWith(adapter, 1);
  assert.equal(result.cases[0].observation.stop.kind, 'cancelled', 'typed adapter cancelled error still classifies as cancelled');
  assert.equal(result.coverage.cancelled, true);
}

{
  const ac = new AbortController();
  const adapter = abortingAdapter(ac, 'resume');
  const result = await verifyWith(adapter, 3, { signal: ac.signal });
  assert.equal(adapter.launches.count, 1, 'mid-run cancel stops before the next case');
  assert.equal(result.cases.length, 1, 'no extra case results after cancel');
  assert.equal(result.coverage.cancelled, true);
  assert.equal(result.coverage.executed, 1);
  assert.equal(result.coverage.truncated, true);
}

console.log('issue #4933 HypothesisVerifier mid-await AbortSignal cancel classification regression: PASS');
