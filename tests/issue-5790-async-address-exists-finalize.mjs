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
import { ToolRegistry } from '../js/ai/tools/index.js';

const ADDRESS_ACTION_KINDS = Object.freeze([
  'open-function', 'open-address', 'show-xrefs', 'show-callers', 'show-callees',
  'show-cfg', 'show-pseudocode', 'open-evidence', 'trace-value',
]);

function evidenceStore() {
  const store = new EvidenceStore();
  store.add({ id: 'e1', status: 'supported', kind: 'search', title: 'hit', sourceTool: 'search_functions', address: '0x1000' });
  return store;
}

function runtimeWith({ addressExists, program, kinds = ['open-function'] }) {
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
          suggestedActions: kinds.map((kind) => ({ kind, target: '0x1000', evidenceId: 'e1' })),
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

test('#5790 keeps address-action kinds and tool preflight on one strict authority', async () => {
  for (const expected of [false, true]) {
    let calls = 0;
    const addressExists = async (address) => {
      calls++;
      assert.equal(address, '0x1000');
      return expected;
    };
    const final = await runtimeWith({ addressExists, kinds: ADDRESS_ACTION_KINDS }).turn({ mode: 'agent', goal: 'Locate coin increase behavior' });
    if (expected) {
      assert.deepEqual(final.actions.map(({ kind, target }) => ({ kind, target })), ADDRESS_ACTION_KINDS.map((kind) => ({ kind, target: '0x1000' })));
    } else {
      assert.deepEqual(final.actions, []);
    }
    assert.equal(calls, 1, 'duplicate action targets share one final authority check');

    const registry = new ToolRegistry({ context: { addressExists } });
    registry.register({ name: 'check_address', inputSchema: { type: 'object' }, execute: async () => ({ ok: true }) });
    const toolCall = registry.execute('check_address', { address: '0x1000' });
    if (expected) await assert.doesNotReject(() => toolCall);
    else await assert.rejects(() => toolCall, (error) => error?.type === 'invalid_tool_call');
    assert.equal(calls, 2, 'tool preflight checks the same target authority');
  }

  for (const malformed of [undefined, null, {}, 1, 'yes']) {
    const addressExists = async () => malformed;
    const final = await runtimeWith({ addressExists, kinds: ['open-address'] }).turn({ mode: 'agent', goal: 'Locate coin increase behavior' });
    assert.deepEqual(final.actions, [], `malformed ${String(malformed)} authority must reject the final action`);
    const registry = new ToolRegistry({ context: { addressExists } });
    registry.register({ name: 'check_address', inputSchema: { type: 'object' }, execute: async () => ({ ok: true }) });
    await assert.rejects(
      () => registry.execute('check_address', { address: '0x1000' }),
      (error) => error?.type === 'invalid_tool_call',
      `malformed ${String(malformed)} authority must reject tool arguments too`,
    );
  }
});
