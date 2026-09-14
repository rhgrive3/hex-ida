import assert from 'node:assert/strict';
import { installChatGPTWebBridge } from '../../js/userscript/chatgpt-bridge.js';

await supervisorPromptModesUseStructuredCompletion();
await explicitCompletionModeDoesNotDependOnPromptText();
await ordinaryRequestsRemainOrdinary();
console.log('dev supervisor continuation structured completion: ok');

async function supervisorPromptModesUseStructuredCompletion() {
  for (const [name, prompt] of [
    ['BOOTSTRAP', 'HEX DEV SUPERVISOR PROTOCOL hex-dev-supervisor-v1\n<HEX_DEV_DATA>{}</HEX_DEV_DATA>'],
    ['CONTINUATION', 'HEX DEV SUPERVISOR CONTINUATION hex-dev-supervisor-v1\n<HEX_DEV_DATA>{}</HEX_DEV_DATA>'],
  ]) {
    const observed = [];
    const bridge = makeBridge(observed);
    await bridge.request(prompt, { sessionKey: name.toLowerCase() });
    assert.equal(
      observed[0].options.completionMode,
      'single-json-object',
      `${name} must use structured early completion so a completed decision cannot be stranded behind stale iPad/WebKit streaming state`,
    );
    assert.equal(observed[0].options.timeoutMs, undefined, 'the inner TurnController default must remain bounded');
  }
}

async function explicitCompletionModeDoesNotDependOnPromptText() {
  const observed = [];
  const bridge = makeBridge(observed);
  await bridge.request('transport wording intentionally decoupled from completion semantics', {
    sessionKey: 'explicit',
    completionMode: 'single-json-object',
  });
  assert.equal(
    observed[0].options.completionMode,
    'single-json-object',
    'a caller-owned completion contract must override prompt classification',
  );
}

async function ordinaryRequestsRemainOrdinary() {
  const observed = [];
  const bridge = makeBridge(observed);
  await bridge.request('ordinary ChatGPT request', { sessionKey: 'ordinary' });
  assert.equal(observed[0].options.completionMode, null, 'ordinary Chat/Worker prose must not be stopped by Supervisor JSON completion logic');
}

function makeBridge(observed) {
  delete globalThis.__HEX_CHATGPT_BRIDGE__;
  const conversation = { id: 'alpha', url: 'https://chatgpt.com/c/alpha' };
  return installChatGPTWebBridge({
    adapter: {
      composer: () => ({}),
      currentSelection: () => ({}),
      isGenerating: () => false,
      conversation: () => conversation,
      errorState: () => null,
      stop() {},
    },
    router: {
      route: async () => ({ conversation, isNew: false }),
      bind: (_key, value) => value,
      binding: () => conversation,
    },
    models: { select: async () => ({}) },
    turns: {
      async run(prompt, options) {
        observed.push({ prompt, options });
        return { text: '{"type":"final","answer":"ok"}', conversation, turnId: `turn-${observed.length}` };
      },
    },
  });
}
