import assert from 'node:assert/strict';
import { WorkerAIProvider } from '../js/ai/provider/index.js';

testMalformedSignalThrowsBeforeAccounting();
await testGhostFreeCancellationSurvivesMalformedSignal();
await testValidSignalsKeepWorking();
console.log('issue #5144 malformed signal waiter leak: ok');

/* #5144: a truthy non-AbortSignal must fail closed BEFORE the waiter is
   accounted, leaving capabilitiesWaiters at 0. */
function testMalformedSignalThrowsBeforeAccounting() {
  const provider = providerWithPendingPreflight();
  assert.rejects(
    () => provider.prepareCapabilities({ signal: { aborted: false } }),
    (error) => error instanceof TypeError && /AbortSignal/.test(error.message),
  );
  assert.equal(provider.capabilitiesWaiters, 0, 'a malformed signal must not leak a waiter');
  assert.rejects(
    () => provider.prepareCapabilities({ signal: true }),
    (error) => error instanceof TypeError,
  );
  assert.equal(provider.capabilitiesWaiters, 0, 'a non-object signal must not leak a waiter');
}

/* The issue's two-step scenario: after any malformed attempt, a legitimate
   consumer must still be able to cancel the shared preflight. */
async function testGhostFreeCancellationSurvivesMalformedSignal() {
  let fetchSignal;
  const provider = new WorkerAIProvider({
    fetchImpl: async (_url, init) => {
      fetchSignal = init && init.signal;
      return await new Promise(() => {});
    },
  });

  await provider.prepareCapabilities({ signal: { aborted: false } }).catch(() => {});
  assert.equal(provider.capabilitiesWaiters, 0, 'no ghost waiter after the malformed attempt');

  const controller = new AbortController();
  const pending = provider.prepareCapabilities({ signal: controller.signal });
  await delay(10);
  assert.equal(provider.capabilitiesWaiters, 1, 'exactly the real consumer is accounted');
  controller.abort('cancelled');
  await assert.rejects(() => pending);
  await delay(10);
  assert.equal(provider.capabilitiesWaiters, 0, 'cancellation must return the waiter count to zero');
  assert.equal(fetchSignal?.aborted, true, 'the shared preflight must be abortable again');
}

/* Valid signal contracts keep their existing semantics. */
async function testValidSignalsKeepWorking() {
  const provider = new WorkerAIProvider({
    fetchImpl: async () => JSON.stringify({ providers: [] }),
  });
  const controller = new AbortController();
  const value = await provider.prepareCapabilities({ signal: controller.signal });
  assert.equal(value.provider, 'worker', 'a valid signal resolves the settled preflight');
  assert.equal(provider.capabilitiesWaiters, 0, 'a settled preflight releases its waiter');

  const fresh = new WorkerAIProvider({
    fetchImpl: async () => JSON.stringify({ providers: [] }),
  });
  const cancelController = new AbortController();
  cancelController.abort();
  await assert.rejects(
    () => fresh.prepareCapabilities({ signal: cancelController.signal }),
  );
  assert.equal(fresh.capabilitiesWaiters, 0, 'a pre-aborted signal releases its waiter');
}

function providerWithPendingPreflight() {
  return new WorkerAIProvider({
    fetchImpl: async () => await new Promise(() => {}),
  });
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
