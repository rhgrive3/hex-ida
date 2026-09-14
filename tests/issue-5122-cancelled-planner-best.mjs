// Regression for #5122: a user cancel must not be converted into a normal
// planner-candidate answer just because the deterministic plan has a `best`
// candidate. The #5632 fix throws `cancelled` from the outer catch of
// executeTurn() before deterministicDecision() can run, so this test pins the
// issue-5122 race end-to-end: planner best present + provider abort mid-flight
// → cancelled rejection, no assistant answer, no memory commit, and the
// provider-error local fallback / budget partial policies stay intact.
import assert from 'node:assert/strict';
import { AIRuntime } from '../js/ai/runtime.js';
import { AIError } from '../js/ai/schema.js';
import { deterministicDecision } from '../js/ai/control/runtime-support.js';

function errorWithAbort() {
  const error = new Error('cancelled');
  error.name = 'AbortError';
  return error;
}

const PLANNER_GOAL = 'find the function that handles this update';
const BEST_PLAN = () => ({
  query: { raw: PLANNER_GOAL, confident: true },
  best: {
    address: 0x1000n,
    name: 'candidate',
    score: 10,
    sources: ['lexical'],
    verification: { verified: false },
    evidence: [],
  },
  candidates: [{
    address: 0x1000n,
    name: 'candidate',
    score: 10,
    sources: ['lexical'],
    verification: { verified: false },
    evidence: [],
  }],
  evidence: [],
  missingEvidence: [],
  completeness: { complete: true, partial: false },
  exhausted: false,
  partial: false,
});

function makeRuntime(provider, planner = () => BEST_PLAN()) {
  const persisted = { messages: [], memoryUpdates: 0, updates: 0 };
  const sessionStore = {
    async create(input) {
      return { id: 'session-5122', goal: input.goal, mode: input.mode, messages: [], memory: null, status: 'active', effectiveScope: 'auto' };
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
  const runtime = new AIRuntime({ provider, sessionStore, planner, context: {} });
  return { runtime, persisted };
}

// 1. Issue-5122 race: planner best exists + provider aborts mid-flight on user
// cancel → the turn must reject with cancelled, never resolve the normal
// candidate answer, and must not commit an assistant message or memory.
{
  const controller = new AbortController();
  const { runtime, persisted } = makeRuntime({
    turnTimeoutMs() { return 120000; },
    async prepareCapabilities() {},
    getCapabilities() { return { contextTokens: 32768, maxOutputTokens: 4096, maxTools: 10, maxRequestBytes: 65536 }; },
    nextTurn(_request, { signal }) {
      return new Promise((_resolve, reject) => {
        if (signal?.aborted) { reject(errorWithAbort()); return; }
        signal.addEventListener('abort', () => reject(errorWithAbort()), { once: true });
      });
    },
  });
  const pending = runtime.turn({ mode: 'agent', goal: PLANNER_GOAL, planner: true }, { signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const memoryBefore = persisted.memoryUpdates;
  controller.abort('cancelled');
  await assert.rejects(pending, (error) => error.type === 'cancelled',
    'a cancelled turn with a planner best must reject, not resolve the candidate answer (#5122)');
  assert.equal(persisted.assistant, undefined, 'cancel must not commit a normal assistant answer to the session (#5122)');
  assert.equal(persisted.memoryUpdates, memoryBefore, 'cancel must not commit candidate-answer state to investigation memory after the abort (#5122)');
  assert.equal(persisted.memory?.unresolvedQuestions, undefined, 'the completion memory payload must never be written for a cancelled turn (#5122)');
}

// 2. Issue-5122 minimal control-flow unit: with a plan.best present,
// deterministicDecision() must not swallow a cancelled error into the normal
// candidate answer path.
{
  const plan = BEST_PLAN();
  const error = new AIError('cancelled', 'The AI investigation was cancelled.');
  assert.notEqual(
    humanBestAnswer(plan),
    null,
    'sanity: the fixture plan produces a normal candidate answer when no error is present',
  );
  const answerWithCancel = humanBestAnswer(plan, error);
  assert.ok(
    !(answerWithCancel && answerWithCancel.includes('最も強い候補は')),
    'deterministicDecision must not answer with the best candidate when the error is cancelled (#5122)',
  );
}

function humanBestAnswer(plan, error) {
  const decision = deterministicDecision(plan, { mode: 'agent' }, error ?? null);
  return decision?.answer ?? null;
}

// 3. provider_error + planner best keeps the existing local fallback policy.
{
  const { runtime, persisted } = makeRuntime({
    turnTimeoutMs() { return 120000; },
    async prepareCapabilities() {},
    async nextTurn() { throw new AIError('provider_error', 'provider exploded'); },
  });
  const result = await runtime.turn({ mode: 'agent', goal: PLANNER_GOAL, planner: true });
  assert.equal(result.limits.reason, 'provider_error');
  assert.ok(result.answer.includes('最も強い候補は'), 'provider_error with a planner best keeps the local candidate fallback (#5122 policy)');
  assert.ok(persisted.assistant, 'provider_error fallback answer still persists normally');
}

// 4. budget_exhausted (timeout) with planner best keeps the partial policy.
{
  const hung = new AIRuntime({
    provider: {
      turnTimeoutMs() { return 120000; },
      async prepareCapabilities() {},
      async nextTurn() { return { type: 'tool', tool: 'search_functions', arguments: { query: 'hang' } }; },
    },
    planner: () => BEST_PLAN(),
    context: {
      binaryId: 'fixture:5122',
      searchFunctions: () => new Promise(() => {}),
      searchStrings: async () => [],
      addressExists: () => true,
    },
  });
  const result = await hung.turn({ mode: 'agent', goal: 'bounded' }, { budget: { timeoutMs: 20 } });
  assert.equal(result.limits.reason, 'budget_exhausted', 'budget/timeout keeps the graceful partial policy (#5122 policy)');
  assert.notEqual(result.limits.reason, 'cancelled');
}

console.log('issue #5122 cancelled-turn planner-best regressions PASS');
