/* Regression test for #6144: the AI Worker must apply the same hard byte
   ceiling to upstream failure bodies as to success bodies — no unbounded
   response.json() in readUpstreamFailure, on any status. */
import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../worker.js';
import {
  isRetryableUpstreamFailure,
  MAX_REQUEST_BYTES,
  MAX_UPSTREAM_RESPONSE_BYTES,
  readLimitedText,
  readUpstreamFailure,
  upstreamError,
} from '../js/ai/provider/worker-transport.js';

const TURN_BODY = JSON.stringify({
  mode: 'chat', style: 'analyst', scope: 'auto',
  context: { request: { goal: 'What is ASLR?' } }, messages: [], tools: [],
});
const quotaStubFor = (counters) => ({
  async acquire() { counters.acquired++; return { allowed: true, token: 'test-lease' }; },
  async release(token) { assert.equal(token, 'test-lease'); counters.released++; return { released: true }; },
});
const ENV_BASE = (quotaStub) => ({
  GEMINI_API_KEY: 'server-only',
  AI_QUOTA: { getByName: () => quotaStub },
  ASSETS: { fetch: () => new Response('asset') },
});

test('issue-6144: small failure body still yields its error code', async () => {
  const response = new Response(JSON.stringify({ error: { code: 'temporary' } }), { status: 503 });
  assert.deepEqual(await readUpstreamFailure(response), { code: 'temporary' });
  const legacy = new Response(JSON.stringify({ error: { status: 'OVERLOADED' } }), { status: 503 });
  assert.deepEqual(await readUpstreamFailure(legacy), { code: 'overloaded' });
});

test('issue-6144: Content-Length over ceiling is not materialized on the failure path', async () => {
  const response = new Response(JSON.stringify({ error: { code: 'temporary' } }), {
    status: 503,
    headers: { 'content-type': 'application/json', 'content-length': String(MAX_UPSTREAM_RESPONSE_BYTES + 1) },
  });
  // Must reject the pre-read instead of parsing the (lying, tiny) body.
  assert.deepEqual(await readUpstreamFailure(response), { code: null });
});

test('issue-6144: chunked oversize failure body is cancelled mid-stream', async () => {
  const chunk = new Uint8Array(1024 * 1024).fill(120);
  let reads = 0;
  const stream = new ReadableStream({
    pull(controller) { reads++; controller.enqueue(chunk); },
  });
  const response = new Response(stream, { status: 503 });
  assert.deepEqual(await readUpstreamFailure(response), { code: null });
  assert.ok(reads <= 4, `failure stream must stop early once over budget (reads=${reads})`);
});

test('issue-6144: huge 503/429 bodies do not fully materialize', async () => {
  for (const status of [503, 429]) {
    const big = 'x'.repeat(3 * 1024 * 1024);
    const response = new Response(JSON.stringify({ error: { code: 'temporary', padding: big } }), { status });
    assert.deepEqual(await readUpstreamFailure(response), { code: null });
  }
});

test('issue-6144: malformed failure JSON keeps the existing null-code mapping', async () => {
  const response = new Response('not-json{{{', { status: 503 });
  assert.deepEqual(await readUpstreamFailure(response), { code: null });
});

test('issue-6144: retryable-status and retry-after semantics are unchanged', async () => {
  assert.equal(isRetryableUpstreamFailure(503, 'temporary'), true);
  assert.equal(isRetryableUpstreamFailure(503, null), true);
  assert.equal(isRetryableUpstreamFailure(429, 'quota_exceeded'), false);
  assert.equal(isRetryableUpstreamFailure(429, null), true);
  assert.equal(isRetryableUpstreamFailure(400, 'temporary'), false);
  const quota = await upstreamError(429, 'quota_exceeded', null);
  assert.equal(quota.status, 429);
  const limited = await upstreamError(429, 'other', '2');
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '2');
});

test('issue-6144: provider request/input budgets are not weakened', async () => {
  assert.equal(MAX_REQUEST_BYTES, 512 * 1024);
  const big = new Request('https://example.test/', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': String(MAX_REQUEST_BYTES + 1) },
    body: '{}',
  });
  await assert.rejects(readLimitedText(big), /too large/);
});

test('issue-6144: non-retryable huge failure body ends bounded end-to-end', async () => {
  const padding = 'x'.repeat(MAX_UPSTREAM_RESPONSE_BYTES + 1024);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ error: { code: 'temporary', padding } }),
    { status: 400, headers: { 'content-type': 'application/json' } },
  );
  try {
    const counters = { acquired: 0, released: 0 };
    const response = await worker.fetch(new Request('https://example.test/api/ai/turn', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: TURN_BODY,
    }), ENV_BASE(quotaStubFor(counters)));
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.equal(body.error.code, 'upstream_request_rejected');
    assert.equal(counters.released, 1, 'quota cleanup must run on the failure path too');
  } finally { globalThis.fetch = originalFetch; }
});
