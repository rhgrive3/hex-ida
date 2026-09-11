// Regression for #5632: a turn cancelled while running (planner, provider
// nextTurn, tool execution, or via AIRuntime.cancel()) must reject with the
// cancelled error. It must never be converted into a deterministic fallback
// answer, and a cancelled turn must persist no assistant message, memory
// update, or result completion.
import assert from 'node:assert/strict';
import { AIRuntime } from '../js/ai/runtime.js';
import { AgentJobManager } from '../js/ai/jobs/index.js';

function errorWithAbort() {
  const error = new Error('cancelled');
  error.name = 'AbortError';
  return error;
}

function makeRuntime(provider, context = {}) {
  const persisted = { messages: [], memoryUpdates: 0, updates: 0 };
  const sessionStore = {
    async create(input) {
      return { id: 'session-1', goal: input.goal, mode: input.mode, messages: [], memory: null, status: 'active', effectiveScope: 'auto' };
    },
    async get(id) {
      return { id, messages: [], memory: null, status: 'active' };
    },
    async update(id, patch) { persisted.updates++; return { id, ...patch }; },
    async appendMessage(id, message) {
      persisted.messages.push(message);
      if (message.role === 'assistant') persisted.assistant = message;
      return id;
    },
    async updateMemory(id, memory) { persisted.memoryUpdates++; persisted.memory = memory; return id; },
  };
  const runtime = new AIRuntime({ provider, sessionStore, context });
  return { runtime, persisted };
}

const waitingProvider = (signalFn) => ({
  turnTimeoutMs() { return 120000; },
  async prepareCapabilities() {},
  getCapabilities() { return { contextTokens: 32768, maxOutputTokens: 4096, maxTools: 10, maxRequestBytes: 65536 }; },
  nextTurn(_request, { signal }) {
    return new Promise((resolve, reject) => signalFn(resolve, reject, signal));
  },
  cancel() {},
});

// 1. nextTurn abort mid-flight → cancelled rejection, no fallback answer.
{
  const controller = new AbortController();
  const { runtime, persisted } = makeRuntime(waitingProvider((_resolve, reject, signal) => {
    signal.addEventListener('abort', () => reject(errorWithAbort()), { once: true });
  }));
  const pending = runtime.turn({ mode: 'chat', goal: 'test' }, { signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const memoryBefore = persisted.memoryUpdates;
  controller.abort('cancelled');
  await assert.rejects(pending, (error) => error.type === 'cancelled');
  assert.equal(persisted.assistant, undefined, 'a cancelled turn must not persist a fallback assistant message');
  assert.equal(persisted.memoryUpdates, memoryBefore, 'a cancelled turn must not update investigation memory after cancellation');
  assert.equal(persisted.memory?.unresolvedQuestions, undefined, 'the completion memory payload must never be written for a cancelled turn');
}

// 2. AIRuntime.cancel() settles the active turn as a rejection.
{
  const { runtime, persisted } = makeRuntime(waitingProvider((_resolve, reject, signal) => {
    signal.addEventListener('abort', () => reject(errorWithAbort()), { once: true });
  }));
  const pending = runtime.turn({ mode: 'chat', goal: 'wait' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  runtime.cancel();
  await assert.rejects(pending, (error) => error.type === 'cancelled');
  assert.equal(persisted.assistant, undefined, 'a cancelled turn must not persist a fallback assistant message');
}

// 3. Tool execution aborted mid-flight → cancelled rejection.
{
  const controller = new AbortController();
  const provider = {
    async nextTurn() { return { type: 'tool', tool: 'search_functions', arguments: { query: 'hang' } }; },
  };
  const { runtime, persisted } = makeRuntime(provider, {
    binaryId: 'fixture:5632',
    searchFunctions: (_query, { signal } = {}) => new Promise((_resolve, reject) => {
      if (signal?.aborted) { reject(errorWithAbort()); return; }
      signal?.addEventListener('abort', () => reject(errorWithAbort()), { once: true });
    }),
    searchStrings: async () => [],
    addressExists: () => true,
  });
  const pending = runtime.turn({ mode: 'agent', goal: 'tool cancel' }, { signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort('cancelled');
  await assert.rejects(pending, (error) => error.type === 'cancelled');
  assert.equal(persisted.assistant, undefined, 'a cancelled tool turn must not persist a fallback answer');
}

// 4. Timeout keeps the existing deterministic fallback policy (#5632 point 7).
{
  const provider = {
    async nextTurn() { return { type: 'tool', tool: 'search_functions', arguments: { query: 'hang' } }; },
  };
  const { runtime } = makeRuntime(provider, {
    binaryId: 'fixture:5632',
    searchFunctions: () => new Promise(() => {}),
    searchStrings: async () => [],
    addressExists: () => true,
  });
  const result = await runtime.turn(
    { mode: 'agent', goal: 'bounded' },
    { budget: { timeoutMs: 20 } },
  );
  assert.equal(result.limits.reason, 'budget_exhausted', 'timeout/budget limits keep the fallback policy');
  assert.notEqual(result.limits.reason, 'cancelled');
}

// 5. AgentJobManager: a cancelled slice reaches the checkpointed path
// (runSlice treats a cancel rejection as checkpointed, not failed).
{
  const controller = new AbortController();
  const { runtime } = makeRuntime(waitingProvider((_resolve, reject, signal) => {
    signal.addEventListener('abort', () => reject(errorWithAbort()), { once: true });
  }));
  const manager = new AgentJobManager({ runtime, maxSlices: 4, maxElapsedMs: 30 * 60 * 1000 });
  const job = await manager.create({ jobId: 'cancel-checkpoint', goal: 'cancel me' });
  const slice = manager.runSlice(job.id, { signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort('cancelled');
  await assert.rejects(slice, (error) => error.type === 'cancelled');
  const stored = await manager.get(job.id);
  assert.equal(stored.status, 'checkpointed', 'a cancelled slice must reach the checkpointed path, not failed');
}

console.log('issue #5632 cancelled-turn rejection regressions PASS');
