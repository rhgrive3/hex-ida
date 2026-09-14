import assert from 'node:assert/strict';

import { UserscriptAIProvider } from '../../../js/ai/provider/chatgpt-web.js';

function provider() {
  return new UserscriptAIProvider({
    bridge: {
      request() {},
      status() {
        return {
          ready: false,
          busy: true,
          selection: { model: 'chatgpt-web/sol', reasoning: 'high' },
        };
      },
      getSelection() {
        return { model: 'chatgpt-web/sol', reasoning: 'high' };
      },
      async setSelection(selection) {
        return { model: selection.model || null, reasoning: selection.reasoning || null };
      },
    },
    fetchImpl: async () => { throw new Error('worker transport is not part of this alias regression'); },
  });
}

const previousProvider = globalThis.__HEX_AI_PROVIDER__;
const previousStorage = globalThis.localStorage;
const writes = [];
globalThis.localStorage = { setItem(key, value) { writes.push([key, value]); } };

try {
  const routed = provider();

  // `worker` is a public alias of Gemini for turn routing. All read-side
  // provider state must observe the same canonical provider identity.
  globalThis.__HEX_AI_PROVIDER__ = 'gemini';
  const geminiStatus = routed.status();
  const geminiSelection = routed.getSelection();

  globalThis.__HEX_AI_PROVIDER__ = 'worker';
  assert.equal(routed.selected({}), routed.gemini);
  assert.deepEqual(routed.status(), geminiStatus, 'worker status must be identical to canonical Gemini status');
  assert.deepEqual(routed.getSelection(), geminiSelection, 'worker selection must be identical to canonical Gemini selection');
  assert.equal(routed.getSelection().provider, 'gemini');

  // Both ChatGPT spellings likewise resolve to the same externally reported
  // provider identity and preserve bridge selection state.
  globalThis.__HEX_AI_PROVIDER__ = 'chatgpt';
  const chatgptStatus = routed.status();
  const chatgptSelection = routed.getSelection();
  globalThis.__HEX_AI_PROVIDER__ = 'chatgpt-web';
  assert.deepEqual(routed.status(), chatgptStatus);
  assert.deepEqual(routed.getSelection(), chatgptSelection);
  assert.equal(routed.getSelection().provider, 'chatgpt-web');

  // Existing fail-closed routing and write-side alias canonicalization stay
  // intact; the fix must not loosen provider identity validation.
  assert.throws(() => routed.selected({ provider: 'unknown-provider' }), (error) => error?.type === 'provider_error');
  await assert.rejects(
    () => routed.setSelection({ provider: 'unknown-provider' }),
    (error) => error?.type === 'provider_error',
  );
  await routed.setSelection({ provider: 'worker' });
  assert.equal(globalThis.__HEX_AI_PROVIDER__, 'gemini');
  assert.deepEqual(writes.at(-1), ['hex.ai.provider', 'gemini']);
} finally {
  if (previousProvider === undefined) delete globalThis.__HEX_AI_PROVIDER__;
  else globalThis.__HEX_AI_PROVIDER__ = previousProvider;
  if (previousStorage === undefined) delete globalThis.localStorage;
  else globalThis.localStorage = previousStorage;
}

console.log('issue-4598 userscript provider alias regression: PASS');
