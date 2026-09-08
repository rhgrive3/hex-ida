// Regression for #6165: normalizeAIInteraction() coerced the model's
// function/tool call name with `String()`, so a schema-invalid structured name
// (`['submit_hex_result']`) laundered into that exact string and claimed the
// final-result submission authority (or an allowed tool identity). A tool
// name is string identity: only a primitive non-empty string is valid.
import assert from 'node:assert/strict';
import worker from '../worker.js';
import { normalizeAIInteraction } from '../js/ai/provider/worker-protocol.js';

{
  // Structured and primitive non-string names must never claim either the
  // final-result submission authority or an allowed tool identity.
  for (const [label, invalid] of [
    ['array final', ['submit_hex_result']],
    ['array tool', ['get_function']],
    ['object', { toString: () => 'submit_hex_result' }],
    ['number', 7],
    ['boolean', true],
  ]) {
    assert.throws(
      () => normalizeAIInteraction({
        steps: [{ type: 'function_call', name: invalid, arguments: { answer: 'done', functionAddress: '0x1000' } }],
      }, ['get_function']),
      /invalid function name/,
      `${label} must not become a model tool identity`,
    );
  }
}

{
  // Primitive string names keep working on both paths.
  const tool = normalizeAIInteraction({
    steps: [{ type: 'function_call', name: 'get_function', arguments: { functionAddress: '0x1000' } }],
  }, ['get_function']);
  assert.equal(tool.type, 'tool');
  assert.equal(tool.tool, 'get_function');

  const groqTool = normalizeAIInteraction({
    steps: [{ type: 'function_call', function: { name: 'get_function', arguments: { functionAddress: '0x1000' } } }],
  }, ['get_function']);
  assert.equal(groqTool.type, 'tool');
  assert.equal(groqTool.tool, 'get_function');

  const final = normalizeAIInteraction({
    steps: [{ type: 'function_call', name: 'submit_hex_result', arguments: { answer: 'done' } }],
  }, []);
  assert.equal(final.type, 'final');
  assert.equal(final.answer, 'done');
}

{
  // The Worker boundary must expose malformed model output using its stable
  // invalid_model_output error instead of allowing the schema violation to
  // escape as a successful turn.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    steps: [{ type: 'function_call', name: ['submit_hex_result'], arguments: { answer: 'done' } }],
  }), { headers: { 'content-type': 'application/json' } });
  try {
    const response = await worker.fetch(new Request('https://example.test/api/ai/turn', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'chat',
        context: { request: { goal: 'test malformed model output' } },
        messages: [],
        tools: [],
      }),
    }), {
      GEMINI_API_KEY: 'test-key',
      AI_QUOTA: {
        getByName() {
          return {
            async acquire() { return { allowed: true, token: 'tool-name-test' }; },
            async release() {},
          };
        },
      },
    });
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error.code, 'invalid_model_output');
  } finally {
    globalThis.fetch = originalFetch;
  }
}
