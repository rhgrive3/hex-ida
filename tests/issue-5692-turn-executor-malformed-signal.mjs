import assert from 'node:assert/strict';
import { executeTurn } from '../js/ai/control/turn-executor.js';
import { AIRuntime } from '../js/ai/runtime.js';
import { AIError } from '../js/ai/schema.js';

function createMockRuntime() {
  return new AIRuntime({
    context: { binaryId: 'fixture:5692', currentAddress: 0x1000n },
    planner: false,
    provider: {
      turnTimeoutMs: () => null,
      async nextTurn() {
        return {
          type: 'final',
          answer: 'ok',
          confidence: 1.0,
          evidenceIds: [],
          suggestedActions: [],
        };
      },
    },
  });
}

async function testDirectExecuteTurnMalformedSignal() {
  const activeControllers = new Set();
  const context = {
    provider: null,
    activeControllers,
  };

  const malformedSignals = [
    {},
    { aborted: false },
    { aborted: false, addEventListener: null },
    { aborted: false, addEventListener: () => {}, removeEventListener: null },
    { aborted: 'not-a-boolean', addEventListener: () => {}, removeEventListener: () => {} },
    'string-signal',
    12345,
    true,
    false,
    [],
  ];

  for (const signal of malformedSignals) {
    // 1. via options.signal
    await assert.rejects(
      async () => {
        await executeTurn.call(context, { goal: 'test' }, { signal });
      },
      (err) => {
        assert.ok(err instanceof AIError, `Expected AIError but got ${err?.constructor?.name}: ${err?.message}`);
        assert.equal(err.type, 'invalid_model_output');
        assert.match(err.message, /AbortSignal-compatible/);
        return true;
      },
      `options.signal with ${JSON.stringify(signal)} should fail-closed with canonical AIError`,
    );

    // 2. via request.signal
    await assert.rejects(
      async () => {
        await executeTurn.call(context, { goal: 'test', signal }, {});
      },
      (err) => {
        assert.ok(err instanceof AIError, `Expected AIError but got ${err?.constructor?.name}: ${err?.message}`);
        assert.equal(err.type, 'invalid_model_output');
        assert.match(err.message, /AbortSignal-compatible/);
        return true;
      },
      `request.signal with ${JSON.stringify(signal)} should fail-closed with canonical AIError`,
    );

    // Ensure activeControllers did not retain any leaked controllers
    assert.equal(activeControllers.size, 0, 'activeControllers must remain empty after signal validation failure');
  }
}

async function testAIRuntimeWithSignals() {
  const runtime = createMockRuntime();

  // 1. Malformed signal via runtime.turn
  await assert.rejects(
    async () => {
      await runtime.turn({ goal: 'test' }, { signal: {} });
    },
    (err) => {
      assert.ok(err instanceof AIError);
      assert.equal(err.type, 'invalid_model_output');
      assert.match(err.message, /AbortSignal-compatible/);
      return true;
    },
    'runtime.turn with malformed signal must throw canonical AIError',
  );

  // 2. Pre-aborted signal via options.signal
  const preAborted = AbortSignal.abort('test cancellation');
  await assert.rejects(
    async () => {
      await runtime.turn({ goal: 'test' }, { signal: preAborted });
    },
    (err) => {
      assert.ok(err instanceof AIError);
      assert.equal(err.type, 'cancelled');
      return true;
    },
    'runtime.turn with pre-aborted signal must throw cancelled AIError',
  );

  // 3. Valid non-aborted signal via options.signal
  const controller = new AbortController();
  const res = await runtime.turn(
    { mode: 'chat', scope: 'auto', goal: 'test', budget: { timeoutMs: 30000, maxModelCalls: 1 } },
    { signal: controller.signal },
  );
  assert.equal(res.answer, 'ok');
  assert.equal(res.limits.exhausted, false);

  // 4. Null / undefined signal operates normally
  const resNull = await runtime.turn(
    { mode: 'chat', scope: 'auto', goal: 'test', budget: { timeoutMs: 30000, maxModelCalls: 1 } },
    { signal: null },
  );
  assert.equal(resNull.answer, 'ok');

  const resUndef = await runtime.turn(
    { mode: 'chat', scope: 'auto', goal: 'test', budget: { timeoutMs: 30000, maxModelCalls: 1 } },
    { signal: undefined },
  );
  assert.equal(resUndef.answer, 'ok');
}

async function main() {
  await testDirectExecuteTurnMalformedSignal();
  await testAIRuntimeWithSignals();
  console.log('issue-5692 turn executor malformed signal validation: PASS');
}

await main();
