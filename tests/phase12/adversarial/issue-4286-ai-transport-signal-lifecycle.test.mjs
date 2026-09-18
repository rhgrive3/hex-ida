import assert from 'node:assert/strict';
import { requestJSON } from '../../../js/ai/transport.js';
import { AIError } from '../../../js/ai/schema.js';

const successResponse = () => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  async text() { return '{"ok":true}'; },
});

async function withTimerProbe(run) {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let created = 0;
  let cleared = 0;
  const active = new Set();
  globalThis.setTimeout = () => {
    created += 1;
    const token = { id: created };
    active.add(token);
    return token;
  };
  globalThis.clearTimeout = (token) => {
    cleared += 1;
    active.delete(token);
  };
  try {
    await run({
      get created() { return created; },
      get cleared() { return cleared; },
      get active() { return active.size; },
    });
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
}

async function expectSignalError(signal, extra = {}) {
  let fetchCalls = 0;
  await assert.rejects(
    requestJSON('/turn', {}, {
      signal,
      timeoutMs: 60_000,
      fetchImpl: async () => {
        fetchCalls += 1;
        return successResponse();
      },
      ...extra,
    }),
    (error) => error instanceof AIError
      && error.type === 'provider_error'
      && /AbortSignal-compatible/.test(error.message),
  );
  assert.equal(fetchCalls, 0, 'malformed signal must fail before transport I/O');
}

await withTimerProbe(async (timers) => {
  await expectSignalError({});
  assert.equal(timers.created, 0, 'invalid signal shape must fail before allocating a timeout');
  assert.equal(timers.active, 0);
});

for (const signal of [
  true,
  42,
  'signal',
  { aborted: true },
  {
    get aborted() { throw new Error('aborted-getter-boom'); },
    addEventListener() {},
    removeEventListener() {},
  },
]) {
  await withTimerProbe(async (timers) => {
    await expectSignalError(signal);
    assert.equal(timers.created, 0, 'malformed signal must fail before timeout allocation');
    assert.equal(timers.active, 0);
  });
}

await withTimerProbe(async (timers) => {
  let addCalls = 0;
  await expectSignalError({
    aborted: false,
    addEventListener() { addCalls += 1; },
  });
  assert.equal(addCalls, 0, 'missing cleanup support must be rejected before listener registration');
  assert.equal(timers.created, 0);
  assert.equal(timers.active, 0);
});

await withTimerProbe(async (timers) => {
  let addCalls = 0;
  let removeCalls = 0;
  await expectSignalError({
    aborted: false,
    addEventListener() {
      addCalls += 1;
      throw new Error('listener-setup-boom');
    },
    removeEventListener() { removeCalls += 1; },
  });
  assert.equal(addCalls, 1);
  assert.equal(removeCalls, 1, 'failed listener setup must attempt rollback');
  assert.equal(timers.created, 0, 'timeout allocation must happen only after listener setup succeeds');
  assert.equal(timers.active, 0);
});

await withTimerProbe(async (timers) => {
  let removeCalls = 0;
  const payload = await requestJSON('/turn', {}, {
    signal: {
      aborted: false,
      addEventListener() {},
      removeEventListener() {
        removeCalls += 1;
        throw new Error('cleanup-boom');
      },
    },
    timeoutMs: 60_000,
    fetchImpl: async () => successResponse(),
  });
  assert.deepEqual(payload, { ok: true }, 'cleanup failure must not overwrite a successful provider result');
  assert.equal(removeCalls, 1);
  assert.equal(timers.created, 1);
  assert.equal(timers.cleared, 1);
  assert.equal(timers.active, 0);
});

await withTimerProbe(async (timers) => {
  const upstream = new Error('upstream-failed');
  await assert.rejects(
    requestJSON('/turn', {}, {
      signal: {
        aborted: false,
        addEventListener() {},
        removeEventListener() { throw new Error('cleanup-boom'); },
      },
      timeoutMs: 60_000,
      fetchImpl: async () => { throw upstream; },
    }),
    (error) => error instanceof AIError
      && error.type === 'provider_error'
      && error.message === 'upstream-failed',
    'cleanup failure must not overwrite the transport/provider failure',
  );
  assert.equal(timers.created, 1);
  assert.equal(timers.cleared, 1);
  assert.equal(timers.active, 0);
});

await withTimerProbe(async (timers) => {
  let listener = null;
  let resolveFetch = null;
  let fetchSignal = null;
  const hostileSignal = {
    aborted: false,
    get reason() { throw new Error('reason-getter-boom'); },
    addEventListener(type, callback) {
      if (type === 'abort') listener = callback;
    },
    removeEventListener() {},
  };
  const pending = requestJSON('/turn', {}, {
    signal: hostileSignal,
    timeoutMs: 60_000,
    fetchImpl: async (_url, options) => {
      fetchSignal = options.signal;
      return await new Promise((resolve) => { resolveFetch = () => resolve(successResponse()); });
    },
  });
  await Promise.resolve();
  assert.equal(typeof listener, 'function', 'external abort listener must be registered before transport I/O settles');
  hostileSignal.aborted = true;
  assert.doesNotThrow(() => listener(), 'throwing reason getter must not escape the abort listener');
  assert.equal(fetchSignal?.aborted, true, 'inner controller must abort even when external reason cannot be read');
  resolveFetch();
  await assert.rejects(
    pending,
    (error) => error instanceof AIError && error.type === 'cancelled' && !/reason-getter-boom/.test(error.message),
    'a transport that ignores its signal still must not return success after external cancellation',
  );
  assert.equal(timers.created, 1);
  assert.equal(timers.cleared, 1);
  assert.equal(timers.active, 0);
});

await withTimerProbe(async (timers) => {
  const preAborted = {
    aborted: true,
    get reason() { throw new Error('pre-abort-reason-boom'); },
    addEventListener() {},
    removeEventListener() {},
  };
  await assert.rejects(
    requestJSON('/turn', {}, { signal: preAborted, fetchImpl: async () => successResponse() }),
    (error) => error instanceof AIError && error.type === 'cancelled' && !/pre-abort-reason-boom/.test(error.message),
    'pre-aborted hostile reason must fall back to canonical cancellation',
  );
  assert.equal(timers.created, 0, 'pre-aborted requests must still fail before timeout allocation');
});

{
  const controller = new AbortController();
  let fetchSignal = null;
  const pending = requestJSON('/turn', {}, {
    signal: controller.signal,
    timeoutMs: 60_000,
    fetchImpl: async (_url, options) => {
      fetchSignal = options.signal;
      return await new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('inner-aborted')), { once: true });
      });
    },
  });
  controller.abort('cancelled');
  await assert.rejects(pending, (error) => error instanceof AIError && error.type === 'cancelled');
  assert.equal(fetchSignal?.aborted, true, 'real external cancellation must still reach the transport controller');
}

console.log('issue #4286 AI transport signal lifecycle regressions passed');
