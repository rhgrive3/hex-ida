import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeRequest } from '../js/ai/provider/worker-protocol.js';

function base(thinkingLevel) {
  return {
    question: 'what does this function do?',
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
    currentFunction: { address: '0x1000', assembly: 'ret' },
  };
}

test('issue #6149 - string thinking levels are accepted', () => {
  for (const level of ['minimal', 'low', 'medium', 'high']) {
    assert.equal(normalizeRequest(base(level)).thinkingLevel, level);
  }
});

test('issue #6149 - missing thinkingLevel defaults to high', () => {
  assert.equal(normalizeRequest(base(undefined)).thinkingLevel, 'high');
  assert.equal(normalizeRequest(base(null)).thinkingLevel, 'high');
});

test('issue #6149 - structured values are not promoted to canonical reasoning levels', () => {
  for (const invalid of [['minimal'], ['high'], { toString: () => 'high' }, 1, true, ['low']]) {
    assert.throws(
      () => normalizeRequest(base(invalid)),
      (error) => error instanceof Error
        && error.code === 'invalid_thinking_level'
        && error.status === 422,
      `thinkingLevel ${JSON.stringify(Array.isArray(invalid) || typeof invalid === 'object' ? JSON.stringify(invalid) : String(invalid))} must fail closed`,
    );
  }
});

test('issue #6149 - unknown strings still fail closed with invalid_thinking_level', () => {
  assert.throws(() => normalizeRequest(base('maximum')), /invalid_thinking_level|minimal, low, medium/);
});

test('issue #6149 - normalized value flows into legacy Gemini generation_config', async () => {
  const worker = (await import('../worker.js')).default;
  const originalFetch = globalThis.fetch;
  let upstreamBody = null;
  globalThis.fetch = async (_url, options) => {
    upstreamBody = JSON.parse(options.body);
    return new Response('event: interaction.completed\ndata: {"event_type":"interaction.completed"}\n\n', {
      status: 200, headers: { 'content-type': 'text/event-stream' },
    });
  };
  try {
    const quotaStub = {
      async acquire() { return { allowed: true, token: 'issue-6149-test-lease' }; },
      async release() { return { released: true }; },
    };
    const response = await worker.fetch(new Request('https://example.test/api/gemini', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(base('medium')),
    }), {
      GEMINI_API_KEY: 'test-key',
      AI_QUOTA: { getByName: () => quotaStub },
      ASSETS: { fetch: () => new Response('asset') },
    });
    assert.equal(response.status, 200);
    await response.text();
    assert.equal(upstreamBody.generation_config.thinking_level, 'medium');
  } finally { globalThis.fetch = originalFetch; }
});
