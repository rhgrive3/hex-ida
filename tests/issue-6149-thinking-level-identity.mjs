// Regression for #6149: normalizeRequest() coerced `thinkingLevel` with
// `String()` before the enum check, so `['minimal']` laundered into the real
// 'minimal' reasoning level that is then sent to the provider's generation
// config. Only a primitive string may match the enum.
import assert from 'node:assert/strict';
import worker from '../worker.js';
import { normalizeRequest } from '../js/ai/provider/worker-protocol.js';

const base = {
  question: 'what does this function do?',
  currentFunction: { address: '0x1000', assembly: 'ret' },
};

{
  for (const [label, invalid] of [
    ['array minimal', ['minimal']],
    ['array high', ['high']],
    ['object', { level: 'minimal' }],
    ['number', 1],
    ['boolean', true],
  ]) {
    assert.throws(
      () => normalizeRequest({ ...base, thinkingLevel: invalid }),
      (error) => error?.code === 'invalid_thinking_level' || /minimal, low, medium, or high/.test(error?.message || ''),
      `${label} thinkingLevel must not launder into a real reasoning level`,
    );
  }
}

{
  // Unspecified keeps the documented default and every primitive enum string
  // remains the value sent to the legacy Gemini provider.
  assert.equal(normalizeRequest(base).thinkingLevel, 'high');
  assert.equal(normalizeRequest({ ...base, thinkingLevel: null }).thinkingLevel, 'high');
  for (const level of ['minimal', 'low', 'medium', 'high']) {
    assert.equal(normalizeRequest({ ...base, thinkingLevel: level }).thinkingLevel, level);
  }
}

{
  // Verify the normalized primitive reaches the legacy provider generation
  // configuration, rather than only testing the local return value.
  const originalFetch = globalThis.fetch;
  let upstream;
  globalThis.fetch = async (_url, options) => {
    upstream = JSON.parse(options.body);
    return new Response('done', { headers: { 'content-type': 'text/event-stream' } });
  };
  try {
    const response = await worker.fetch(new Request('https://example.test/api/gemini', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...base, thinkingLevel: 'minimal' }),
    }), {
      GEMINI_API_KEY: 'test-key',
      AI_QUOTA: {
        getByName() {
          return {
            async acquire() { return { allowed: true, token: 'thinking-level-test' }; },
            async release() {},
          };
        },
      },
    });
    assert.equal(response.status, 200);
    await response.text();
    assert.equal(upstream.generation_config.thinking_level, 'minimal');
  } finally {
    globalThis.fetch = originalFetch;
  }
}
