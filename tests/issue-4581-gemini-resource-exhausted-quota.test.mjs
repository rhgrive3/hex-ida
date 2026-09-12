import assert from 'node:assert/strict';
import worker from '../worker.js';
import {
  readUpstreamFailure, isRetryableUpstreamFailure, upstreamError,
} from '../js/ai/provider/worker-transport.js';

function jsonResponse(body, status = 429) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const GEMINI_QUOTA_WITH_METADATA = {
  error: {
    code: 429,
    message: 'Resource has been exhausted (e.g. check quota).',
    status: 'RESOURCE_EXHAUSTED',
    details: [
      { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ reason: 'PER_PROJECT_QUOTA', quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests' }] },
      { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'QUOTA_EXCEEDED', domain: 'googleapis.com', metadata: { quotaLimit: '0' } },
    ],
  },
};

const GEMINI_QUOTA_BILLING_MESSAGE = {
  error: {
    code: 429,
    message: 'You exceeded your current quota, please check your plan and billing details.',
    status: 'RESOURCE_EXHAUSTED',
  },
};

const GEMINI_TRANSIENT_CAPACITY = {
  error: {
    code: 429,
    message: 'Resource is temporarily unavailable due to high demand. Please retry in a few seconds.',
    status: 'RESOURCE_EXHAUSTED',
    details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'RATE_LIMIT_EXCEEDED', domain: 'googleapis.com', metadata: { retryDelay: '5s' } }],
  },
};

// req1 + req2: a Gemini RESOURCE_EXHAUSTED carrying quota metadata normalizes to
// the permanent quota-exhaustion path and must not be retried.
{
  const { code } = await readUpstreamFailure(jsonResponse(GEMINI_QUOTA_WITH_METADATA));
  assert.equal(code, 'quota_exceeded', 'Gemini RESOURCE_EXHAUSTED with quota metadata must normalize to quota_exceeded');
  assert.equal(isRetryableUpstreamFailure(429, code), false);
  const out = await upstreamError(429, code, null).json();
  assert.equal(out.error.code, 'upstream_quota_exceeded');
}

// req2 (billing-message variant) also reaches the quota path.
{
  const { code } = await readUpstreamFailure(jsonResponse(GEMINI_QUOTA_BILLING_MESSAGE));
  assert.equal(code, 'quota_exceeded');
  assert.equal(isRetryableUpstreamFailure(429, code), false);
}

// req3: transient capacity RESOURCE_EXHAUSTED (no quota metadata) stays retryable.
{
  const { code } = await readUpstreamFailure(jsonResponse(GEMINI_TRANSIENT_CAPACITY));
  assert.equal(isRetryableUpstreamFailure(429, code), true, 'transient capacity throttling must remain retryable');
  const out = await upstreamError(429, code, null).json();
  assert.equal(out.error.code, 'upstream_rate_limited');
}

// req4: existing string error.code='quota_exceeded' path is preserved.
{
  const { code } = await readUpstreamFailure(jsonResponse({ error: { code: 'quota_exceeded', message: 'daily quota' } }));
  assert.equal(code, 'quota_exceeded');
  assert.equal(isRetryableUpstreamFailure(429, code), false);
}

// req5: Groq/OpenAI-compatible 429 forms keep their existing classification.
{
  const openai = await readUpstreamFailure(jsonResponse({ error: { message: 'Rate limit reached', type: 'rate_limit_error', code: 'rate_limit_exceeded' } }));
  assert.equal(openai.code, 'rate_limit_exceeded');
  assert.equal(isRetryableUpstreamFailure(429, openai.code), true);
  const insufficient = await readUpstreamFailure(jsonResponse({ error: { message: 'insufficient quota', type: 'insufficient_quota', code: 'insufficient_quota' } }));
  assert.equal(insufficient.code, 'insufficient_quota');
  assert.equal(isRetryableUpstreamFailure(429, insufficient.code), true, 'unchanged provider string codes keep prior retry behaviour');
}

// req6: an unparseable 429 body falls back safely to generic rate limit.
{
  const { code } = await readUpstreamFailure(new Response('<html>gateway</html>', { status: 429, headers: { 'content-type': 'text/html' } }));
  assert.equal(code, null);
  assert.equal(isRetryableUpstreamFailure(429, code), true);
}

// End-to-end: the Worker must not burn retries on a Gemini quota exhaustion.
{
  let quotaSerial = 0;
  const env = {
    GEMINI_API_KEY: 'server-only',
    AI_QUOTA: { getByName: () => ({ async acquire() { return { allowed: true, token: `q-${++quotaSerial}` }; }, async release() { return { released: true }; } }) },
    ASSETS: { fetch: () => new Response('asset') },
  };
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return jsonResponse(GEMINI_QUOTA_WITH_METADATA); };
  try {
    const response = await worker.fetch(new Request('https://example.test/api/ai/turn', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'chat', style: 'analyst', scope: 'auto', context: { request: { goal: 'Explain ASLR' } }, messages: [], tools: [] }),
    }), env);
    assert.equal(response.status, 429);
    assert.equal(calls, 1, 'a permanent quota exhaustion must not be retried');
    assert.equal((await response.json()).error.code, 'upstream_quota_exceeded');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

console.log('#4581 Gemini RESOURCE_EXHAUSTED quota normalization: PASS');
