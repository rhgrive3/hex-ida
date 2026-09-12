import assert from 'node:assert/strict';
import { clientSafeCapabilities } from '../js/ai/provider/worker-adapters.js';
import { handleAICapabilities, handleAITurn } from '../js/ai/provider/worker-turn.js';
import { selectToolWindow } from '../js/ai/control/tool-window.js';
import { AIRuntime } from '../js/ai/runtime.js';

function quotaEnv(extra = {}) {
  const quota = {
    async acquire() { return { allowed: true, token: 't' }; },
    async release() { return { released: true }; },
  };
  return { GEMINI_API_KEY: 'x', AI_QUOTA: { getByName: () => quota }, ...extra };
}

function requestWithTools(tools = []) {
  return new Request('https://example.test/api/ai/turn', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '1.2.3.4' },
    body: JSON.stringify({
      sessionId: 'issue-4591', mode: 'chat', style: 'analyst', requestedScope: 'auto', effectiveScope: 'binary',
      context: { request: { goal: 'x' } },
      tools,
    }),
  });
}

const readTool = (name) => ({ name, description: name, inputSchema: { type: 'object', properties: {} } });

// The Worker owns submit_hex_result, so the client-visible capability must reserve one provider slot.
assert.equal(clientSafeCapabilities({ maxTools: 2, maxRequestBytes: 160000 }).maxTools, 1);
assert.equal(clientSafeCapabilities({ maxTools: 1, maxRequestBytes: 160000 }).maxTools, 0);
assert.equal(clientSafeCapabilities({ maxTools: 32, maxRequestBytes: 160000 }).maxTools, 31);

// The capabilities endpoint advertises the same client-owned budget, not the provider total.
const capabilityResponse = handleAICapabilities(new Request('https://example.test/api/ai/capabilities'), quotaEnv({ GEMINI_TOOL_LIMIT: '2' }));
const advertised = await capabilityResponse.json();
assert.equal(advertised.capabilities.maxTools, 1);

// A zero read-tool budget is a real, valid capability: the Worker can still expose submit_hex_result.
const registry = { definitionsForModel() { return [readTool('search_functions')]; } };
assert.deepEqual(selectToolWindow(registry, { requestedScope: 'auto', effectiveScope: 'binary', maxTools: 0 }).tools, []);

// The browser turn executor must honor an advertised zero read-tool budget without inventing a tool.
{
  let observedTools = null;
  const provider = {
    getCapabilities() { return { maxTools: 0 }; },
    async nextTurn(request) {
      observedTools = request.tools ?? [];
      return { type: 'final', answer: 'done', confidence: 0.9, evidenceIds: [], followups: [] };
    },
  };
  const runtime = new AIRuntime({
    context: { binaryId: 'fixture:4591', searchFunctions: async () => [], searchStrings: async () => [], addressExists: () => true },
    provider,
    planner: false,
  });
  const result = await runtime.turn({ mode: 'agent', goal: 'final only' });
  assert.equal(result.answer, 'done');
  assert.deepEqual(observedTools, []);
}

const originalFetch = globalThis.fetch;
try {
  // Oversized client tool sets are rejected before any provider request is built/sent.
  let upstreamCalls = 0;
  globalThis.fetch = async () => {
    upstreamCalls++;
    return new Response(JSON.stringify({ steps: [{ type: 'function_call', name: 'submit_hex_result', arguments: { answer: 'ok' } }] }), { status: 200 });
  };
  const rejected = await handleAITurn(requestWithTools([readTool('tool_a'), readTool('tool_b')]), quotaEnv({ GEMINI_TOOL_LIMIT: '2' }));
  assert.equal(rejected.status, 422);
  assert.equal((await rejected.json()).error.code, 'tool_limit_exceeded');
  assert.equal(upstreamCalls, 0, 'over-budget tool set must not reach provider');

  // normalizeAITools() may retain up to 40 client tools, but that transport cap must not bypass provider maxTools.
  const fortyTools = Array.from({ length: 40 }, (_, index) => readTool(`tool_${String(index).padStart(2, '0')}`));
  const sanitizerBoundary = await handleAITurn(requestWithTools(fortyTools), quotaEnv({ GEMINI_TOOL_LIMIT: '40' }));
  assert.equal(sanitizerBoundary.status, 422);
  assert.equal(upstreamCalls, 0, 'the fixed 40-tool sanitizer ceiling must not bypass the provider total');

  // One client tool plus the Worker-owned final tool exactly fits maxTools=2.
  let sentTools = null;
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    sentTools = body.tools;
    return new Response(JSON.stringify({ steps: [{ type: 'function_call', name: 'submit_hex_result', arguments: { answer: 'ok' } }] }), { status: 200 });
  };
  const exact = await handleAITurn(requestWithTools([readTool('tool_a')]), quotaEnv({ GEMINI_TOOL_LIMIT: '2' }));
  assert.equal(exact.status, 200);
  assert.equal(sentTools.length, 2);
  assert.equal(sentTools.some((tool) => tool.name === 'submit_hex_result'), true);

  // maxTools=1 remains usable with the Worker final-result tool as the sole provider-visible tool.
  sentTools = null;
  const finalOnly = await handleAITurn(requestWithTools([]), quotaEnv({ GEMINI_TOOL_LIMIT: '1' }));
  assert.equal(finalOnly.status, 200);
  assert.deepEqual(sentTools.map((tool) => tool.name), ['submit_hex_result']);

  // Groq shares the same total-count enforcement and reserves the final-result slot too.
  let groqTools = null;
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    groqTools = body.tools;
    return new Response(JSON.stringify({
      choices: [{ message: { tool_calls: [{ function: { name: 'submit_hex_result', arguments: JSON.stringify({ answer: 'ok' }) } }] } }],
    }), { status: 200 });
  };
  const groqExact = await handleAITurn(requestWithTools([readTool('tool_a')]), quotaEnv({
    AI_PROVIDER: 'groq', GROQ_API_KEY: 'x', GEMINI_API_KEY: undefined, GROQ_TOOL_LIMIT: '2',
  }));
  assert.equal(groqExact.status, 200);
  assert.equal(groqTools.length, 2);
  assert.equal(groqTools.some((tool) => tool.function?.name === 'submit_hex_result'), true);
} finally {
  globalThis.fetch = originalFetch;
}

console.log('issue #4591 provider tool-limit regression PASS');
