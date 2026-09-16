import assert from 'node:assert/strict';
import { UserscriptAIProvider } from '../js/ai/provider/chatgpt-web.js';

const bridge = { request() {} };
const json = (value, init = {}) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' }, ...init });
const providerEntry = (caps, id) => caps.providers.find((entry) => entry.id === id);

{
  const fetchImpl = async (url, options = {}) => {
    if ((options.method || 'GET') === 'GET') return json({ configured: false, capabilities: { provider: 'gemini' } });
    return json({ error: { code: 'service_not_configured', message: 'Gemini is not configured.' } }, { status: 503 });
  };
  const provider = new UserscriptAIProvider({ bridge, workerEndpoint: '/api/ai/turn', fetchImpl });
  const caps = await provider.capabilities();
  assert.deepEqual(providerEntry(caps, 'gemini'), { id: 'gemini', displayName: 'Gemini', available: false, configured: false });
  assert.equal(providerEntry(caps, 'chatgpt-web').available, true);
  globalThis.__HEX_AI_PROVIDER__ = 'gemini';
  assert.equal(provider.status().ready, false);
  await assert.rejects(
    provider.nextTurn({ provider: 'gemini', mode: 'chat', style: 'analyst', scope: 'auto', messages: [], context: {}, tools: [] }),
    (error) => error?.details?.code === 'service_not_configured',
  );
  delete globalThis.__HEX_AI_PROVIDER__;
}

{
  const provider = new UserscriptAIProvider({
    bridge,
    workerEndpoint: '/api/ai/turn',
    fetchImpl: async () => json({ configured: true, capabilities: { provider: 'gemini', maxTools: 9 } }),
  });
  const gemini = providerEntry(await provider.capabilities(), 'gemini');
  assert.equal(gemini.available, true);
  assert.equal(gemini.configured, true);
  assert.equal(provider.gemini.getCapabilities().maxTools, 9);
  globalThis.__HEX_AI_PROVIDER__ = 'gemini';
  assert.equal(provider.status().ready, true);
  delete globalThis.__HEX_AI_PROVIDER__;
}

{
  const provider = new UserscriptAIProvider({
    bridge,
    workerEndpoint: '/api/ai/turn',
    fetchImpl: async () => { throw new Error('network down'); },
  });
  const gemini = providerEntry(await provider.capabilities(), 'gemini');
  assert.equal(gemini.available, false);
  assert.equal(gemini.configured, null);
}

{
  let aborted = false;
  const provider = new UserscriptAIProvider({
    bridge,
    workerEndpoint: '/api/ai/turn',
    fetchImpl: (_url, options = {}) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => {
        aborted = true;
        reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    }),
  });
  const gemini = providerEntry(await provider.capabilities({ timeoutMs: 30 }), 'gemini');
  assert.equal(aborted, true);
  assert.equal(gemini.available, false);
  assert.equal(gemini.configured, null);
}

console.log('issue-5086 gemini configured availability: ok');
