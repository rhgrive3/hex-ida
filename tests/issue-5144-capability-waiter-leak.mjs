import assert from 'node:assert/strict';
import { WorkerAIProvider } from '../js/ai/provider/index.js';

function pendingProvider() {
  let fetchSignal = null;
  const provider = new WorkerAIProvider({
    fetchImpl: async (_url, init) => {
      fetchSignal = init.signal;
      return await new Promise(() => {});
    },
  });
  return { provider, signalOf: () => fetchSignal };
}

// A malformed (non-AbortSignal) truthy signal must not leak a waiter.
{
  const { provider } = pendingProvider();
  await assert.rejects(
    () => provider.prepareCapabilities({ signal: { aborted: false } }),
    'a malformed signal must be rejected',
  );
  assert.equal(provider.capabilitiesWaiters, 0, 'no ghost waiter may remain');
  // A later legitimate consumer can still cancel the shared preflight.
  const controller = new AbortController();
  const pending = provider.prepareCapabilities({ signal: controller.signal });
  controller.abort('cancelled');
  await assert.rejects(() => pending, (error) => error?.type === 'cancelled');
  assert.equal(provider.capabilitiesWaiters, 0);
}

// Missing listener methods must also fail fast without state change.
{
  const { provider } = pendingProvider();
  await assert.rejects(() => provider.prepareCapabilities({ signal: { aborted: false, addEventListener() {} } }));
  assert.equal(provider.capabilitiesWaiters, 0);
}

// Valid signals keep working: join + cancel aborts the shared producer.
{
  const { provider, signalOf } = pendingProvider();
  const controller = new AbortController();
  const pending = provider.prepareCapabilities({ signal: controller.signal });
  assert.equal(provider.capabilitiesWaiters, 1);
  controller.abort('cancelled');
  await assert.rejects(() => pending, (error) => error?.type === 'cancelled');
  assert.equal(provider.capabilitiesWaiters, 0);
  assert.equal(signalOf().aborted, true, 'the last cancelling consumer aborts the shared fetch');
}

console.log('issue-5144-capability-waiter-leak: ok');
