import assert from 'node:assert/strict';
import test from 'node:test';

import { planAnalysisGoal } from '../../../js/query/planner.js';

const EMPTY_QUERY = Object.freeze({
  action: 'read',
  entity: Object.freeze({ terms: Object.freeze([]) }),
  context: Object.freeze({ terms: Object.freeze([]) }),
  event: Object.freeze({ terms: Object.freeze([]) }),
});

async function plan(options = {}) {
  return planAnalysisGoal(EMPTY_QUERY, {}, { tools: {}, timeoutMs: 1_000, ...options });
}

async function rejectsInvalidSignal(signal) {
  let timers = 0;
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (...args) => {
    timers += 1;
    return originalSetTimeout(...args);
  };
  try {
    await assert.rejects(
      plan({ signal }),
      (error) => error instanceof TypeError && error.message === 'query-planner-signal-invalid',
    );
    assert.equal(timers, 0, 'malformed signals must be rejected before planner timeout allocation');
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
}

test('#4640 rejects malformed external signals at the planner boundary before allocating timers', async () => {
  for (const signal of [
    false,
    0,
    '',
    true,
    {},
    { aborted: false, addEventListener() {} },
    { aborted: false, removeEventListener() {} },
    { aborted: false, addEventListener: true, removeEventListener() {} },
    { aborted: false, addEventListener() {}, removeEventListener: true },
  ]) {
    await rejectsInvalidSignal(signal);
  }
});

test('#4640 rolls back listener registration failures without allocating the timeout', async () => {
  let removed = 0;
  const signal = {
    aborted: false,
    addEventListener() { throw new Error('register failed'); },
    removeEventListener() { removed += 1; },
  };

  await rejectsInvalidSignal(signal);
  assert.equal(removed, 1, 'a failed registration must attempt listener rollback');
});

test('#4640 rejects signal accessors that cannot establish AbortSignal compatibility', async () => {
  const signal = {
    get aborted() { throw new Error('untrusted getter'); },
    addEventListener() {},
    removeEventListener() {},
  };
  await rejectsInvalidSignal(signal);
});

test('#4640 preserves normal and already-aborted AbortSignal semantics', async () => {
  const active = new AbortController();
  const normal = await plan({ signal: active.signal });
  assert.equal(normal.missingEvidence.includes('cancelled'), false);

  const aborted = new AbortController();
  aborted.abort('caller-cancelled');
  const cancelled = await plan({ signal: aborted.signal });
  assert.equal(cancelled.missingEvidence.includes('cancelled'), true);
  assert.equal(cancelled.exhausted, true);
});

test('#4640 preserves live external cancellation through the planner-owned signal', async () => {
  const controller = new AbortController();
  let toolSignal = null;
  const query = {
    ...EMPTY_QUERY,
    entity: Object.freeze({ terms: Object.freeze(['needle']) }),
  };
  const tools = {
    search_functions(_term, options) {
      toolSignal = options.signal;
      queueMicrotask(() => controller.abort('caller-cancelled'));
      return new Promise(() => {});
    },
  };

  const result = await planAnalysisGoal(query, {}, {
    tools,
    signal: controller.signal,
    timeoutMs: 1_000,
  });
  assert.equal(toolSignal?.aborted, true);
  assert.equal(result.missingEvidence.includes('cancelled'), true);
  assert.equal(result.exhausted, true);
});

test('#4640 keeps cleanup failures from replacing a successful planner result', async () => {
  const signal = {
    aborted: false,
    addEventListener() {},
    removeEventListener() { throw new Error('cleanup failed'); },
  };

  const result = await plan({ signal });
  assert.ok(result && typeof result === 'object');
  assert.equal(result.missingEvidence.includes('cancelled'), false);
});

test('#4640 treats an unreadable optional abort reason as cancellation, not an integration exception', async () => {
  const signal = {
    aborted: true,
    get reason() { throw new Error('reason failed'); },
    addEventListener() {},
    removeEventListener() {},
  };

  const result = await plan({ signal });
  assert.equal(result.missingEvidence.includes('cancelled'), true);
  assert.equal(result.exhausted, true);
});

test('#4640 validates cleanup callability and removes an installed listener exactly once', async () => {
  let added = 0;
  let removed = 0;
  let installed = null;
  const signal = {
    aborted: false,
    reason: undefined,
    addEventListener(type, listener) {
      assert.equal(type, 'abort');
      added += 1;
      installed = listener;
    },
    removeEventListener(type, listener) {
      assert.equal(type, 'abort');
      assert.equal(listener, installed);
      removed += 1;
    },
  };

  const result = await plan({ signal });
  assert.ok(result && typeof result === 'object');
  assert.equal(added, 1);
  assert.equal(removed, 1);
});
