import test from 'node:test';
import assert from 'node:assert/strict';
import { VariableInstructionIndex } from '../js/viewer/variable-instruction-index.js';

const BASE = 0x4000n;

function decodeResponse(address, length) {
  const instructions = [];
  for (let i = 0; i < length; i++) {
    instructions.push({
      address: address + BigInt(i), length: 1, rawBytes: Uint8Array.of(0x90), mnemonic: 'nop', opStr: '',
    });
  }
  return { supported: true, instructions, bytesRead: length };
}

function harness() {
  const gates = [];
  const index = new VariableInstructionIndex({
    pageBytes: 32, overlapBytes: 0, maxPrefetchPages: 0,
    disassembleAt: (address, { length, signal }) => new Promise((resolve, reject) => {
      const onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
      gates.push({ address: BigInt(address), length, resolve, reject, signal });
    }),
  });
  index.configureRegion({ id: 'issue-4988', vmAddr: BASE, size: 128n });
  return { index, gates };
}

function trackedSignal() {
  const controller = new AbortController();
  const state = { added: 0, removed: 0 };
  const listeners = new Map();
  const signal = {
    get aborted() { return controller.signal.aborted; },
    get reason() { return controller.signal.reason; },
    addEventListener(type, listener, options) {
      if (type !== 'abort') return;
      state.added++;
      listeners.set(listener, options);
      controller.signal.addEventListener(type, () => listener(), options);
    },
    removeEventListener(type, listener) {
      if (type !== 'abort' || !listeners.has(listener)) return;
      state.removed++;
      listeners.delete(listener);
    },
    abort: (reason) => controller.abort(reason),
  };
  return { signal, state };
}

const isAbortError = (error) => error?.name === 'AbortError';

test('#4988 first consumer abort leaves the surviving shared consumer decoded', async () => {
  const { index, gates } = harness();
  const a = new AbortController();
  const b = new AbortController();
  const first = index.ensurePage(BASE, { signal: a.signal });
  const second = index.ensurePage(BASE, { signal: b.signal });
  assert.equal(gates.length, 1, 'same page must stay single-flight');
  a.abort();
  await assert.rejects(first, isAbortError);
  assert.equal(gates[0].signal.aborted, false, 'shared producer must survive the first consumer abort');
  gates[0].resolve(decodeResponse(BASE, 32));
  const page = await second;
  assert.equal(page.start, BASE);
  assert.equal(page.entries.length, 32);
  assert.equal(index.metrics().decodeRequestCount, 1);
  assert.equal(index.metrics().cancelledRequests, 0);
});

test('#4988 second consumer abort leaves the producer-creating consumer decoded', async () => {
  const { index, gates } = harness();
  const a = new AbortController();
  const b = new AbortController();
  const first = index.ensurePage(BASE, { signal: a.signal });
  const second = index.ensurePage(BASE, { signal: b.signal });
  b.abort();
  await assert.rejects(second, isAbortError);
  assert.equal(gates[0].signal.aborted, false);
  gates[0].resolve(decodeResponse(BASE, 32));
  const page = await first;
  assert.equal(page.entries.length, 32);
  assert.equal(index.metrics().cancelledRequests, 0);
});

test('#4988 a signal-less joiner is not collateral damage of a signalling consumer abort', async () => {
  const { index, gates } = harness();
  const a = new AbortController();
  const first = index.ensurePage(BASE, { signal: a.signal });
  const second = index.ensurePage(BASE);
  a.abort();
  await assert.rejects(first, isAbortError);
  gates[0].resolve(decodeResponse(BASE, 32));
  assert.equal((await second).entries.length, 32);
});

test('#4988 last consumer abort cancels the shared producer exactly once', async () => {
  const { index, gates } = harness();
  const a = new AbortController();
  const b = new AbortController();
  const first = index.ensurePage(BASE, { signal: a.signal });
  const second = index.ensurePage(BASE, { signal: b.signal });
  a.abort();
  await assert.rejects(first, isAbortError);
  assert.equal(gates[0].signal.aborted, false);
  b.abort();
  await assert.rejects(second, isAbortError);
  assert.equal(gates[0].signal.aborted, true, 'producer must be cancelled once no consumer remains');
  assert.equal(index.metrics().cancelledRequests, 1);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(index.inflight.size, 0);
});

test('#4988 sole consumer abort still cancels its producer resource', async () => {
  const { index, gates } = harness();
  const a = new AbortController();
  const only = index.ensurePage(BASE, { signal: a.signal });
  a.abort();
  await assert.rejects(only, isAbortError);
  assert.equal(gates[0].signal.aborted, true);
  assert.equal(index.metrics().cancelledRequests, 1);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(index.inflight.size, 0);
});

test('#4988 consumer abort listeners are released when the shared producer settles', async () => {
  const { index, gates } = harness();
  const a = trackedSignal();
  const b = trackedSignal();
  const first = index.ensurePage(BASE, { signal: a.signal });
  const second = index.ensurePage(BASE, { signal: b.signal });
  gates[0].resolve(decodeResponse(BASE, 32));
  await Promise.all([first, second]);
  assert.equal(a.state.removed, a.state.added, 'creator listener accounting must close');
  assert.ok(a.state.added >= 1);
  assert.equal(b.state.removed, b.state.added, 'joiner listener accounting must close');
  assert.ok(b.state.added >= 1);
});

test('#4988 cancelAll stops a shared producer that still has live consumers', async () => {
  const { index, gates } = harness();
  const a = new AbortController();
  const b = new AbortController();
  const first = index.ensurePage(BASE, { signal: a.signal });
  const second = index.ensurePage(BASE, { signal: b.signal });
  index.cancelAll('viewer-reset');
  const results = await Promise.all([first.catch((error) => error), second.catch((error) => error)]);
  for (const result of results) assert.equal(result.name, 'AbortError');
  assert.equal(gates[0].signal.aborted, true);
  assert.equal(index.metrics().cancelledRequests, 1);
});

test('#4988 cancelExcept stops non-target shared producers with live consumers', async () => {
  const { index, gates } = harness();
  const a = new AbortController();
  const c = new AbortController();
  const keep = index.ensurePage(BASE, { signal: a.signal });
  const discard = index.ensurePage(BASE + 32n, { signal: c.signal });
  assert.equal(gates.length, 2);
  index.cancelExcept([BASE]);
  gates[0].resolve(decodeResponse(BASE, 32));
  assert.equal((await keep).entries.length, 32);
  await assert.rejects(discard, isAbortError);
  assert.equal(gates[1].signal.aborted, true);
  assert.equal(gates[0].signal.aborted, false);
});

test('#4988 region change during a shared decode keeps the stale-result guard', async () => {
  const { index, gates } = harness();
  const a = new AbortController();
  const b = new AbortController();
  const first = index.ensurePage(BASE, { signal: a.signal });
  const second = index.ensurePage(BASE, { signal: b.signal });
  index.configureRegion({ id: 'replaced', vmAddr: BASE + 0x1000n, size: 128n });
  const results = await Promise.all([first.catch((error) => error), second.catch((error) => error)]);
  for (const result of results) {
    assert.ok(result?.name === 'AbortError' || result?.stale === true, JSON.stringify(result?.name ?? result?.status));
  }
  gates[0].resolve(decodeResponse(BASE, 32));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(index.metrics().retainedPages, 0, 'discarded generation must not publish');
  assert.equal(index.inflight.size, 0);
});

test('#4988 same-page single-flight is preserved for surviving consumers', async () => {
  const { index, gates } = harness();
  const controllers = [new AbortController(), new AbortController(), new AbortController()];
  const waits = controllers.map((controller) => index.ensurePage(BASE, { signal: controller.signal }));
  assert.equal(gates.length, 1);
  controllers[0].abort();
  await assert.rejects(waits[0], isAbortError);
  assert.equal(gates.length, 1);
  gates[0].resolve(decodeResponse(BASE, 32));
  const pages = await Promise.all(waits.slice(1));
  assert.equal(pages[0], pages[1]);
  assert.equal(index.metrics().decodeRequestCount, 1);
});
