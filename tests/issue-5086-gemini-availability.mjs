import assert from 'node:assert/strict';
import { UserscriptAIProvider } from '../js/ai/provider/chatgpt-web.js';
import { WorkerAIProvider } from '../js/ai/provider/index.js';

function capabilityResponse(configured, capabilities = { provider: 'gemini' }) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    text: async () => JSON.stringify({ configured, capabilities }),
  };
}

const previousProvider = globalThis.__HEX_AI_PROVIDER__;
try {
  // configured:false must surface as unavailable, not available:true.
  {
    const provider = new UserscriptAIProvider({
      bridge: null,
      fetchImpl: async () => capabilityResponse(false),
    });
    const caps = await provider.capabilities();
    const gemini = caps.providers.find((entry) => entry.id === 'gemini');
    assert.equal(gemini.available, false, 'an unconfigured Gemini worker must not be reported available');
  }

  // configured:true stays available.
  {
    const provider = new UserscriptAIProvider({
      bridge: null,
      fetchImpl: async () => capabilityResponse(true),
    });
    const caps = await provider.capabilities();
    const gemini = caps.providers.find((entry) => entry.id === 'gemini');
    assert.equal(gemini.available, true, 'a configured Gemini worker must stay available');
  }

  // A failed preflight must not assert "configured".
  {
    const provider = new UserscriptAIProvider({
      bridge: null,
      fetchImpl: async () => { throw new Error('network down'); },
    });
    const caps = await provider.capabilities();
    const gemini = caps.providers.find((entry) => entry.id === 'gemini');
    assert.equal(gemini.available, false, 'a failed preflight must not claim the worker is configured');
    assert.ok(typeof gemini.reason === 'string' && gemini.reason.length > 0);
  }

  // WorkerAIProvider must retain the top-level configured flag.
  {
    const worker = new WorkerAIProvider({ fetchImpl: async () => capabilityResponse(false) });
    await worker.prepareCapabilities();
    assert.equal(worker.isConfigured(), false);
    const worker2 = new WorkerAIProvider({ fetchImpl: async () => capabilityResponse(true) });
    await worker2.prepareCapabilities();
    assert.equal(worker2.isConfigured(), true);
  }

  // status() must not report ready when Gemini is known-unconfigured.
  {
    globalThis.__HEX_AI_PROVIDER__ = 'gemini';
    const provider = new UserscriptAIProvider({
      bridge: null,
      fetchImpl: async () => capabilityResponse(false),
    });
    await provider.capabilities();
    assert.equal(provider.status().ready, false, 'status must reflect a known-unconfigured Gemini worker');
  }
} finally {
  if (previousProvider === undefined) delete globalThis.__HEX_AI_PROVIDER__;
  else globalThis.__HEX_AI_PROVIDER__ = previousProvider;
}

console.log('issue-5086-gemini-availability: ok');
