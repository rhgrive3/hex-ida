// Regression for #5423: the model-visible tool window limit adopts only
// primitive finite positive numbers. Provider capability metadata (arrays,
// strings, booleans, objects) never becomes the authority, and the AIRuntime
// hard cap 1..10 is preserved.
import assert from 'node:assert/strict';
import { selectToolWindow } from '../js/ai/control/tool-window.js';
import { AIRuntime } from '../js/ai/runtime.js';

const functionTools = [{ name: 'get_cfg' }, { name: 'future_probe' }, { name: 'future_probe_two' }, { name: 'future_probe_three' }];
const registry = {
  definitionsForModel({ scope } = {}) {
    if (scope === 'auto') return [...functionTools, { name: 'search_functions' }];
    return functionTools.slice();
  },
};
const names = (window) => window.tools.map((tool) => tool.name);

// 1. Structured/boolean/string maxTools falls back to the safe limit 1.
for (const forged of [['3'], { tools: 3 }, true, '3', null]) {
  const window = selectToolWindow(registry, { effectiveScope: 'function', maxTools: forged });
  assert.equal(names(window).length <= 1, true, `structured maxTools ${JSON.stringify(forged)} must fall back, not coerce`);
}

// 2. Valid primitives keep working (auto scope reserves the escape slot).
assert.deepEqual(
  names(selectToolWindow(registry, { requestedScope: 'auto', effectiveScope: 'function', maxTools: 2 })),
  ['search_functions', 'get_cfg'],
);
assert.deepEqual(
  names(selectToolWindow(registry, { requestedScope: 'function', effectiveScope: 'function', maxTools: 2 })),
  ['get_cfg', 'future_probe'],
);

// 3. AIRuntime path: a provider declaring structured maxTools keeps the
// default window size instead of shrinking it.
{
  const provider = {
    getCapabilities() { return { maxTools: ['2'] }; },
    async nextTurn() {
      return { type: 'final', answer: 'done', confidence: 0.9, evidenceIds: [], followups: [] };
    },
  };
  const runtime = new AIRuntime({
    context: { binaryId: 'fixture:1', searchFunctions: async () => [], searchStrings: async () => [], addressExists: () => true },
    provider,
    planner: false,
  });
  let observedTools = null;
  const originalNextTurn = provider.nextTurn;
  provider.nextTurn = (request, options) => {
    observedTools = request.tools?.map((tool) => tool.name) ?? [];
    return originalNextTurn(request, options);
  };
  await runtime.turn({ mode: 'agent', goal: 'window check' });
  assert.equal(observedTools.length, 10, 'structured provider maxTools must not shrink the window below the default 10');
}

// 4. A provider declaring a valid primitive 2 keeps the shrunk window.
{
  const provider = {
    getCapabilities() { return { maxTools: 2 }; },
    async nextTurn(request) {
      assert.equal(request.tools.length, 2, 'a valid primitive maxTools still shrinks the window');
      return { type: 'final', answer: 'done', confidence: 0.9, evidenceIds: [], followups: [] };
    },
  };
  const runtime = new AIRuntime({
    context: { binaryId: 'fixture:1', searchFunctions: async () => [], searchStrings: async () => [], addressExists: () => true },
    provider,
    planner: false,
  });
  await runtime.turn({ mode: 'agent', goal: 'window check' });
}

console.log('issue #5423 tool-window numeric authority regressions PASS');
