// Regression for #5701: UserscriptAIProvider never delegated
// prepareCapabilities()/getCapabilities() to the selected child provider, so
// a Gemini/Worker turn was budgeted against the wrapper's static defaults and
// the Worker capabilities preflight (/api/ai/capabilities) never ran.
// Capability authority now follows the same selection as nextTurn().
import assert from 'node:assert/strict';
import { UserscriptAIProvider } from '../js/ai/provider/chatgpt-web.js';

const requests = [];
function wrapperProvider() {
  return new UserscriptAIProvider({
    bridge: { request() {} },
    workerEndpoint: '/api/ai/turn',
    fetchImpl: async (url) => {
      requests.push(String(url));
      if (String(url).endsWith('/capabilities')) {
        return { ok: true, async text() { return JSON.stringify({ capabilities: { provider: 'gemini', contextTokens: 1_000_000, maxOutputTokens: 8192, maxTools: 32, maxRequestBytes: 1024 * 1024 } }); } };
      }
      throw new Error('turn not needed for this reproduction');
    },
  });
}

{
  const provider = wrapperProvider();
  globalThis.__HEX_AI_PROVIDER__ = 'gemini';
  try {
    await provider.prepareCapabilities();
    assert.deepEqual(requests, ['/api/ai/capabilities'], 'the selected child preflight must run');
    assert.equal(provider.getCapabilities().contextTokens, 1_000_000,
      'runtime budget calculation must see the selected child capabilities');
    assert.equal(provider.getCapabilities().maxTools, 32);
  } finally { delete globalThis.__HEX_AI_PROVIDER__; }
}

{
  // Per-request selection follows nextTurn()'s routing.
  const provider = wrapperProvider();
  await provider.prepareCapabilities();
  const geminiCaps = provider.getCapabilities({ provider: 'gemini' });
  assert.equal(geminiCaps.contextTokens, 1_000_000, 'an explicit gemini request sees the worker capabilities');
  const chatgptCaps = provider.getCapabilities({ provider: 'chatgpt-web' });
  assert.notEqual(chatgptCaps.contextTokens, 1_000_000, 'the chatgpt child keeps its own capability state');
}
