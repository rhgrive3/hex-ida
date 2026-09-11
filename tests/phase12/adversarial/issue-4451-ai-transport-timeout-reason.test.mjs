import assert from 'node:assert/strict';
import { AIRuntime } from '../../../js/ai/runtime.js';
import { WorkerAIProvider } from '../../../js/ai/provider/index.js';
import { requestJSON } from '../../../js/ai/transport.js';

function abortingFetch(_url, { signal }) {
  return new Promise((_resolve, reject) => {
    const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}

async function rejectedType(promise, type) {
  await assert.rejects(promise, (error) => error?.type === type, `expected ${type}`);
}

// requestJSON must preserve the semantic distinction between a turn deadline
// and an explicit user cancellation after the inner fetch controller aborts.
{
  const controller = new AbortController();
  const pending = requestJSON('/turn', {}, { signal: controller.signal, timeoutMs: 60_000, fetchImpl: abortingFetch });
  controller.abort('timeout');
  await rejectedType(pending, 'budget_exhausted');
}

{
  const controller = new AbortController();
  const pending = requestJSON('/turn', {}, { signal: controller.signal, timeoutMs: 60_000, fetchImpl: abortingFetch });
  controller.abort('cancelled');
  await rejectedType(pending, 'cancelled');
}

// Pre-abort and requestJSON's own timer retain their distinct contracts.
{
  const controller = new AbortController();
  controller.abort('timeout');
  await rejectedType(requestJSON('/turn', {}, { signal: controller.signal, fetchImpl: abortingFetch }), 'budget_exhausted');
  await rejectedType(requestJSON('/turn', {}, { timeoutMs: 5, fetchImpl: abortingFetch }), 'model_timeout');
}

// Response-size protection remains authoritative even though it aborts the
// same local controller used for request cancellation.
{
  await rejectedType(requestJSON('/turn', {}, {
    maxResponseBytes: 1024,
    fetchImpl: async () => ({ headers: { get: () => '2048' } }),
  }), 'context_too_large');
}

// WorkerAIProvider forwards the deadline through both its controller and the
// capabilities preflight; explicit cancellation remains cancellation.
{
  const timeout = new AbortController();
  const provider = new WorkerAIProvider({ fetchImpl: abortingFetch });
  const pending = provider.nextTurn({ tools: [] }, { signal: timeout.signal, timeoutMs: 60_000 });
  timeout.abort('timeout');
  await rejectedType(pending, 'budget_exhausted');
}

{
  const timeout = new AbortController();
  timeout.abort('timeout');
  const provider = new WorkerAIProvider({ fetchImpl: abortingFetch });
  await rejectedType(provider.nextTurn({ tools: [] }, { signal: timeout.signal }), 'budget_exhausted');
}

{
  const cancelled = new AbortController();
  const provider = new WorkerAIProvider({ fetchImpl: abortingFetch });
  const pending = provider.nextTurn({ tools: [] }, { signal: cancelled.signal, timeoutMs: 60_000 });
  cancelled.abort('cancelled');
  await rejectedType(pending, 'cancelled');
}

{
  const timeout = new AbortController();
  const provider = new WorkerAIProvider({ fetchImpl: abortingFetch });
  const pending = provider.prepareCapabilities({ signal: timeout.signal, timeoutMs: 60_000 });
  timeout.abort('timeout');
  await rejectedType(pending, 'budget_exhausted');
}

// Exercise the production AIRuntime -> WorkerAIProvider -> requestJSON path:
// an externally delivered turn deadline must produce a budget result rather
// than a cancellation. Triggering it when the request starts avoids racing
// requestJSON's independent response timer.
{
  const timeout = new AbortController();
  const provider = new WorkerAIProvider({
    fetchImpl: async (url, options) => {
      if (String(url).endsWith('/capabilities')) return { ok: false };
      timeout.abort('timeout');
      return abortingFetch(url, options);
    },
  });
  const runtime = new AIRuntime({ context: {}, planner: false, provider });
  const result = await runtime.turn(
    { mode: 'chat', goal: 'deadline classification', budget: { timeoutMs: 60_000 } },
    { signal: timeout.signal },
  );
  assert.equal(result.limits.reason, 'budget_exhausted');
  assert.notEqual(result.limits.reason, 'cancelled');
}

// A caller-provided already-expired turn preserves the same classification at
// the outer execution boundary.
{
  const timeout = new AbortController();
  timeout.abort('timeout');
  const runtime = new AIRuntime({
    context: {},
    planner: false,
    provider: new WorkerAIProvider({ fetchImpl: abortingFetch }),
  });
  await rejectedType(runtime.turn({ mode: 'chat', goal: 'pre-aborted' }, { signal: timeout.signal }), 'budget_exhausted');
}

console.log('issue #4451 AI transport timeout-reason regressions passed');
