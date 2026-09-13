import assert from 'node:assert/strict';
import { WorkerAIProvider } from '../js/ai/provider/index.js';

/* #4601: once the last waiter cancels and the shared preflight is aborted, that
   single-flight must be retired synchronously so a later caller starts fresh
   work instead of inheriting an unrelated cancellation. */
await testLateCallerStartsFreshPreflight();
await testLateCallerAfterExplicitCancelStartsFreshPreflight();
await testRemainingWaiterKeepsSharedFlight();
await testAllWaitersCancelAbortsSharedFetch();
await testRetiredFlightFinallyKeepsLiveFlight();
await testTimeoutStillFallsBackToConservativeCapabilities();

console.log('issue #4601 aborted capability flight retire: ok');

function controlledFetch(capabilities = { provider: 'test', maxTools: 17 }) {
  const state = { calls: 0, signals: [], settle: [] };
  const fetchImpl = (_url, { signal } = {}) => {
    state.calls += 1;
    state.signals.push(signal);
    return new Promise((resolve, reject) => {
      state.settle.push({
        succeed() {
          resolve(new Response(JSON.stringify({ capabilities }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }));
        },
        abort() { reject(new DOMException('Aborted', 'AbortError')); },
      });
      signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
  };
  return { fetchImpl, state };
}

function rejectsCancelled(promise) {
  return assert.rejects(promise, (error) => (
    error?.type === 'cancelled' && error?.message === 'AI investigation was cancelled.'
  ));
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function testLateCallerStartsFreshPreflight() {
  const { fetchImpl, state } = controlledFetch();
  const provider = new WorkerAIProvider({ fetchImpl });
  const a = new AbortController();
  const first = provider.prepareCapabilities({ signal: a.signal });
  assert.equal(state.calls, 1, 'the first caller starts the shared preflight');
  a.abort('caller-a-cancelled');
  assert.equal(state.signals[0].aborted, true, 'the shared fetch aborts once every waiter cancels');

  const second = provider.prepareCapabilities();
  assert.equal(state.calls, 2, 'a later caller must not join the aborted single-flight');
  assert.equal(provider.capabilitiesWaiters, 1, 'only the new caller is accounted on the new flight');
  state.settle[0].abort();
  await rejectsCancelled(first);
  state.settle[1].succeed();
  const capabilities = await second;
  assert.equal(capabilities.provider, 'test');
  assert.equal(capabilities.maxTools, 17, 'the new caller gets the fresh preflight result');
  await delay(10);
  assert.equal(provider.capabilitiesWaiters, 0);
}

async function testLateCallerAfterExplicitCancelStartsFreshPreflight() {
  const { fetchImpl, state } = controlledFetch();
  const provider = new WorkerAIProvider({ fetchImpl });
  const a = new AbortController();
  const first = provider.prepareCapabilities({ signal: a.signal });
  const second = provider.prepareCapabilities();
  a.abort('caller-a-cancelled');
  assert.equal(provider.capabilitiesWaiters, 1, 'the uncancelled caller keeps its own waiter slot');
  state.settle[0].succeed();
  await rejectsCancelled(first);
  assert.equal((await second).maxTools, 17, 'the surviving caller is served by the shared flight');
}

async function testRemainingWaiterKeepsSharedFlight() {
  const { fetchImpl, state } = controlledFetch();
  const provider = new WorkerAIProvider({ fetchImpl });
  const a = new AbortController();
  const b = new AbortController();
  const first = provider.prepareCapabilities({ signal: a.signal });
  const second = provider.prepareCapabilities({ signal: b.signal });
  assert.equal(state.calls, 1, 'concurrent callers share one preflight');
  a.abort('caller-a-cancelled');
  await rejectsCancelled(first);
  assert.equal(state.signals[0].aborted, false, 'one cancelled consumer must not cancel shared work');
  b.abort('caller-b-cancelled');
  await rejectsCancelled(second);
  assert.equal(state.signals[0].aborted, true, 'shared work stops after every consumer cancels');
}

async function testAllWaitersCancelAbortsSharedFetch() {
  const { fetchImpl, state } = controlledFetch();
  const provider = new WorkerAIProvider({ fetchImpl });
  const a = new AbortController();
  const first = provider.prepareCapabilities({ signal: a.signal });
  a.abort('caller-a-cancelled');
  await rejectsCancelled(first);
  assert.equal(state.signals[0].aborted, true, 'no waiter means no lingering shared fetch');
  assert.equal(provider.capabilitiesWaiters, 0, 'cancellation returns the waiter count to zero');
  state.settle[0].abort();
  await delay(10);
  assert.equal(provider.capabilitiesPromise, null, 'the settled flight is released');
}

async function testRetiredFlightFinallyKeepsLiveFlight() {
  const { fetchImpl, state } = controlledFetch();
  const provider = new WorkerAIProvider({ fetchImpl });
  const a = new AbortController();
  const first = provider.prepareCapabilities({ signal: a.signal });
  a.abort('caller-a-cancelled');
  const second = provider.prepareCapabilities();
  assert.equal(state.calls, 2);
  const livePromise = provider.capabilitiesPromise;
  assert.ok(livePromise, 'the live flight is published');
  state.settle[0].abort();
  await rejectsCancelled(first);
  await delay(10);
  assert.equal(provider.capabilitiesPromise, livePromise, 'the retired flight finally must not clear the live flight');
  const third = provider.prepareCapabilities();
  assert.equal(state.calls, 2, 'a third caller joins the live flight, not a third fetch');
  state.settle[1].succeed();
  assert.equal((await second).maxTools, 17);
  assert.equal((await third).maxTools, 17);
}

async function testTimeoutStillFallsBackToConservativeCapabilities() {
  const { fetchImpl } = controlledFetch();
  const provider = new WorkerAIProvider({ fetchImpl });
  const pending = provider.prepareCapabilities({ timeoutMs: 10 });
  const capabilities = await pending;
  assert.equal(capabilities.provider, 'worker', 'a timed-out preflight keeps conservative capabilities');
}
