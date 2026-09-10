import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clearFieldAccessArtifacts,
  fieldAccessRegion,
} from '../../../js/analysis/field-access-artifact.js';

function delayedCancellableRequest(label) {
  let resolve;
  let reject;
  let cancelCount = 0;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.cancel = () => { cancelCount += 1; };
  return {
    label,
    promise,
    resolve,
    reject,
    get cancelCount() { return cancelCount; },
  };
}

function backendHarness() {
  const requests = [];
  return {
    requests,
    backend: {
      analysisEpoch: 0,
      fieldAccess() {
        const request = delayedCancellableRequest(`request-${requests.length + 1}`);
        requests.push(request);
        return request.promise;
      },
    },
  };
}

const REGION = Object.freeze({ id:'text', exec:true, size:0x100n });
const SUCCESS = Object.freeze({ results:[], complete:true });

function abortLike(message = 'cancelled-request') {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

test('last-waiter cancellation retires the entry before a fresh same-key caller arrives', async () => {
  const { backend, requests } = backendHarness();
  const first = new AbortController();
  const pendingA = fieldAccessRegion(backend, REGION, 0x20n, 8, { signal:first.signal });

  assert.equal(requests.length, 1);
  first.abort('first-consumer-left');
  await assert.rejects(pendingA, (error) => error?.name === 'AbortError');
  assert.equal(requests[0].cancelCount, 1);

  const pendingB = fieldAccessRegion(backend, REGION, 0x20n, 8);
  pendingB.catch(() => {});
  assert.equal(requests.length, 2, 'fresh caller must not join the cancelled request');

  requests[1].resolve(SUCCESS);
  assert.equal((await pendingB).complete, true);
  requests[0].reject(abortLike());
  await new Promise((resolve) => setImmediate(resolve));
  clearFieldAccessArtifacts(backend);
});

test('late cleanup from a retired request cannot delete its replacement entry', async () => {
  const { backend, requests } = backendHarness();
  const first = new AbortController();
  const pendingA = fieldAccessRegion(backend, REGION, 0x20n, 8, { signal:first.signal });
  first.abort('first-consumer-left');
  await assert.rejects(pendingA, (error) => error?.name === 'AbortError');

  const pendingB = fieldAccessRegion(backend, REGION, 0x20n, 8);
  pendingB.catch(() => {});
  assert.equal(requests.length, 2);

  requests[0].reject(abortLike('old-request-settled-late'));
  await new Promise((resolve) => setImmediate(resolve));

  const pendingC = fieldAccessRegion(backend, REGION, 0x20n, 8);
  pendingC.catch(() => {});
  assert.equal(requests.length, 2, 'old cleanup must not evict the replacement request');

  requests[1].resolve(SUCCESS);
  assert.equal((await pendingB).complete, true);
  assert.equal((await pendingC).complete, true);
  clearFieldAccessArtifacts(backend);
});

test('one departing waiter does not retire or cancel a producer still shared by another waiter', async () => {
  const { backend, requests } = backendHarness();
  const first = new AbortController();
  const second = new AbortController();
  const pendingA = fieldAccessRegion(backend, REGION, 0x20n, 8, { signal:first.signal });
  const pendingB = fieldAccessRegion(backend, REGION, 0x20n, 8, { signal:second.signal });

  assert.equal(requests.length, 1, 'active callers should still single-flight');
  first.abort('first-consumer-left');
  await assert.rejects(pendingA, (error) => error?.name === 'AbortError');
  assert.equal(requests[0].cancelCount, 0);

  requests[0].resolve(SUCCESS);
  assert.equal((await pendingB).complete, true);
  assert.equal(requests[0].cancelCount, 0);
  clearFieldAccessArtifacts(backend);
});

test('retirement happens before cancel so a reentrant fresh caller cannot observe the old entry', async () => {
  const requests = [];
  let reentrant = null;
  const backend = {
    analysisEpoch: 0,
    fieldAccess() {
      const request = delayedCancellableRequest(`request-${requests.length + 1}`);
      requests.push(request);
      if (requests.length === 1) {
        request.promise.cancel = () => {
          reentrant = fieldAccessRegion(backend, REGION, 0x20n, 8);
          reentrant.catch(() => {});
        };
      }
      return request.promise;
    },
  };
  const controller = new AbortController();
  const pending = fieldAccessRegion(backend, REGION, 0x20n, 8, { signal:controller.signal });
  controller.abort('first-consumer-left');
  await assert.rejects(pending, (error) => error?.name === 'AbortError');

  assert.equal(requests.length, 2, 'cancel-time reentrant caller must create a replacement producer');
  requests[1].resolve(SUCCESS);
  assert.equal((await reentrant).complete, true);
  requests[0].reject(abortLike());
  await new Promise((resolve) => setImmediate(resolve));
  clearFieldAccessArtifacts(backend);
});
