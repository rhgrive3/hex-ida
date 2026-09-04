import assert from 'node:assert/strict';
import { createAppAnalysisQueryAdapter } from '../../js/analysis/query/product-adapter.js';

function cancellablePending() {
  let cancelCount = 0;
  const promise = new Promise(() => {});
  promise.cancel = () => { cancelCount++; };
  return { promise, get cancelCount() { return cancelCount; } };
}

{
  const controller = new AbortController();
  const seen = [];
  const callers = [0x2000n];
  callers.complete = true;
  const app = {
    ensureProgram: async (options) => {
      seen.push(options);
      return { callersOf: () => callers };
    },
    backend: {},
  };
  const adapter = createAppAnalysisQueryAdapter(app);
  const onProgress = () => {};
  const result = await adapter.callers(null, '0x1000', {}, { signal: controller.signal, onProgress });
  assert.equal(result.status.completeness, 'complete');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].signal, controller.signal, 'program producer must receive the query AbortSignal');
  assert.equal(seen[0].onProgress, onProgress, 'progress callback must be preserved while forwarding cancellation');
}

{
  const controller = new AbortController();
  controller.abort(new DOMException('pre-aborted', 'AbortError'));
  let starts = 0;
  const app = {
    backend: {
      search() {
        starts++;
        return Promise.resolve({ results: [] });
      },
    },
  };
  const adapter = createAppAnalysisQueryAdapter(app);
  await assert.rejects(
    adapter.search(null, { text: 'needle' }, {}, { signal: controller.signal }),
    (error) => error?.name === 'AbortError',
  );
  assert.equal(starts, 0, 'pre-aborted search must not start backend work');
}

{
  const controller = new AbortController();
  const request = cancellablePending();
  const app = { backend: { search: () => request.promise } };
  const adapter = createAppAnalysisQueryAdapter(app);
  const pending = adapter.search(null, { text: 'needle' }, {}, { signal: controller.signal });
  controller.abort(new DOMException('cancelled', 'AbortError'));
  await assert.rejects(pending, (error) => error?.name === 'AbortError');
  assert.equal(request.cancelCount, 1, 'aborting a live query must cancel its backend request');
}

{
  const request = cancellablePending();
  const reason = new DOMException('registration-race', 'AbortError');
  const signal = {
    aborted: false,
    reason,
    addEventListener(type) {
      assert.equal(type, 'abort');
      this.aborted = true;
    },
    removeEventListener() {},
  };
  const app = { backend: { search: () => request.promise } };
  const adapter = createAppAnalysisQueryAdapter(app);
  await assert.rejects(
    adapter.search(null, { text: 'needle' }, {}, { signal }),
    (error) => error === reason,
  );
  assert.equal(request.cancelCount, 1, 'post-registration abort must not orphan the request');
}

{
  const app = {
    backend: {
      search: () => Promise.resolve({ results: [{ addr: 1n }], capped: false, cancelled: false }),
    },
  };
  const adapter = createAppAnalysisQueryAdapter(app);
  const result = await adapter.search(null, { text: 'needle' }, { offset: 0, limit: 10 }, {});
  assert.deepEqual(result.value, [{ addr: 1n }]);
  assert.equal(result.status.completeness, 'complete');
}

console.log('issue-3491 query producer cancellation regression: PASS');
