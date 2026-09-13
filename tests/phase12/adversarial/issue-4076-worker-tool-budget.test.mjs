import assert from 'node:assert/strict';
import worker from '../../../worker.js';
import { clientSafeCapabilities, resolveInferenceAdapter } from '../../../js/ai/provider/worker-adapters.js';

function safeCaps(env) {
  return clientSafeCapabilities(resolveInferenceAdapter(env).capabilities);
}

function turnRequest(tools = []) {
  return new Request('https://example.test/api/ai/turn', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      mode: 'chat', style: 'analyst', scope: 'auto',
      context: { request: { goal: 'inspect this binary' } }, messages: [], tools,
    }),
  });
}

const readTool = (name) => ({ name, description: name, inputSchema: { type: 'object', properties: {} } });
const quota = () => ({
  async acquire() { return { allowed: true, token: 'lease' }; },
  async release() { return { released: true }; },
});

// The advertised maxTools is the browser/read-tool budget. One provider slot
// is reserved for the Worker-owned submit_hex_result protocol tool.
assert.equal(safeCaps({ AI_PROVIDER: 'gemini', GEMINI_TOOL_LIMIT: '2' }).maxTools, 1);
assert.equal(safeCaps({ AI_PROVIDER: 'gemini', GEMINI_TOOL_LIMIT: '2' }).upstreamMaxTools, 2);
assert.equal(safeCaps({ AI_PROVIDER: 'groq', GROQ_TOOL_LIMIT: '1' }).maxTools, 0);
assert.equal(safeCaps({ AI_PROVIDER: 'gemini' }).maxTools, 31, 'default provider cap keeps the runtime 10-tool window available');
assert.equal(safeCaps({ AI_PROVIDER: 'gemini', GEMINI_TOOL_LIMIT: '2' }).finalResultToolReserve, 1);

// Preflight and turn response expose the same reserved client budget, while the
// actual upstream request never exceeds the provider's total tool ceiling.
{
  const env = {
    AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'server-only', GEMINI_TOOL_LIMIT: '2',
    AI_QUOTA: { getByName: () => quota() },
  };
  const preflight = await worker.fetch(new Request('https://example.test/api/ai/capabilities', { method: 'GET' }), env);
  const preflightBody = await preflight.json();
  assert.equal(preflightBody.capabilities.maxTools, 1);
  assert.equal(preflightBody.capabilities.upstreamMaxTools, 2);
  assert.equal(preflightBody.capabilities.finalResultToolReserve, 1);

  const originalFetch = globalThis.fetch;
  let upstreamTools = null;
  globalThis.fetch = async (_url, options) => {
    upstreamTools = JSON.parse(options.body).tools;
    return new Response(JSON.stringify({
      steps: [{ type: 'function_call', name: 'submit_hex_result', arguments: { answer: 'ok', evidenceIds: [] } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const response = await worker.fetch(turnRequest([readTool('search_functions')]), env);
    assert.equal(response.status, 200);
    assert.equal(upstreamTools.length, 2, 'one read tool plus final-result tool exactly fits maxTools=2');
    assert.equal(upstreamTools.some((tool) => tool.name === 'submit_hex_result'), true);
    const body = await response.json();
    assert.equal(body.capabilities.maxTools, preflightBody.capabilities.maxTools, 'preflight and turn response share one client budget authority');
    assert.equal(body.capabilities.upstreamMaxTools, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// Bypassing capability discovery cannot send more read tools than the reserved
// budget. Reject before quota/network side effects instead of truncating silently.
{
  let quotaAcquired = 0;
  let upstreamCalled = 0;
  const env = {
    AI_PROVIDER: 'gemini', GEMINI_API_KEY: 'server-only', GEMINI_TOOL_LIMIT: '2',
    AI_QUOTA: { getByName: () => ({
      async acquire() { quotaAcquired++; return { allowed: true, token: 'lease' }; },
      async release() { return { released: true }; },
    }) },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { upstreamCalled++; throw new Error('must not reach provider'); };
  try {
    const response = await worker.fetch(turnRequest([readTool('search_functions'), readTool('get_function')]), env);
    assert.equal(response.status, 422);
    assert.equal((await response.json()).error.code, 'tool_budget_exceeded');
    assert.equal(quotaAcquired, 0, 'invalid tool budget is rejected before quota consumption');
    assert.equal(upstreamCalled, 0, 'invalid tool budget is rejected before provider I/O');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// The current canonical contract for a provider total cap of 1 is final-only:
// zero read tools are advertised, submit_hex_result still fits exactly, and any
// client-supplied read tool is rejected before quota/provider side effects.
{
  let quotaAcquired = 0;
  let upstreamCalled = 0;
  let upstreamTools = null;
  const env = {
    AI_PROVIDER: 'groq', GROQ_API_KEY: 'server-only', GROQ_TOOL_LIMIT: '1',
    AI_QUOTA: { getByName: () => ({
      async acquire() { quotaAcquired++; return { allowed: true, token: 'lease' }; },
      async release() { return { released: true }; },
    }) },
  };
  const preflight = await worker.fetch(new Request('https://example.test/api/ai/capabilities', { method: 'GET' }), env);
  const preflightBody = await preflight.json();
  assert.equal(preflight.status, 200);
  assert.equal(preflightBody.configured, true);
  assert.equal(preflightBody.capabilities.maxTools, 0);
  assert.equal(preflightBody.capabilities.upstreamMaxTools, 1);
  assert.equal(preflightBody.capabilities.finalResultToolReserve, 1);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    upstreamCalled++;
    upstreamTools = JSON.parse(options.body).tools;
    return new Response(JSON.stringify({
      choices: [{ message: { tool_calls: [{ function: { name: 'submit_hex_result', arguments: JSON.stringify({ answer: 'ok', evidenceIds: [] }) } }] } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const finalOnly = await worker.fetch(turnRequest([]), env);
    assert.equal(finalOnly.status, 200);
    assert.equal(upstreamCalled, 1);
    assert.equal(upstreamTools.length, 1);
    assert.equal(upstreamTools[0].function?.name, 'submit_hex_result');

    const beforeRejected = upstreamCalled;
    const rejected = await worker.fetch(turnRequest([readTool('search_functions')]), env);
    assert.equal(rejected.status, 422);
    assert.equal((await rejected.json()).error.code, 'tool_budget_exceeded');
    assert.equal(upstreamCalled, beforeRejected, 'over-budget read tool must be rejected before provider I/O');
    assert.equal(quotaAcquired, 1, 'only the accepted final-only turn may consume quota');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

console.log('issue #4076 Worker tool-budget regressions PASS');
