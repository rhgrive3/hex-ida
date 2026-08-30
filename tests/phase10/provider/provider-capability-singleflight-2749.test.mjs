import assert from 'node:assert/strict';
import test from 'node:test';

import { WorkerAIProvider } from '../../../js/ai/provider/index.js';

function deferredCapabilitiesFetch() {
  let calls = 0;
  let resolveFetch;
  let aborted = false;
  const fetchImpl = (_url, { signal } = {}) => {
    calls += 1;
    return new Promise((resolve, reject) => {
      resolveFetch = () => resolve({
        ok: true,
        async text() {
          return JSON.stringify({ capabilities: { provider: 'test', maxTools: 17 } });
        },
      });
      signal?.addEventListener('abort', () => {
        aborted = true;
        reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    });
  };
  return {
    fetchImpl,
    get calls() { return calls; },
    get aborted() { return aborted; },
    resolve() { resolveFetch?.(); },
  };
}

async function rejectsCancelled(promise) {
  await assert.rejects(promise, (error) => error?.code === 'cancelled');
}

test('issue #2749: one aborted consumer does not cancel a shared capability preflight', async () => {
  const fetch = deferredCapabilitiesFetch();
  const provider = new WorkerAIProvider({ fetchImpl: fetch.fetchImpl });
  const a = new AbortController();
  const b = new AbortController();

  const first = provider.prepareCapabilities({ signal: a.signal });
  const second = provider.prepareCapabilities({ signal: b.signal });
  assert.equal(fetch.calls, 1);

  a.abort('caller-a-cancelled');
  await rejectsCancelled(first);
  assert.equal(fetch.aborted, false);

  fetch.resolve();
  const capabilities = await second;
  assert.equal(capabilities.provider, 'test');
  assert.equal(capabilities.maxTools, 17);
  assert.equal(fetch.calls, 1);
});

test('issue #2749: shared capability work is aborted when every consumer cancels', async () => {
  const fetch = deferredCapabilitiesFetch();
  const provider = new WorkerAIProvider({ fetchImpl: fetch.fetchImpl });
  const a = new AbortController();
  const b = new AbortController();

  const first = provider.prepareCapabilities({ signal: a.signal });
  const second = provider.prepareCapabilities({ signal: b.signal });
  assert.equal(fetch.calls, 1);

  a.abort('caller-a-cancelled');
  await rejectsCancelled(first);
  assert.equal(fetch.aborted, false);

  b.abort('caller-b-cancelled');
  await rejectsCancelled(second);
  assert.equal(fetch.aborted, true);
});

test('issue #2749: provider cancellation still terminates the shared capability preflight', async () => {
  const fetch = deferredCapabilitiesFetch();
  const provider = new WorkerAIProvider({ fetchImpl: fetch.fetchImpl });

  const first = provider.prepareCapabilities();
  const second = provider.prepareCapabilities();
  assert.equal(fetch.calls, 1);

  provider.cancel();
  await Promise.all([rejectsCancelled(first), rejectsCancelled(second)]);
  assert.equal(fetch.aborted, true);
});
