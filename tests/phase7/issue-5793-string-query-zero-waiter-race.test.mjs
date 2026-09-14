import test from 'node:test';
import assert from 'node:assert/strict';
import { createProductSurfaceQueries } from '../../js/analysis/query/product-surface.js';
import { createAnalysisSnapshot } from '../../js/analysis/query/snapshot.js';

// #5793: the canonical Product string query checked the consumer signal in the
// outer loop, then started the backend request and registered it as
// state.inFlight before any waiter owned it. An abort landing during the
// producer-start window left a zero-waiter backend request nobody could
// cancel, and waitForShared's pre-aborted path returned without cancelling the
// producer.

const SNAPSHOT = createAnalysisSnapshot({ binaryId:'bin-5793' });

function stringApp({ abortInFactory = false } = {}) {
  let cancelled = 0;
  const controller = new AbortController();
  const regions = [{ id:'r1', section:'__cstring', size:64n }];
  const app = {
    analysisQueries:{ snapshot:async () => SNAPSHOT },
    backend:{
      gen:1,
      strings() {
        if (abortInFactory) controller.abort('cancel-during-producer-start');
        const request = new Promise(() => { /* never settles on its own */ });
        request.cancel = () => { cancelled++; };
        return request;
      },
    },
    store:{ get:(key) => (key === 'regions' ? regions : key === 'currentRegion' ? regions[0] : key === 'sliceIndex' ? 0 : null) },
  };
  return { app, cancelled:() => cancelled, controller };
}

test('an abort during producer start cancels the zero-waiter backend request (#5793)', async () => {
  const { app, cancelled, controller } = stringApp({ abortInFactory:true });
  const query = createProductSurfaceQueries(app);
  await assert.rejects(
    query.strings(SNAPSHOT, { text:'x' }, { offset:0, limit:1 }, { signal:controller.signal }),
    (error) => error?.name === 'AbortError',
  );
  assert.ok(cancelled() >= 1, 'the just-started backend request must be cancelled (#5793)');
});

test('an abort after attach cancels the shared producer when the last waiter leaves (#5793)', async () => {
  const { app, cancelled, controller } = stringApp();
  const query = createProductSurfaceQueries(app);
  const pending = query.strings(SNAPSHOT, { text:'x' }, { offset:0, limit:1 }, { signal:controller.signal });
  // Let the scan actually start, then abort: the only waiter detaches and
  // must cancel the in-flight producer.
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort('cancel-after-attach');
  await assert.rejects(pending, (error) => error?.name === 'AbortError');
  assert.ok(cancelled() >= 1, 'the shared producer must be cancelled when its only waiter aborts');
});
