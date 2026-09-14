// Issue #4899 regression: baseline function discovery requestWithSignal()
// checked signal.aborted before registering the abort listener and never
// re-checked after subscription, so an abort landing inside the
// check -> subscribe window was dropped and guessFunctions() results were
// still adopted into symbols.
import assert from 'node:assert/strict';
import test from 'node:test';

import { __symmetricWorkspaceInternalsForTests } from '../js/diff/symmetric-workspace-runtime.js';

const { discoverBaselineFunctions } = __symmetricWorkspaceInternalsForTests;

function raceSignal(deliverDuringSubscribe = false) {
  let aborted = false;
  let removals = 0;
  return {
    signal: {
      get aborted() { return aborted; },
      reason: new Error('cancelled'),
      addEventListener(type, listener) {
        assert.equal(type, 'abort');
        aborted = true;
        if (deliverDuringSubscribe) listener();
      },
      removeEventListener(type) {
        assert.equal(type, 'abort');
        removals++;
      },
    },
    get removals() { return removals; },
  };
}

function preAbortedSignal() {
  return { aborted: true, reason: new Error('cancelled'), addEventListener() {}, removeEventListener() {} };
}

function freshSymbols() {
  return {
    funcs: [],
    functionCount: 0,
    functionStartsComplete: false,
    addFunctions(starts) { this.funcs.push(...starts); this.functionCount += starts.length; return starts.length; },
  };
}

function freshBaseline(symbols, guessFunctions) {
  return {
    symbols,
    slice: { regions: [{ id: 'text', exec: true, zerofill: false, vmAddr: 0n, size: 4n }] },
    backend: { guessFunctions },
  };
}

const STARTS = [0n];

test('#4899 subscribe-window abort rejects and does not adopt discovery results', async () => {
  const race = raceSignal();
  const symbols = freshSymbols();
  let cancelled = 0;
  let requested = 0;
  const baseline = freshBaseline(symbols, () => {
    requested++;
    const request = Promise.resolve({ starts: STARTS, discoveryComplete: true });
    request.cancel = () => { cancelled++; };
    return request;
  });
  await assert.rejects(() => discoverBaselineFunctions(baseline, { signal: race.signal }),
    (err) => err.name === 'AbortError');
  assert.equal(requested, 1, 'the request itself is still issued before the race is noticed');
  assert.equal(cancelled, 1, 'the in-flight request must be cancelled on the subscribe race');
  assert.deepEqual(symbols.funcs, [], 'aborted discovery must not mutate symbols');
  assert.notEqual(symbols.functionStartsComplete, true);
});

test('#4899 abort delivered synchronously during subscribe does not double-settle', async () => {
  const race = raceSignal(true);
  const symbols = freshSymbols();
  let cancelled = 0;
  const baseline = freshBaseline(symbols, () => {
    const request = Promise.resolve({ starts: STARTS, discoveryComplete: true });
    request.cancel = () => { cancelled++; };
    return request;
  });
  await assert.rejects(() => discoverBaselineFunctions(baseline, { signal: race.signal }),
    (err) => err.name === 'AbortError');
  assert.equal(cancelled, 1);
  assert.deepEqual(symbols.funcs, []);
});

test('#4899 pre-aborted signal stops before any backend request', async () => {
  const symbols = freshSymbols();
  let requested = 0;
  const baseline = freshBaseline(symbols, () => { requested++; return Promise.resolve({ starts: STARTS }); });
  await assert.rejects(() => discoverBaselineFunctions(baseline, { signal: preAbortedSignal() }),
    (err) => err.name === 'AbortError');
  assert.equal(requested, 0);
  assert.deepEqual(symbols.funcs, []);
});

test('#4899 discovery without abort still completes normally', async () => {
  const symbols = freshSymbols();
  const baseline = freshBaseline(symbols, () => Promise.resolve({ starts: STARTS, discoveryComplete: true }));
  const out = await discoverBaselineFunctions(baseline, {});
  assert.equal(out, symbols);
  assert.deepEqual(symbols.funcs, STARTS);
  assert.equal(symbols.functionDiscovery.complete, true);
});

test('#4899 request failure keeps the incomplete accounting', async () => {
  const symbols = freshSymbols();
  const baseline = freshBaseline(symbols, () => Promise.reject(new Error('backend-boom')));
  await discoverBaselineFunctions(baseline, {});
  assert.equal(symbols.functionDiscovery.complete, false);
  assert.deepEqual(symbols.funcs, []);
  assert.ok(symbols.functionDiscovery.reasons.some((r) => /function-discovery-failed/.test(r)));
});
