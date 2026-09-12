import assert from 'node:assert/strict';
import worker, { __test } from '../../../worker.js';

const readCall = (name = 'search_functions', argumentsValue = { query: 'coin' }) => ({
  type: 'function_call',
  name,
  arguments: argumentsValue,
});
const finalCall = () => ({
  type: 'function_call',
  name: 'submit_hex_result',
  arguments: { answer: 'done' },
});

assert.deepEqual(
  __test.normalizeAIInteraction({ steps: [readCall()] }, ['search_functions']),
  { type: 'tool', tool: 'search_functions', arguments: { query: 'coin' }, purpose: '' },
  'one tool call remains valid',
);
assert.throws(
  () => __test.normalizeAIInteraction({ steps: [] }, []),
  /complete function call/,
  'zero tool calls remain invalid',
);
assert.throws(
  () => __test.normalizeAIInteraction({ steps: [readCall(), readCall('future_probe', {})] }, ['search_functions', 'future_probe']),
  /exactly one function call/,
  'two read calls are a protocol violation',
);
assert.throws(
  () => __test.normalizeAIInteraction({ steps: [readCall(), finalCall()] }, ['search_functions']),
  /exactly one function call/,
  'read plus final must not silently discard the final call',
);
assert.throws(
  () => __test.normalizeAIInteraction({ steps: [finalCall(), readCall()] }, ['search_functions']),
  /exactly one function call/,
  'final plus read must not silently finalize while discarding evidence work',
);
assert.throws(
  () => __test.normalizeAIInteraction({ steps: [readCall()], output: [readCall('future_probe', {})] }, ['search_functions', 'future_probe']),
  /exactly one function call/,
  'call candidates across supported response collections count toward the same exactly-one contract',
);

const groqAdapter = __test.resolveInferenceAdapter({ AI_PROVIDER: 'groq', GROQ_API_KEY: 'server-only' });
const normalizedGroq = groqAdapter.normalize({ choices: [{ message: { tool_calls: [
  { function: { name: 'search_functions', arguments: '{"query":"coin"}' } },
  { function: { name: 'submit_hex_result', arguments: '{"answer":"done"}' } },
] } }] });
assert.deepEqual(
  normalizedGroq.steps.map((step) => step.name),
  ['search_functions', 'submit_hex_result'],
  'Groq normalization preserves every tool call for the generic guardrail',
);
assert.throws(
  () => __test.normalizeAIInteraction(normalizedGroq, ['search_functions']),
  /exactly one function call/,
  'provider-normalized multi-call responses are rejected',
);

const groqRequest = groqAdapter.build({
  payload: { mode: 'chat', style: 'analyst', requestedScope: 'auto', effectiveScope: 'auto', messages: [], context: {} },
  systemInstruction: 'system',
  tools: [{ name: 'search_functions', description: 'search', inputSchema: { type: 'object' } }],
});
assert.equal(groqRequest.parallel_tool_calls, false, 'Groq wire requests disable parallel tool calls');

{
  const originalFetch = globalThis.fetch;
  const quotaStub = {
    async acquire() { return { allowed: true, token: 'issue-4079-lease' }; },
    async release(token) { assert.equal(token, 'issue-4079-lease'); return { released: true }; },
  };
  try {
    globalThis.fetch = async (_url, options) => {
      const upstream = JSON.parse(options.body);
      assert.equal(upstream.parallel_tool_calls, false);
      return new Response(JSON.stringify({ choices: [{ message: { tool_calls: [
        { function: { name: 'search_functions', arguments: '{"query":"coin"}' } },
        { function: { name: 'submit_hex_result', arguments: '{"answer":"done"}' } },
      ] } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const response = await worker.fetch(new Request('https://example.test/api/ai/turn', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'chat', style: 'analyst', scope: 'auto',
        context: { request: { goal: 'find coin' } }, messages: [],
        tools: [{ name: 'search_functions', description: 'search', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }],
      }),
    }), {
      AI_PROVIDER: 'groq', GROQ_API_KEY: 'server-only',
      AI_QUOTA: { getByName: () => quotaStub },
      ASSETS: { fetch: () => new Response('asset') },
    });
    assert.equal(response.status, 502, 'actual Worker boundary rejects provider multi-call output');
    assert.equal((await response.json()).error.code, 'invalid_model_output');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

console.log('issue-4079 AI worker exactly-one tool-call regression: PASS');
