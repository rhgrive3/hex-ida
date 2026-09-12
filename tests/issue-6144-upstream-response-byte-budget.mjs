import assert from 'node:assert/strict';
import test from 'node:test';

import worker from '../worker.js';
import {
  HttpError, isRetryableUpstreamFailure, MAX_RESPONSE_BYTES, readLimitedText, readUpstreamFailure,
} from '../js/ai/provider/worker-transport.js';

const TURN_BODY = JSON.stringify({
  mode:'chat',
  style:'analyst',
  scope:'auto',
  context:{ request:{ goal:'What is ASLR?' } },
  messages:[],
  tools:[],
});

function envFor() {
  const quotaStub = {
    async acquire() { return { allowed:true, token:'issue-6144-lease' }; },
    async release() { return { released:true }; },
  };
  return {
    GEMINI_API_KEY:'server-only',
    AI_QUOTA:{ getByName:() => quotaStub },
    ASSETS:{ fetch:() => new Response('asset') },
  };
}

function turnRequest() {
  return new Request('https://example.test/api/ai/turn', {
    method:'POST',
    headers:{ 'content-type':'application/json' },
    body:TURN_BODY,
  });
}

function countingChunkStream(chunkSize, chunkCount) {
  const state = { pulls:0, canceled:false };
  const stream = new ReadableStream({
    pull(controller) {
      state.pulls += 1;
      if (state.pulls > chunkCount) { controller.close(); return; }
      controller.enqueue(new Uint8Array(chunkSize).fill(0x78));
    },
    cancel() { state.canceled = true; },
  });
  return { stream, state };
}

async function withStubbedFetch(response, run) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => response;
  try { return await run(); } finally { globalThis.fetch = originalFetch; }
}

test('issue-6144: small valid upstream JSON still normalizes through handleAITurn', async () => {
  const response = new Response(
    JSON.stringify({ steps:[{ type:'function_call', name:'submit_hex_result', arguments:{ answer:'safe answer', evidenceIds:[] } }] }),
    { status:200, headers:{ 'content-type':'application/json' } },
  );
  await withStubbedFetch(response, async () => {
    const result = await worker.fetch(turnRequest(), envFor());
    assert.equal(result.status, 200);
    assert.equal((await result.json()).decision.answer, 'safe answer');
  });
});

test('issue-6144: Content-Length over the ceiling is rejected before body materialization', async () => {
  const { stream, state } = countingChunkStream(16, 100);
  const announced = new Response(stream, {
    status:200,
    headers:{ 'content-type':'application/json', 'content-length':String(MAX_RESPONSE_BYTES * 10) },
  });
  await assert.rejects(readLimitedText(announced, MAX_RESPONSE_BYTES), (error) => error instanceof HttpError && error.status === 413);
  assert.ok(state.pulls <= 1);
  await withStubbedFetch(new Response('tiny', {
    status:200,
    headers:{ 'content-type':'application/json', 'content-length':String(MAX_RESPONSE_BYTES * 10) },
  }), async () => {
    const result = await worker.fetch(turnRequest(), envFor());
    assert.equal(result.status, 502);
    assert.equal((await result.json()).error.code, 'invalid_model_output');
  });
});

test('issue-6144: chunked upstream response exceeding the ceiling mid-stream is canceled', async () => {
  const { stream, state } = countingChunkStream(1024 * 1024, 8);
  await withStubbedFetch(new Response(stream, { status:200, headers:{ 'content-type':'application/json' } }), async () => {
    const result = await worker.fetch(turnRequest(), envFor());
    assert.equal(result.status, 502);
    assert.equal((await result.json()).error.code, 'invalid_model_output');
  });
  assert.equal(state.canceled, true);
  assert.ok(state.pulls <= 8);

  const small = countingChunkStream(1024, 4);
  const bounded = new Response(small.stream, { status:200 });
  await assert.rejects(readLimitedText(bounded, 2 * 1024), (error) => error instanceof HttpError && error.status === 413);
  assert.equal(small.state.canceled, true);
});

test('issue-6144: readUpstreamFailure does not fully materialize oversized failure bodies', async () => {
  const { stream, state } = countingChunkStream(64 * 1024, 64);
  const streamed = new Response(stream, { status:503 });
  assert.deepEqual(await readUpstreamFailure(streamed, 32 * 1024), { code:null });
  assert.equal(state.canceled, true);

  const buffered = new Response('x'.repeat(1024 * 1024), { status:503 });
  assert.deepEqual(await readUpstreamFailure(buffered, 1024), { code:null });
});

test('issue-6144: bounded failure bodies keep error-code extraction and retry semantics', async () => {
  const temporary = new Response(JSON.stringify({ error:{ code:'temporary' } }), { status:503 });
  assert.deepEqual(await readUpstreamFailure(temporary), { code:'temporary' });
  assert.equal(isRetryableUpstreamFailure(503, 'temporary'), true);
  assert.equal(isRetryableUpstreamFailure(503, null), true);

  const quota = new Response(JSON.stringify({ error:{ code:'quota_exceeded' } }), { status:429 });
  assert.deepEqual(await readUpstreamFailure(quota), { code:'quota_exceeded' });
  assert.equal(isRetryableUpstreamFailure(429, 'quota_exceeded'), false);
});

test('issue-6144: malformed upstream JSON still maps to invalid_model_output', async () => {
  await withStubbedFetch(new Response('not-json{{{', { status:200, headers:{ 'content-type':'application/json' } }), async () => {
    const result = await worker.fetch(turnRequest(), envFor());
    assert.equal(result.status, 502);
    assert.equal((await result.json()).error.code, 'invalid_model_output');
  });
});
