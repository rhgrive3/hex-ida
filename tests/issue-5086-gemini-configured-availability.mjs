// Regression for #5086: UserscriptAIProvider.capabilities() advertised the
// Gemini/Worker provider as unconditionally `available: true`, and
// WorkerAIProvider.#loadCapabilities() dropped the top-level `configured`
// truth returned by the server's /api/ai/capabilities. An unconfigured Worker
// therefore showed an operable Gemini entry while its first turn failed with
// 503 service_not_configured. Availability must follow the preflight truth,
// and an unverified preflight must never assert `available: true`.
import assert from 'node:assert/strict';
import worker from '../worker.js';
import { UserscriptAIProvider } from '../js/ai/provider/chatgpt-web.js';

function workerFetch(env) {
  return async (url, options = {}) => worker.fetch(new Request(new URL(String(url), 'https://hex.test'), {
    method: options.method || 'GET',
    headers: options.headers || {},
    ...(options.body == null ? {} : { body: options.body }),
    ...(options.signal ? { signal: options.signal } : {}),
  }), env);
}

function entry(providers, id) {
  const item = providers.find((provider) => provider.id === id);
  assert.ok(item, `${id} must stay advertised`);
  return item;
}

const turnRequest = {
  provider: 'gemini', mode: 'chat', style: 'analyst', scope: 'auto',
  messages: [{ role: 'user', content: 'probe' }],
  context: { request: { goal: 'probe' }, current: {} },
  tools: [{ name: 'search_functions', description: 'search', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }],
};

{
  // Server truth wired end-to-end with GEMINI_API_KEY unset.
  const provider = new UserscriptAIProvider({
    bridge: { request() {} },
    workerEndpoint: '/api/ai/turn',
    fetchImpl: workerFetch({}),
  });
  const discovery = await provider.capabilities();
  const gemini = entry(discovery.providers, 'gemini');
  assert.equal(gemini.available, false, 'an unconfigured Worker must not be advertised as operable');
  assert.equal(gemini.configured, false, 'the explicit server truth must survive as configured:false');
  assert.equal(entry(discovery.providers, 'chatgpt-web').available, true, 'ChatGPT bridge availability keeps its own judgment');

  // The same provider still fail-closes the actual turn: no contradiction
  // between the availability view and the 503 service_not_configured truth.
  await assert.rejects(provider.nextTurn(turnRequest), (error) => {
    assert.equal(error.name, 'AIError');
    assert.equal(error.details?.code, 'service_not_configured');
    return true;
  }, 'unconfigured turns must stay fail-closed');
  const after = entry((await provider.capabilities()).providers, 'gemini');
  assert.equal(after.available, false, 'the failed turn must not flip availability back to true');
  globalThis.__HEX_AI_PROVIDER__ = 'gemini';
  assert.equal(provider.status().ready, false, 'status must not report the unconfigured Worker as ready');
  delete globalThis.__HEX_AI_PROVIDER__;
}

{
  // Server truth wired end-to-end with GEMINI_API_KEY set.
  const provider = new UserscriptAIProvider({
    bridge: { request() {} },
    workerEndpoint: '/api/ai/turn',
    fetchImpl: workerFetch({ GEMINI_API_KEY: 'server-only' }),
  });
  const discovery = await provider.capabilities();
  const gemini = entry(discovery.providers, 'gemini');
  assert.equal(gemini.available, true, 'a configured Worker must be advertised as operable');
  assert.equal(gemini.configured, true);
  assert.equal(provider.gemini.getCapabilities().provider, 'gemini', 'the capability budget plane keeps merging server capabilities');
  globalThis.__HEX_AI_PROVIDER__ = 'gemini';
  assert.equal(provider.status().ready, true, 'a configured Worker stays ready');
  delete globalThis.__HEX_AI_PROVIDER__;
}

{
  // Preflight transport failure: the conservative fallback must not assert
  // the unverified provider as configured/available.
  const provider = new UserscriptAIProvider({
    bridge: { request() {} },
    workerEndpoint: '/api/ai/turn',
    fetchImpl: async () => { throw new Error('network down'); },
  });
  const discovery = await provider.capabilities();
  const gemini = entry(discovery.providers, 'gemini');
  assert.equal(gemini.available, false, 'a failed preflight must not publish available:true');
  assert.equal(gemini.configured, null, 'a failed preflight stays an unknown, not a configured assertion');
  assert.equal(entry(discovery.providers, 'chatgpt-web').available, true);
}

{
  // Preflight hang must stay bounded and fall back conservatively.
  let sawAbort = false;
  const provider = new UserscriptAIProvider({
    bridge: { request() {} },
    workerEndpoint: '/api/ai/turn',
    fetchImpl: (_url, options = {}) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener?.('abort', () => { sawAbort = true; reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
    }),
  });
  const startedAt = Date.now();
  const discovery = await provider.capabilities({ timeoutMs: 120 });
  assert.ok(Date.now() - startedAt < 5000, 'the availability preflight is bounded');
  assert.ok(sawAbort, 'the bounded preflight cancels the stalled request');
  assert.equal(entry(discovery.providers, 'gemini').available, false, 'a timed-out preflight must not assert availability');
}

{
  // A payload that carries no configured truth stays unverified.
  const provider = new UserscriptAIProvider({
    bridge: { request() {} },
    workerEndpoint: '/api/ai/turn',
    fetchImpl: async () => new Response(JSON.stringify({ capabilities: { provider: 'gemini', maxTools: 9 } }), { status: 200 }),
  });
  const discovery = await provider.capabilities();
  const gemini = entry(discovery.providers, 'gemini');
  assert.equal(gemini.available, false, 'missing configured truth is never assumed available');
  assert.equal(gemini.configured, null);
  assert.equal(provider.gemini.getCapabilities().maxTools, 9, 'capability payload merging is preserved');
}

{
  // Provider switching must read the live Worker truth, not a selection-time copy.
  const env = {};
  const provider = new UserscriptAIProvider({
    bridge: { request() {} },
    workerEndpoint: '/api/ai/turn',
    fetchImpl: workerFetch(env),
  });
  globalThis.__HEX_AI_PROVIDER__ = 'chatgpt-web';
  assert.equal(entry((await provider.capabilities()).providers, 'gemini').available, false);
  globalThis.__HEX_AI_PROVIDER__ = 'gemini';
  const selected = await provider.capabilities();
  assert.equal(entry(selected.providers, 'gemini').available, false, 'a stale configured:false must not be swapped out by selection changes');
  assert.equal(entry(selected.providers, 'chatgpt-web').available, true);
  const chatgptCaps = provider.getCapabilities({ provider: 'chatgpt-web' });
  assert.notEqual(chatgptCaps.provider, 'gemini', 'ChatGPT capability routing keeps its own plane');
  delete globalThis.__HEX_AI_PROVIDER__;
}

console.log('issue-5086 gemini configured availability: ok');
