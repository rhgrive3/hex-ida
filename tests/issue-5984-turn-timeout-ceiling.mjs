// Regression for #5984: executeTurn turned a provider-level "no default
// timeout" (ChatGPTWebProvider.turnTimeoutMs() === null) into `Infinity`,
// deleting the documented AI_BUDGETS hard browser-side ceiling. The ceiling
// must always hold: provider defaults may only shorten it, caller overrides
// are clamped by aiBudget, and the provider request still receives a finite
// remaining-time budget so a hung bridge aborts at the runtime deadline.
import assert from 'node:assert/strict';
import { AIRuntime } from '../js/ai/runtime.js';
import { ChatGPTWebProvider } from '../js/ai/provider/chatgpt-web.js';

function runtimeWithProbe({ provider, observed }) {
  const runtime = new AIRuntime({
    context: {},
    planner: false,
    provider: provider || new ChatGPTWebProvider({ bridge: { request: async () => '{"type":"final","answer":"ok","confidence":1,"evidenceIds":[]}' } }),
  });
  const inner = runtime.provider.nextTurn.bind(runtime.provider);
  runtime.provider.nextTurn = async (request, options) => {
    observed.push(options.timeoutMs ?? null);
    return inner(request, options);
  };
  return runtime;
}

assert.equal(new ChatGPTWebProvider({ bridge: {} }).turnTimeoutMs(), null, 'precondition: first-party ChatGPT Web provider declares no default timeout');

{
  const observed = [];
  await runtimeWithProbe({ observed }).turn({ goal: 'probe', mode: 'chat' });
  assert.ok(observed[0] != null && Number.isFinite(observed[0]), 'chat turn without caller override must run under a finite runtime deadline (main: no timeoutMs at all)');
  assert.ok(observed[0] <= 240000, `chat hard ceiling 240000 held, saw ${observed[0]}`);
}

{
  const observed = [];
  await runtimeWithProbe({ observed }).turn({ goal: 'probe', mode: 'agent' });
  assert.ok(observed[0] != null && Number.isFinite(observed[0]), 'agent turn without caller override must run under a finite runtime deadline (main: no timeoutMs at all)');
  assert.ok(observed[0] <= 600000, `agent hard ceiling 600000 held, saw ${observed[0]}`);
}

{
  const observed = [];
  await runtimeWithProbe({ observed }).turn({ goal: 'probe', mode: 'chat', budget: { timeoutMs: 120000 } });
  assert.ok(observed[0] != null && Number.isFinite(observed[0]) && observed[0] <= 120000, `caller may shorten the turn, saw ${observed[0]}`);
}

{
  const observed = [];
  await runtimeWithProbe({ observed }).turn({ goal: 'probe', mode: 'chat', budget: { timeoutMs: 999999 } });
  assert.ok(observed[0] <= 240000, `caller override cannot exceed the hard ceiling, saw ${observed[0]}`);
}

{
  const observed = [];
  const shortProvider = {
    turnTimeoutMs: () => 30000,
    nextTurn: async () => ({ type: 'final', answer: 'ok', evidenceIds: [] }),
  };
  await runtimeWithProbe({ provider: shortProvider, observed }).turn({ goal: 'probe', mode: 'chat' });
  assert.ok(observed[0] != null && Number.isFinite(observed[0]) && observed[0] <= 30000, `finite provider default still shortens the turn, saw ${observed[0]}`);
}

{
  const runtime = new AIRuntime({
    context: {},
    planner: false,
    provider: {
      turnTimeoutMs: () => null,
      nextTurn: (_request, options) => new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(new Error('turn hung')), { once: true });
      }),
    },
  });
  const settled = await Promise.race([
    runtime.turn({ goal: 'probe', mode: 'chat', budget: { timeoutMs: 50 } }).then(() => true, () => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 4000)),
  ]);
  assert.equal(settled, true, 'a hung provider must be stopped by the runtime wall-clock deadline instead of pending forever');
}
