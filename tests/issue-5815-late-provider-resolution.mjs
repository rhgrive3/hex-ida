// Regression for #5815: executeTurn is the deadline/cancellation authority even
// when a provider ignores AbortSignal and resolves after the signal is aborted.
// A late provider result must be discarded before model-output validation or
// any final/tool decision can become authoritative.
import assert from 'node:assert/strict';
import { AIRuntime } from '../js/ai/runtime.js';

function lateOnAbortProvider(decision, observed) {
  return {
    turnTimeoutMs() { return null; },
    async nextTurn(_request, { signal }) {
      observed.calls++;
      await new Promise((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', resolve, { once: true });
      });
      observed.abortedAtResolve = signal.aborted;
      observed.reasonAtResolve = signal.reason;
      return decision;
    },
  };
}

function assistantMessages(runtime) {
  return runtime.sessionStore.list().flatMap((session) => session.messages || [])
    .filter((message) => message.role === 'assistant');
}

// A non-cooperative provider may resolve a syntactically valid final after the
// runtime deadline. The late answer must not be adopted or persisted.
{
  const observed = { calls: 0, abortedAtResolve: false, reasonAtResolve: null };
  const runtime = new AIRuntime({
    context: {},
    planner: false,
    provider: lateOnAbortProvider({
      type: 'final',
      answer: 'LATE-5815-FINAL',
      confidence: 1,
      evidenceIds: [],
      hypothesisIds: [],
      suggestedActions: [],
      followups: [],
    }, observed),
  });

  const result = await runtime.turn({
    mode: 'chat',
    goal: 'late provider result',
    budget: { timeoutMs: 200, maxModelCalls: 1 },
  });

  assert.equal(observed.calls, 1, 'the reproduction must cross the provider await boundary');
  assert.equal(observed.abortedAtResolve, true, 'provider intentionally resolves only after abort');
  assert.equal(observed.reasonAtResolve, 'timeout');
  assert.equal(result.limits.reason, 'budget_exhausted');
  assert.doesNotMatch(result.answer, /LATE-5815-FINAL/, 'late final must not become the returned answer');
  assert.equal(
    assistantMessages(runtime).some((message) => /LATE-5815-FINAL/.test(message.content)),
    false,
    'late final must not be persisted as an assistant answer',
  );
}

// Timeout authority must be re-checked before validating the late payload.
// Otherwise an invalid late tool call can mask the already-fired timeout as an
// invalid_model_output/invalid_tool_call result.
{
  const observed = { calls: 0, abortedAtResolve: false, reasonAtResolve: null };
  const runtime = new AIRuntime({
    context: {},
    planner: false,
    provider: lateOnAbortProvider({
      type: 'tool',
      tool: 'definitely_not_a_hex_tool',
      arguments: {},
    }, observed),
  });

  const result = await runtime.turn({
    mode: 'chat',
    goal: 'timeout must dominate late validation',
    budget: { timeoutMs: 200, maxModelCalls: 1 },
  });

  assert.equal(observed.calls, 1);
  assert.equal(observed.reasonAtResolve, 'timeout');
  assert.equal(result.limits.reason, 'budget_exhausted', 'fired timeout must dominate validation of a late provider payload');
}

// A syntactically valid late tool decision must also be discarded before
// ToolRegistry execution; no read-side effect may start after the deadline.
{
  const observed = { calls: 0, abortedAtResolve: false, reasonAtResolve: null };
  let searches = 0;
  const runtime = new AIRuntime({
    context: {
      searchFunctions: async () => {
        searches++;
        return { results: [], total: 0, complete: true };
      },
    },
    planner: false,
    provider: lateOnAbortProvider({
      type: 'tool',
      tool: 'search_functions',
      arguments: { query: 'late-5815' },
    }, observed),
  });

  const result = await runtime.turn({
    mode: 'agent',
    goal: 'late tool must not execute',
    budget: { timeoutMs: 200, maxModelCalls: 1, maxToolCalls: 1 },
  });

  assert.equal(observed.calls, 1);
  assert.equal(observed.reasonAtResolve, 'timeout');
  assert.equal(result.limits.reason, 'budget_exhausted');
  assert.equal(searches, 0, 'a tool selected only after the deadline must not execute');
}

// External cancellation has the same await-boundary rule and must reject
// without persisting a provider result that resolves after cancellation.
{
  let providerStarted;
  const started = new Promise((resolve) => { providerStarted = resolve; });
  const controller = new AbortController();
  const runtime = new AIRuntime({
    context: {},
    planner: false,
    provider: {
      turnTimeoutMs() { return null; },
      async nextTurn(_request, { signal }) {
        providerStarted();
        await new Promise((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener('abort', resolve, { once: true });
        });
        return {
          type: 'final', answer: 'LATE-5815-CANCEL', confidence: 1,
          evidenceIds: [], hypothesisIds: [], suggestedActions: [], followups: [],
        };
      },
    },
  });

  const pending = runtime.turn({ mode: 'chat', goal: 'cancel late provider' }, { signal: controller.signal });
  await started;
  controller.abort('user-stop');
  await assert.rejects(pending, (error) => error?.type === 'cancelled');
  assert.equal(
    assistantMessages(runtime).some((message) => /LATE-5815-CANCEL/.test(message.content)),
    false,
    'cancelled late final must not be persisted',
  );
}

// Deadline/cancellation checks must not disturb a provider that returns while
// the turn is still live.
{
  const runtime = new AIRuntime({
    context: {},
    planner: false,
    provider: {
      turnTimeoutMs() { return null; },
      async nextTurn() {
        return {
          type: 'final', answer: 'ON-TIME-5815', confidence: 1,
          evidenceIds: [], hypothesisIds: [], suggestedActions: [], followups: [],
        };
      },
    },
  });
  const result = await runtime.turn({ mode: 'chat', goal: 'normal provider', budget: { timeoutMs: 5000, maxModelCalls: 1 } });
  assert.match(result.answer, /ON-TIME-5815/);
  assert.equal(result.limits.reason, undefined);
}

console.log('issue #5815 provider late-result regressions PASS');
