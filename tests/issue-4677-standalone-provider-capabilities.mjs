// Regression for #4677: bridge aiCapabilities() only recognized a callable
// provider.capabilities(). The standalone path constructs a WorkerAIProvider
// whose contract is getCapabilities()/prepareCapabilities(), so discovery
// always fell through to `{providers: []}` and the model picker showed zero
// reachable providers on Standalone Web.
import assert from 'node:assert/strict';
import { createAiEngine } from '../js/ai/ui/bridge.js';
import { AIProvider, WorkerAIProvider } from '../js/ai/provider/index.js';
import { UserscriptAIProvider } from '../js/ai/provider/chatgpt-web.js';
import { normalizeCapabilities } from '../js/ai/ui/model-picker.js';
import { createAIRuntime } from '../js/ai/runtime.js';

const app = {
  store: { get(key) { if (key === 'fileInfo') return { name: 'fixture' }; if (key === 'sliceIndex') return 0; if (key === 'regions') return []; return null; } },
  notes: { structs: [] }, symbols: null, recognition: { records: [] }, stringIndex: [],
};

const capabilitiesResponse = (payload) => ({ ok: true, async text() { return JSON.stringify(payload); } });

// 1+2: Standalone WorkerAIProvider surfaces through the bridge, and the
// values its capability preflight fetched reach the UI.
{
  const requests = [];
  const engine = createAiEngine(app, {
    loadCore: async (context) => createAIRuntime({
      context,
      provider: new WorkerAIProvider({
        fetchImpl: async (url) => {
          requests.push(String(url));
          return capabilitiesResponse({ capabilities: { provider: 'worker', contextTokens: 262144, models: ['worker/fast', 'worker/deep'] } });
        },
      }),
    }),
  });
  const discovery = await engine.aiCapabilities();
  assert.ok(Array.isArray(discovery?.providers) && discovery.providers.length > 0,
    'a standalone Worker provider must not collapse to an empty provider list');
  assert.deepEqual(requests, ['/api/ai/capabilities'], 'discovery must run the capability preflight');
  const entry = discovery.providers.find((item) => item.id === 'worker');
  assert.ok(entry, 'the worker provider must be advertised with its contract id');
  assert.deepEqual(entry.models, ['worker/fast', 'worker/deep'], 'preflight-refreshed models must reach the UI');
  const refreshed = await engine.aiCapabilities();
  assert.deepEqual(refreshed, discovery, 'a settled preflight must keep serving the refreshed values');
  assert.deepEqual(requests, ['/api/ai/capabilities'], 'the memoized preflight must not re-fetch');
}

// 3: The userscript router keeps its existing capabilities() discovery behavior.
{
  const workerRequests = [];
  const provider = new UserscriptAIProvider({
    bridge: { request() {}, capabilities: async () => ({ models: [{ id: 'chatgpt-web/demo' }] }) },
    fetchImpl: async (url) => { workerRequests.push(String(url)); return capabilitiesResponse({ capabilities: {} }); },
  });
  const engine = createAiEngine(app, { loadCore: async () => ({ provider }) });
  const discovery = await engine.aiCapabilities();
  assert.deepEqual(discovery, await provider.capabilities(),
    'the userscript discovery callable must keep producing the provider list unchanged');
  assert.deepEqual(discovery.providers.map((item) => item.id), ['chatgpt-web', 'gemini']);
  assert.deepEqual(discovery.providers[0].models, [{ id: 'chatgpt-web/demo' }]);
  assert.deepEqual(workerRequests, [], 'the discovery callable must not be replaced by a second preflight path');
}

// 4: The empty fallback survives only where no provider contract exists.
{
  const withoutCore = createAiEngine(app, { loadCore: async () => null });
  assert.deepEqual(await withoutCore.aiCapabilities(), { providers: [] });
  const withoutProvider = createAiEngine(app, { loadCore: async (context) => createAIRuntime({ context }) });
  assert.deepEqual(await withoutProvider.aiCapabilities(), { providers: [] });
  const contractless = createAiEngine(app, { loadCore: async () => ({ provider: {} }) });
  assert.deepEqual(await contractless.aiCapabilities(), { providers: [] });
  const unknownSentinel = createAiEngine(app, { loadCore: async () => ({ provider: new AIProvider() }) });
  assert.deepEqual(await unknownSentinel.aiCapabilities(), { providers: [] },
    'the conservative unknown provider sentinel must not advertise a selectable provider');
}

// 5: The model picker normalizes the bridge discovery shape end-to-end.
{
  const engine = createAiEngine(app, {
    loadCore: async () => ({ provider: new WorkerAIProvider({ fetchImpl: async () => capabilitiesResponse({ capabilities: { provider: 'worker', models: [{ id: 'worker/deep', label: 'Deep' }] } }) }) }),
  });
  const normalized = normalizeCapabilities(await engine.aiCapabilities());
  assert.equal(normalized.known, true, 'the picker must recognize the standalone provider as known');
  assert.deepEqual(normalized.providers.map((item) => item.id), ['gemini'], 'the worker id must normalize to its picker identity');
  assert.equal(normalized.providers[0].available, true);
  assert.deepEqual(normalized.providers[0].models.map((item) => item.id), ['worker/deep']);
}

console.log('issue-4677-standalone-provider-capabilities: PASS');
