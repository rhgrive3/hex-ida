// Regression for #4079: the Hex Worker turn protocol requires exactly one
// tool call per turn, but the normalize path silently kept the first
// function_call and dropped every additional call, converting a protocol
// violation into a clean single-call decision. Contract now: 0 or 2+ call
// candidates are rejected as invalid_model_output (model-repair path),
// provider-specific normalize must retain all tool calls so the count guard
// sees them, and the Groq/OpenAI-compatible wire request disables parallel
// tool calls where supported.
import assert from 'node:assert/strict';
import worker from '../worker.js';
import { normalizeAIInteraction } from '../js/ai/provider/worker-protocol.js';
import { resolveInferenceAdapter } from '../js/ai/provider/worker-adapters.js';

const call = (name, args) => ({ type: 'function_call', name, arguments: args });

{
  const tool = normalizeAIInteraction({ steps: [call('get_xrefs', '{"address":"0x2000"}')] }, ['get_xrefs']);
  assert.equal(tool.type, 'tool');
  assert.equal(tool.tool, 'get_xrefs');
  const final = normalizeAIInteraction({ steps: [call('submit_hex_result', '{"answer":"done"}')] }, []);
  assert.equal(final.type, 'final');
  assert.equal(final.answer, 'done');
}

{
  assert.throws(() => normalizeAIInteraction({ steps: [] }, ['get_xrefs']), /did not return a complete function call/);
  assert.throws(() => normalizeAIInteraction({ output: [] }, ['get_xrefs']), /did not return a complete function call/);
  assert.throws(() => normalizeAIInteraction({ content: 'no call at all' }, ['get_xrefs']), /did not return a complete function call/);
}

{
  assert.throws(
    () => normalizeAIInteraction({ steps: [
      call('read_memory', '{"address":"0x1000"}'),
      call('get_xrefs', '{"address":"0x2000"}'),
    ] }, ['read_memory', 'get_xrefs']),
    /multiple tool calls|exactly one/i,
    'two read tool calls in one turn must be rejected, not truncated to the first',
  );
  assert.throws(
    () => normalizeAIInteraction({ steps: [
      call('get_xrefs', '{}'),
      call('submit_hex_result', '{"answer":"done"}'),
    ] }, ['get_xrefs']),
    /multiple tool calls|exactly one/i,
    'a read call plus submit_hex_result must be rejected',
  );
  assert.throws(
    () => normalizeAIInteraction({ steps: [
      call('submit_hex_result', '{"answer":"done"}'),
      call('get_xrefs', '{}'),
    ] }, ['get_xrefs']),
    /multiple tool calls|exactly one/i,
    'submit_hex_result plus a trailing call must be rejected',
  );
  assert.throws(
    () => normalizeAIInteraction({ output: [call('a', '{}')], response: { steps: [call('b', '{}')] } }, ['a', 'b']),
    /multiple tool calls|exactly one/i,
    'call candidates from every step pool must all be counted',
  );
  const mixed = normalizeAIInteraction({ steps: [{ type: 'message', content: 'plan' }, call('get_xrefs', '{}')] }, ['get_xrefs']);
  assert.equal(mixed.tool, 'get_xrefs', 'non-call steps must not count toward the call total');
}

{
  const groq = resolveInferenceAdapter({ AI_PROVIDER: 'groq', GROQ_API_KEY: 'k' });
  assert.equal(groq.id, 'groq');
  const one = groq.normalize({ choices: [{ message: { tool_calls: [{ function: { name: 'read_memory', arguments: '{"address":"0x1000"}' } }] } }] });
  assert.equal(one.steps.length, 1);
  assert.equal(normalizeAIInteraction(one, ['read_memory']).tool, 'read_memory');
  const two = groq.normalize({ choices: [{ message: { tool_calls: [
    { function: { name: 'read_memory', arguments: '{}' } },
    { function: { name: 'submit_hex_result', arguments: '{"answer":"done"}' } },
  ] } }] });
  assert.equal(two.steps.length, 2, 'provider normalize must not drop additional tool calls');
  assert.throws(() => normalizeAIInteraction(two, ['read_memory']), /multiple tool calls|exactly one/i);
  const none = groq.normalize({ choices: [{ message: { content: 'plain answer' } }] });
  assert.throws(() => normalizeAIInteraction(none, []), /did not return a complete function call/);
  const wire = groq.build({ payload: { mode: 'chat' }, systemInstruction: 'sys', tools: [{ name: 'get_xrefs', description: 'd', inputSchema: { type: 'object', properties: {} } }] });
  assert.equal(wire.parallel_tool_calls, false, 'Groq/OpenAI-compatible requests must disable parallel tool calls on the wire');
}

{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    steps: [call('read_memory', '{"address":"0x1000"}'), call('get_xrefs', '{"address":"0x2000"}')],
  }), { headers: { 'content-type': 'application/json' } });
  try {
    const response = await worker.fetch(new Request('https://example.test/api/ai/turn', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'agent',
        context: { request: { goal: 'resolve a multi tool call turn' } },
        messages: [],
        tools: [{ name: 'read_memory', description: 'read', inputSchema: { type: 'object', properties: {} } }, { name: 'get_xrefs', description: 'xrefs', inputSchema: { type: 'object', properties: {} } }],
      }),
    }), {
      GEMINI_API_KEY: 'test-key',
      AI_QUOTA: {
        getByName() {
          return {
            async acquire() { return { allowed: true, token: 'multi-call-test' }; },
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
