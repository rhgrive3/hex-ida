import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeAIInteraction } from '../js/ai/provider/worker-protocol.js';

function functionCall(name, args = {}) {
  return { steps: [{ type: 'function_call', name, arguments: args }] };
}

test('issue #6165 - primitive string tool name reaches tool dispatch', () => {
  const decision = normalizeAIInteraction(functionCall('get_function', { functionAddress: '0x1000' }), ['get_function']);
  assert.equal(decision.type, 'tool');
  assert.equal(decision.tool, 'get_function');
});

test('issue #6165 - primitive string submit_hex_result reaches final authority', () => {
  const decision = normalizeAIInteraction(functionCall('submit_hex_result', { answer: 'done', evidenceIds: ['ev1'] }), []);
  assert.equal(decision.type, 'final');
  assert.equal(decision.answer, 'done');
});

test('issue #6165 - structured submit_hex_result name is not promoted to final authority', () => {
  for (const invalidName of [['submit_hex_result'], { toString: () => 'submit_hex_result' }, 1, true, null]) {
    assert.throws(
      () => normalizeAIInteraction(functionCall(invalidName, { answer: 'done' }), []),
      /invalid function name/,
      `name ${JSON.stringify(typeof invalidName === 'object' ? String(invalidName) : invalidName)} must not become final authority`,
    );
  }
});

test('issue #6165 - structured allowed-tool name is not promoted to tool identity', () => {
  for (const invalidName of [['get_function'], { toString: () => 'get_function' }, 7, false]) {
    assert.throws(
      () => normalizeAIInteraction(functionCall(invalidName, { functionAddress: '0x1000' }), ['get_function']),
      /invalid function name/,
      `name ${JSON.stringify(invalidName)} must not become tool identity`,
    );
  }
});

test('issue #6165 - type-violating name is not rescued by function.name fallback', () => {
  const call = { type: 'function_call', name: ['submit_hex_result'], function: { name: 'submit_hex_result' }, arguments: { answer: 'done' } };
  assert.throws(() => normalizeAIInteraction({ steps: [call] }, []), /invalid function name/);
});

test('issue #6165 - empty string name is rejected', () => {
  assert.throws(() => normalizeAIInteraction(functionCall(''), []), /invalid function name/);
});

test('issue #6165 - Groq call.function.name string path is preserved', () => {
  const decision = normalizeAIInteraction(
    { steps: [{ type: 'function_call', name: undefined, function: { name: 'get_function' }, arguments: { functionAddress: '0x1000' } }] },
    ['get_function'],
  );
  assert.equal(decision.type, 'tool');
  assert.equal(decision.tool, 'get_function');

  const final = normalizeAIInteraction(
    { steps: [{ type: 'function_call', name: undefined, function: { name: 'submit_hex_result' }, arguments: { answer: 'groq answer' } }] },
    [],
  );
  assert.equal(final.type, 'final');
  assert.equal(final.answer, 'groq answer');
});

test('issue #6165 - invalid structured name normalizes to stable invalid_model_output', async () => {
  const worker = (await import('../worker.js')).default;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ steps: [{ type: 'function_call', name: ['submit_hex_result'], arguments: { answer: 'laundered' } }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
  try {
    const quotaStub = {
      async acquire() { return { allowed: true, token: 'test-lease' }; },
      async release() { return { released: true }; },
    };
    const response = await worker.fetch(new Request('https://example.test/api/ai/turn', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'chat', style: 'analyst', scope: 'auto', context: { request: { goal: 'structured name check' } }, messages: [], tools: [] }),
    }), {
      GEMINI_API_KEY: 'server-only',
      AI_QUOTA: { getByName: () => quotaStub },
      ASSETS: { fetch: () => new Response('asset') },
    });
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.equal(body.error.code, 'invalid_model_output');
    assert.match(body.error.message, /invalid function name/);
  } finally { globalThis.fetch = originalFetch; }
});
