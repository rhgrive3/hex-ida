/* Regression test for #6091: the AI Worker turn must enforce a byte budget on
   the successful upstream response before JSON parse (no unbounded
   response.json() materialization). */
import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../worker.js';
import {
  HttpError,
  MAX_UPSTREAM_RESPONSE_BYTES,
  readLimitedUpstreamJson,
  readLimitedUpstreamText,
} from '../js/ai/provider/worker-transport.js';

const TURN_BODY = JSON.stringify({
  mode: 'chat', style: 'analyst', scope: 'auto',
  context: { request: { goal: 'What is ASLR?' } }, messages: [], tools: [],
});
const ENV_BASE = (quotaStub) => ({
  GEMINI_API_KEY: 'server-only',
  AI_QUOTA: { getByName: () => quotaStub },
  ASSETS: { fetch: () => new Response('asset') },
});
const quotaStubFor = (counters) => ({
  async acquire() { counters.acquired++; return { allowed: true, token: 'test-lease' }; },
  async release(token) { assert.equal(token, 'test-lease'); counters.released++; return { released: true }; },
});

test('issue-6091: small valid upstream JSON still normalizes', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ steps: [{ type: 'function_call', name: 'submit_hex_result', arguments: { answer: 'safe answer', evidenceIds: [] } }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
  try {
    const counters = { acquired: 0, released: 0 };
    const response = await worker.fetch(new Request('https://example.test/api/ai/turn', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: TURN_BODY,
    }), ENV_BASE(quotaStubFor(counters)));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.decision.answer, 'safe answer');
    assert.equal(counters.released, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test('issue-6091: Content-Length over the ceiling rejects before materialization', async () => {
  const response = new Response('tiny', {
    status: 200,
    headers: { 'content-type': 'application/json', 'content-length': String(MAX_UPSTREAM_RESPONSE_BYTES + 1) },
  });
  await assert.rejects(readLimitedUpstreamText(response), (error) => (
    error instanceof HttpError && error.code === 'upstream_response_too_large'
  ));
});

test('issue-6091: chunked oversized body without Content-Length is cancelled mid-stream', async () => {
  const chunk = new Uint8Array(512).fill(120); // 'x'
  let reads = 0;
  const stream = new ReadableStream({
    pull(controller) {
      reads++;
      controller.enqueue(chunk);
    },
  });
  const response = new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } });
  await assert.rejects(readLimitedUpstreamText(response, 1024), (error) => (
    error instanceof HttpError && error.code === 'upstream_response_too_large'
  ));
  assert.ok(reads <= 4, `stream must stop early once over budget (reads=${reads})`);
});

test('issue-6091: response at exactly the limit is accepted', async () => {
  const text = 'abcd';
  const response = new Response(text, {
    status: 200,
    headers: { 'content-type': 'application/json', 'content-length': '4' },
  });
  assert.equal(await readLimitedUpstreamText(response, 4), text);
  const json = new Response(JSON.stringify({ ok: true }), { status: 200 });
  const parsed = await readLimitedUpstreamJson(json);
  assert.deepEqual(parsed, { ok: true });
});

test('issue-6091: invalid JSON still maps to invalid_model_output', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('not-json{{{', { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const counters = { acquired: 0, released: 0 };
    const response = await worker.fetch(new Request('https://example.test/api/ai/turn', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: TURN_BODY,
    }), ENV_BASE(quotaStubFor(counters)));
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.equal(body.error.code, 'invalid_model_output');
    assert.equal(counters.released, 1, 'quota must be released on malformed output');
  } finally { globalThis.fetch = originalFetch; }
});

test('issue-6091: oversize valid upstream JSON ends bounded with quota cleanup', async () => {
  const padding = 'A'.repeat(MAX_UPSTREAM_RESPONSE_BYTES + 1024);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ steps: [{ type: 'function_call', name: 'submit_hex_result', arguments: { answer: padding } }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
  try {
    const counters = { acquired: 0, released: 0 };
    const response = await worker.fetch(new Request('https://example.test/api/ai/turn', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: TURN_BODY,
    }), ENV_BASE(quotaStubFor(counters)));
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.equal(body.error.code, 'upstream_response_too_large');
    assert.equal(counters.acquired, 1);
    assert.equal(counters.released, 1, 'quota/retry cleanup must run on the too-large path');
  } finally { globalThis.fetch = originalFetch; }
});
