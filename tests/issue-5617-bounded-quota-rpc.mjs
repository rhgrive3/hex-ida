// Regression for #5617: quota control-plane RPCs are bounded. A hung acquire
// fails closed, a hung release cannot block the client response, and a client
// disconnect during the quota wait never starts an upstream fetch.
import assert from 'node:assert/strict';
import { handleAITurn } from '../js/ai/provider/worker-turn.js';

function makeRequest(signal = undefined) {
  return new Request('https://example.test/api/ai/turn', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '1.2.3.4' },
    body: JSON.stringify({ sessionId: 's', mode: 'chat', style: 'analyst', requestedScope: 'auto', effectiveScope: 'binary', context: { request: { goal: 'x' } }, tools: [] }),
    signal,
  });
}
const fastEnv = (quota) => ({ GEMINI_API_KEY: 'x', AI_QUOTA_RPC_TIMEOUT_MS: '80', AI_QUOTA: { getByName: () => quota } });

// 1. A hung acquire settles fail-closed instead of pending forever.
{
  const env = fastEnv({ acquire: () => new Promise(() => {}), release: () => Promise.resolve() });
  const observed = await Promise.race([
    handleAITurn(makeRequest(), env).then((r) => `settled:${r.status}`),
    new Promise((resolve) => setTimeout(() => resolve('still-pending'), 500)),
  ]);
  assert.equal(observed, 'settled:503', `a hung acquire must fail closed, got ${observed}`);
}

// 2. A hung release cannot block the successful response forever.
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ steps: [{ type: 'function_call', name: 'submit_hex_result', arguments: { answer: 'ok' } }] }), { status: 200 });
  try {
    const env = fastEnv({ acquire: async () => ({ allowed: true, token: 't' }), release: () => new Promise(() => {}) });
    const observed = await Promise.race([
      handleAITurn(makeRequest(), env).then((r) => `settled:${r.status}`),
      new Promise((resolve) => setTimeout(() => resolve('still-pending'), 500)),
    ]);
    assert.equal(observed, 'settled:200', `a hung release must not block the response, got ${observed}`);
  } finally { globalThis.fetch = originalFetch; }
}

// 3. A client disconnect during the quota wait never reaches upstream.
{
  const controller = new AbortController();
  let upstreamCalled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { upstreamCalled = true; return new Response('{}', { status: 200 }); };
  try {
    const env = { GEMINI_API_KEY: 'x', AI_QUOTA: { getByName: () => ({ acquire: () => new Promise((resolve) => setTimeout(() => resolve({ allowed: true, token: 'late' }), 400)), release: () => Promise.resolve() }) } };
    const pending = handleAITurn(makeRequest(controller.signal), env);
    setTimeout(() => controller.abort(new Error('Client disconnected.')), 50);
    const response = await pending;
    assert.equal(upstreamCalled, false, 'no upstream fetch after client disconnect');
    assert.equal(response.status, 503);
  } finally { globalThis.fetch = originalFetch; }
}

// 4. Normal acquire/release still grants exactly one lease and releases once.
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ steps: [{ type: 'function_call', name: 'submit_hex_result', arguments: { answer: 'ok' } }] }), { status: 200 });
  try {
    let released = 0;
    const quota = { acquire: async () => ({ allowed: true, token: 't' }), release: async () => { released++; return {}; } };
    const response = await handleAITurn(makeRequest(), { GEMINI_API_KEY: 'x', AI_QUOTA: { getByName: () => quota } });
    assert.equal(response.status, 200);
    assert.equal(released, 1, 'the lease is released exactly once');
  } finally { globalThis.fetch = originalFetch; }
}

console.log('issue #5617 bounded quota rpc regressions PASS');
