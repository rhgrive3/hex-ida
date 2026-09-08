// Regression for #5455: UserscriptAIProvider.setSelection() commits the
// provider only after the ChatGPT-side selection succeeded. A failed
// selection must leave the previous provider active.
import assert from 'node:assert/strict';
import { UserscriptAIProvider } from '../js/ai/provider/chatgpt-web.js';

function withProviderGlobals(initial) {
  const store = new Map();
  globalThis.__HEX_AI_PROVIDER__ = initial;
  globalThis.localStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  return { store, cleanup: () => { delete globalThis.localStorage; } };
}

// 1. Missing bridge.setSelection → sync throw, no commit.
{
  const { store, cleanup } = withProviderGlobals('gemini');
  try {
    const provider = new UserscriptAIProvider({ bridge: { async request() { return '{}'; } } });
    await assert.rejects(provider.setSelection({ provider: 'chatgpt' }, {}));
    assert.equal(globalThis.__HEX_AI_PROVIDER__, 'gemini', 'a failed selection must not commit chatgpt');
    assert.equal(store.get('hex.ai.provider'), undefined, 'nothing persisted before success');
  } finally { cleanup(); }
}

// 2. Async rejection → no commit.
{
  const { store, cleanup } = withProviderGlobals('gemini');
  try {
    const provider = new UserscriptAIProvider({ bridge: { async setSelection() { throw new Error('model picker unavailable'); } } });
    await assert.rejects(provider.setSelection({ provider: 'chatgpt' }, {}));
    assert.equal(globalThis.__HEX_AI_PROVIDER__, 'gemini');
    assert.equal(store.get('hex.ai.provider'), undefined);
  } finally { cleanup(); }
}

// 3. Success commits both the global and localStorage.
{
  const { store, cleanup } = withProviderGlobals('gemini');
  try {
    const provider = new UserscriptAIProvider({ bridge: { async setSelection() { return { model: 'gpt-5', reasoning: 'minimal' }; } } });
    const result = await provider.setSelection({ provider: 'chatgpt' }, {});
    assert.equal(result.provider, 'chatgpt-web');
    assert.equal(result.model, 'gpt-5');
    assert.equal(globalThis.__HEX_AI_PROVIDER__, 'chatgpt');
    assert.equal(store.get('hex.ai.provider'), 'chatgpt');
  } finally { cleanup(); }
}

// 4. Gemini selection still commits eagerly (no ChatGPT-side step to fail).
{
  const { store, cleanup } = withProviderGlobals('chatgpt');
  try {
    const provider = new UserscriptAIProvider({ bridge: { async request() { return '{}'; } } });
    const result = await provider.setSelection({ provider: 'gemini' }, {});
    assert.equal(result.provider, 'gemini');
    assert.equal(globalThis.__HEX_AI_PROVIDER__, 'gemini');
    assert.equal(store.get('hex.ai.provider'), 'gemini');
  } finally { cleanup(); }
}

console.log('issue #5455 selection commit ordering regressions PASS');
