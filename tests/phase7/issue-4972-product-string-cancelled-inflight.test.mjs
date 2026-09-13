import test from 'node:test';
import assert from 'node:assert/strict';
import { createProductSurfaceQueries } from '../../js/analysis/query/product-surface.js';
import { createAnalysisSnapshot } from '../../js/analysis/query/snapshot.js';

const SNAPSHOT = createAnalysisSnapshot({ binaryId:'bin-4972' });

function abortError(message = 'aborted') {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function deferredRequest() {
  let resolve;
  let reject;
  let cancelCount = 0;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.cancel = () => { cancelCount++; };
  return { promise, resolve, reject, cancelCount:() => cancelCount };
}

function productApp(requests) {
  let calls = 0;
  const regions = [{ id:'r1', section:'__cstring', size:64n }];
  const app = {
    analysisQueries:{ snapshot:async () => SNAPSHOT },
    backend:{
      gen:1,
      strings() {
        const request = requests[calls];
        calls++;
        if (!request) throw new Error(`unexpected-string-producer-${calls}`);
        return request.promise;
      },
    },
    store:{ get:(key) => (key === 'regions' ? regions : key === 'currentRegion' ? regions[0] : key === 'sliceIndex' ? 0 : null) },
  };
  return { app, calls:() => calls };
}

async function waitFor(predicate, message, timeoutMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function completeResult(text = 'needle') {
  return {
    complete:true,
    capped:false,
    scannedBytes:16,
    results:[{ addr:0x1000n, text }],
  };
}

test('one of two string consumers can abort without cancelling their shared producer (#4972)', async () => {
  const first = deferredRequest();
  const { app, calls } = productApp([first]);
  const query = createProductSurfaceQueries(app);
  const aController = new AbortController();
  const bController = new AbortController();

  const a = query.strings(SNAPSHOT, { text:'needle' }, { offset:0, limit:1 }, { signal:aController.signal });
  const b = query.strings(SNAPSHOT, { text:'needle' }, { offset:0, limit:1 }, { signal:bController.signal });
  await waitFor(() => calls() === 1, 'shared string producer did not start');
  await new Promise((resolve) => setImmediate(resolve));

  aController.abort('consumer-a-done');
  await assert.rejects(a, (error) => error?.name === 'AbortError');
  assert.equal(first.cancelCount(), 0, 'one departing waiter must not cancel a producer still owned by another waiter');

  first.resolve(completeResult());
  const result = await b;
  assert.equal(calls(), 1, 'concurrent consumers should stay single-flight');
  assert.equal(result.value.length, 1);
});

test('last-waiter abort retires the cancelled entry before a fresh consumer arrives (#4972)', async () => {
  const first = deferredRequest();
  const second = deferredRequest();
  const { app, calls } = productApp([first, second]);
  const query = createProductSurfaceQueries(app);
  const controller = new AbortController();

  const abandoned = query.strings(SNAPSHOT, { text:'needle' }, { offset:0, limit:1 }, { signal:controller.signal });
  await waitFor(() => calls() === 1, 'first string producer did not start');
  controller.abort('replace-query');
  await assert.rejects(abandoned, (error) => error?.name === 'AbortError');
  assert.equal(first.cancelCount(), 1, 'the last departing waiter must cancel its producer exactly once');

  const fresh = query.strings(SNAPSHOT, { text:'needle' }, { offset:0, limit:1 });
  await waitFor(
    () => calls() === 2,
    'a fresh consumer reused the already-cancelled in-flight producer instead of starting a new one',
  );

  // The cancelled producer settles after the replacement producer is already
  // registered. Its finally block must not clear the replacement entry.
  first.reject(abortError('old-producer-cancelled'));
  await new Promise((resolve) => setImmediate(resolve));

  const alsoFresh = query.strings(SNAPSHOT, { text:'needle' }, { offset:0, limit:1 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls(), 2, 'old producer cleanup must not clear the replacement in-flight entry');

  second.resolve(completeResult());
  const [freshResult, sharedResult] = await Promise.all([fresh, alsoFresh]);
  assert.equal(freshResult.value.length, 1, 'old producer rejection must not propagate into the fresh consumer');
  assert.equal(sharedResult.value.length, 1, 'replacement producer should remain shareable');
});
