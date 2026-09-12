import assert from 'node:assert/strict';
import { createAiEngine } from '../js/ai/ui/bridge.js';
import { normalizeCapabilities } from '../js/ai/ui/model-picker.js';
import { WorkerAIProvider } from '../js/ai/provider/index.js';
import { UserscriptAIProvider } from '../js/ai/provider/chatgpt-web.js';

const app = {
  store: { get(key) { if (key === 'fileInfo') return { name: 'fixture' }; if (key === 'sliceIndex') return 0; if (key === 'regions') return []; return null; } },
  notes: { structs: [] }, symbols: null, recognition: { records: [] }, stringIndex: [],
};

await testStandaloneWorkerCapabilitiesReachTheBridge();
await testPreflightUpdatesReachTheUi();
await testUserscriptDiscoveryContractIsPreserved();
await testCapabilityApiOptionPassthrough();
await testFallbackOnlyForProviderWithoutCapabilityApi();
console.log('issue #4677 standalone worker capability discovery: ok');

function workerFetch(responder) {
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    seen.push({ url, init });
    return responder(seen.length);
  };
  return { fetchImpl, seen };
}

function jsonResponse(payload) {
  return {
    ok: true,
    headers: { get: () => null },
    text: async () => JSON.stringify(payload),
  };
}

async function testStandaloneWorkerCapabilitiesReachTheBridge() {
  const { fetchImpl } = workerFetch(() => jsonResponse({ capabilities: {} }));
  const provider = new WorkerAIProvider({ fetchImpl });
  const engine = createAiEngine(app, { loadCore: async () => ({ provider }) });

  const capabilities = await engine.aiCapabilities();
  assert.notDeepEqual(capabilities, { providers: [] }, 'a standalone WorkerAIProvider must not collapse to the empty provider list');
  assert.equal(capabilities.provider, 'worker');

  const normalized = normalizeCapabilities(capabilities);
  assert.equal(normalized.known, true, 'the picker must accept the standalone capability shape end-to-end');
  assert.equal(normalized.providers.length, 1);
  assert.equal(normalized.providers[0].id, 'gemini');
  assert.equal(normalized.providers[0].available, true);
}

async function testPreflightUpdatesReachTheUi() {
  const { fetchImpl, seen } = workerFetch(() => jsonResponse({ capabilities: { contextTokens: 262144, tpm: 999 } }));
  const provider = new WorkerAIProvider({ fetchImpl });
  assert.equal(provider.getCapabilities().contextTokens, 32768);
  const engine = createAiEngine(app, { loadCore: async () => ({ provider }) });

  const capabilities = await engine.aiCapabilities();
  assert.equal(capabilities.contextTokens, 262144, 'preflight-updated capability values must reach the bridge');
  assert.equal(capabilities.tpm, 999);
  assert.equal(seen.length, 1);

  await engine.aiCapabilities();
  assert.equal(seen.length, 1, 'the memoized preflight result must be reusable without a second fetch');
}

async function testUserscriptDiscoveryContractIsPreserved() {
  const provider = new UserscriptAIProvider({
    bridge: {
      request() {},
      capabilities: async () => ({ models: [{ id: 'chatgpt-web/demo' }] }),
    },
  });
  const engine = createAiEngine(app, { loadCore: async () => ({ provider }) });

  const capabilities = await engine.aiCapabilities();
  assert.ok(Array.isArray(capabilities.providers), 'the userscript discovery method must remain the bridge contract');
  assert.deepEqual(capabilities.providers.map((entry) => entry.id), ['chatgpt-web', 'gemini']);
  assert.deepEqual(capabilities.providers[0].models, [{ id: 'chatgpt-web/demo' }]);

  const normalized = normalizeCapabilities(capabilities);
  assert.equal(normalized.known, true);
  assert.deepEqual(normalized.providers.map((entry) => entry.id), ['chatgpt-web', 'gemini']);
}

async function testCapabilityApiOptionPassthrough() {
  const { fetchImpl, seen } = workerFetch(() => jsonResponse({ capabilities: {} }));
  const provider = new WorkerAIProvider({ fetchImpl });
  const engine = createAiEngine(app, { loadCore: async () => ({ provider }) });

  await engine.aiCapabilities({ timeoutMs: 2500 });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].init.signal.constructor.name, 'AbortSignal');
}

async function testFallbackOnlyForProviderWithoutCapabilityApi() {
  const plainEngine = createAiEngine(app, { loadCore: async () => ({ provider: {} }) });
  assert.deepEqual(await plainEngine.aiCapabilities(), { providers: [] });

  const noProviderEngine = createAiEngine(app, { loadCore: async () => ({}) });
  assert.deepEqual(await noProviderEngine.aiCapabilities(), { providers: [] });

  const brokenEngine = createAiEngine(app, { loadCore: async () => { throw new Error('core-unavailable'); } });
  assert.deepEqual(await brokenEngine.aiCapabilities(), { providers: [] });
}
