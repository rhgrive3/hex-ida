// Regression for #5708: AIProvider stored capability state on the own
// property `capabilities`, which shadowed UserscriptAIProvider's UI discovery
// method of the same name — `typeof provider.capabilities === 'function'` was
// false, so bridge.aiCapabilities() always fell back to `{providers: []}`.
// The state field is now namespaced and the discovery method is reachable.
import assert from 'node:assert/strict';
import { AIProvider } from '../js/ai/provider/index.js';
import { UserscriptAIProvider } from '../js/ai/provider/chatgpt-web.js';

{
  const provider = new UserscriptAIProvider({ bridge: { request() {} } });
  assert.equal(typeof provider.capabilities, 'function', 'the discovery method must not be shadowed by state');
  assert.equal(Object.prototype.hasOwnProperty.call(provider, 'capabilities'), false);
  const discovery = await provider.capabilities();
  assert.ok(Array.isArray(discovery.providers), 'the discovery API returns the advertised provider list');
}

{
  // The base provider keeps its capability state contract via getCapabilities().
  const provider = new AIProvider({ capabilities: { contextTokens: 1234 } });
  assert.equal(provider.getCapabilities().contextTokens, 1234);
  assert.equal(typeof provider.capabilities, 'undefined');
}

{
  // Discovery works through the bridge contract on a real wrapper.
  const provider = new UserscriptAIProvider({
    bridge: {
      request() {},
      capabilities: async () => ({ models: [{ id: 'chatgpt-web/demo' }] }),
    },
  });
  const discovery = await provider.capabilities();
  assert.equal(discovery.providers[0].id, 'chatgpt-web');
  assert.deepEqual(discovery.providers[0].models, [{ id: 'chatgpt-web/demo' }]);
}
