// Regression for #6140: UserscriptAIProvider must not String()-coerce the
// provider selector. `['gemini']` used to ToPrimitive into the canonical
// Gemini routing — in selected() for turn routing and in setSelection() into
// the persisted global/localStorage selection. A structured selector is a
// schema violation and fails closed; null/undefined still fall back through
// the global selection to the 'chatgpt-web' default.
import assert from 'node:assert/strict';
import { UserscriptAIProvider } from '../js/ai/provider/chatgpt-web.js';

function makeProvider() {
  return new UserscriptAIProvider({
    bridge: { request() {}, cancel() {}, setSelection() {} },
    fetchImpl: async () => { throw new Error('not reached'); },
  });
}

const structuredSelectors = [['gemini'], ['chatgpt-web'], { id: 'gemini' }, 7, true];

{
  const provider = makeProvider();
  for (const selector of structuredSelectors) {
    assert.throws(
      () => provider.selected({ provider: selector }),
      (error) => error.type === 'provider_error',
      `structured provider selector ${JSON.stringify(selector)} must not reach provider routing`,
    );
  }
}

{
  const provider = makeProvider();
  assert.equal(provider.selected({ provider: 'gemini' }), provider.gemini);
  assert.equal(provider.selected({ provider: 'worker' }), provider.gemini);
  assert.equal(provider.selected({ provider: 'chatgpt' }), provider.chatgpt);
  assert.equal(provider.selected({ provider: 'chatgpt-web' }), provider.chatgpt);
  assert.throws(() => provider.selected({ provider: 'unknown-engine' }), /Unknown AI provider/);
}

{
  const provider = makeProvider();
  const previous = globalThis.__HEX_AI_PROVIDER__;
  try {
    globalThis.__HEX_AI_PROVIDER__ = 'gemini';
    assert.equal(provider.selected({}), provider.gemini, 'primitive global selection keeps routing');
    globalThis.__HEX_AI_PROVIDER__ = undefined;
    assert.equal(provider.selected({}), provider.chatgpt, 'unset selector keeps the chatgpt-web default');
  } finally {
    globalThis.__HEX_AI_PROVIDER__ = previous;
  }
}

{
  const provider = makeProvider();
  const previous = globalThis.__HEX_AI_PROVIDER__;
  const writes = [];
  globalThis.localStorage = { setItem(key, value) { writes.push([key, value]); } };
  try {
    for (const selector of structuredSelectors) {
      await assert.rejects(
        () => provider.setSelection({ provider: selector }),
        (error) => error.type === 'provider_error',
        `structured provider selector ${JSON.stringify(selector)} must not become the persisted selection`,
      );
    }
    assert.equal(globalThis.__HEX_AI_PROVIDER__, previous, 'global selection untouched by rejected selectors');
    assert.equal(writes.length, 0, 'localStorage untouched by rejected selectors');

    await provider.setSelection({ provider: 'gemini' });
    assert.equal(globalThis.__HEX_AI_PROVIDER__, 'gemini', 'primitive selection still persists');
    assert.deepEqual(writes, [['hex.ai.provider', 'gemini']]);
  } finally {
    globalThis.__HEX_AI_PROVIDER__ = previous;
    delete globalThis.localStorage;
  }
}
