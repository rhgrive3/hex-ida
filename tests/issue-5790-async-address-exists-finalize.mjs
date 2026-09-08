// Regression for #5790: AI finalization used the synchronous
// addressExistsSync() wrapper, which discards a Promise-returning
// context.addressExists() and falls back to `true`. An async-only authority
// returning `false` was therefore ignored, and a suggested action targeting a
// non-existent address published whenever an evidence record carried the same
// address. Finalize now resolves the async authority for every candidate
// target before sanitization.
import assert from 'node:assert/strict';
import test from 'node:test';
import { AIRuntime } from '../js/ai/runtime.js';
import { addressExistsAsync, addressExistsSync } from '../js/ai/control/runtime-support.js';
import { EvidenceStore } from '../js/ai/evidence.js';

function evidenceStore() {
  const store = new EvidenceStore();
  store.add({ id: 'e1', status: 'supported', kind: 'search', title: 'hit', sourceTool: 'search_functions', address: '0x1000' });
  return store;
}

function runtimeWith({ addressExists, program }) {
  return new AIRuntime({
    context: {
      binaryId: 'fixture:1',
      currentAddress: 0x1000n,
      searchFunctions: async () => [{ addr: 0x1000n, name: 'addCoins', score: 10, reasons: ['name'] }],
      searchStrings: async () => [],
      addressExists,
      program,
    },
    planner: false,
    evidenceStore: evidenceStore(),
    provider: {
      async nextTurn() {
        return {
          type: 'final',
          answer: 'addCoins is the strongest indexed candidate.',
          confidence: 0.9,
          evidenceIds: ['e1'],
          suggestedActions: [{ kind: 'open-function', target: '0x1000' }],
          followups: [],
        };
      },
    },
  });
}

{
  // An async-only authority returning false must suppress the action.
  const runtime = runtimeWith({ addressExists: async () => false });
  const result = await runtime.turn({ mode: 'agent', goal: 'Locate coin increase behavior' });
  assert.deepEqual(result.actions, [], 'a suggested action rejected by the async authority must not publish');
}

{
  // An async-only authority returning true keeps the action.
  const runtime = runtimeWith({ addressExists: async () => true });
  const result = await runtime.turn({ mode: 'agent', goal: 'Locate coin increase behavior' });
  assert.equal(result.actions.length, 1, 'an accepted action still publishes');
  assert.equal(result.actions[0].target, '0x1000');
}

{
  // A sync authority returning false is still respected (existing contract).
  const runtime = runtimeWith({ addressExists: () => false });
  const result = await runtime.turn({ mode: 'agent', goal: 'Locate coin increase behavior' });
  assert.deepEqual(result.actions, [], 'a suggested action rejected by a sync authority must not publish');
}

{
  // Once the capability exists, schema-invalid results are authoritative
  // failures. A truthy program fallback must not launder them into `true`.
  const program = { functionRange: () => ({ start: 0x1000n, end: 0x1010n }) };
  const malformedAuthorities = [
    ['undefined', async () => undefined],
    ['null', async () => null],
    ['object', async () => ({ exists: true })],
    ['numeric', async () => 1],
    ['thenable-resolved-nonboolean', () => Promise.resolve('yes')],
  ];
  for (const [label, addressExists] of malformedAuthorities) {
    assert.equal(
      await addressExistsAsync({ addressExists, program }, '0x1000'),
      false,
      `${label} authority must fail closed instead of using program fallback`,
    );
  }

  const runtime = runtimeWith({ addressExists: async () => undefined, program });
  const result = await runtime.turn({ mode: 'agent', goal: 'Locate coin increase behavior' });
  assert.deepEqual(result.actions, [], 'a malformed async authority must not publish through a truthy program fallback');
}

{
  // Fallback remains available only when the addressExists capability is absent.
  assert.equal(
    await addressExistsAsync({ program: { functionRange: () => ({ start: 0x1000n, end: 0x1010n }) } }, '0x1000'),
    true,
    'program fallback remains valid when no addressExists capability exists',
  );
  assert.equal(
    await addressExistsAsync({ symbols: { functionAt: () => ({ address: 0x1000n }) } }, '0x1000'),
    true,
    'symbol fallback remains valid when no addressExists capability exists',
  );
}

  
test('#5790 synchronous authority errors and cancellation fail closed', async () => {
  assert.equal(
    addressExistsSync({
      addressExists: () => { throw new Error('authority-failed'); },
      program: { functionRange: () => ({ start: 0x1000n, end: 0x1010n }) },
    }, '0x1000'),
    false,
  );
  const controller = new AbortController();
  const pending = addressExistsAsync({
    addressExists: () => new Promise(() => {}),
  }, '0x1000', controller.signal);
  controller.abort('cancelled');
  assert.equal(await pending, false);
});
