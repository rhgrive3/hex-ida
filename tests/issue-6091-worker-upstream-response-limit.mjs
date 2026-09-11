/* Regression coverage for #6091: successful upstream responses are bounded
   before JSON materialization, including the exact boundary and quota cleanup. */
import assert from 'node:assert/strict';
import test from 'node:test';

import worker from '../worker.js';
import { MAX_RESPONSE_BYTES, readLimitedText } from '../js/ai/provider/worker-transport.js';

const TURN_BODY = JSON.stringify({
  mode:'chat',
  style:'analyst',
  scope:'auto',
  context:{ request:{ goal:'What is ASLR?' } },
  messages:[],
  tools:[],
});

function envFor(counters) {
  const quotaStub = {
    async acquire() {
      counters.acquired += 1;
      return { allowed:true, token:'issue-6091-lease' };
    },
    async release(token) {
      assert.equal(token, 'issue-6091-lease');
      counters.released += 1;
      return { released:true };
    },
  };
  return {
    GEMINI_API_KEY:'server-only',
    AI_QUOTA:{ getByName:() => quotaStub },
    ASSETS:{ fetch:() => new Response('asset') },
  };
}

function request() {
  return new Request('https://example.test/api/ai/turn', {
    method:'POST',
    headers:{ 'content-type':'application/json' },
    body:TURN_BODY,
  });
}

test('issue-6091: small valid upstream JSON still normalizes and releases quota', async () => {
  const originalFetch = globalThis.fetch;
  const counters = { acquired:0, released:0 };
  globalThis.fetch = async () => new Response(
    JSON.stringify({ steps:[{ type:'function_call', name:'submit_hex_result', arguments:{ answer:'safe answer', evidenceIds:[] } }] }),
    { status:200, headers:{ 'content-type':'application/json' } },
  );
  try {
    const response = await worker.fetch(request(), envFor(counters));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).decision.answer, 'safe answer');
    assert.deepEqual(counters, { acquired:1, released:1 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('issue-6091: exact response byte limit is accepted', async () => {
  const exact = 'x'.repeat(MAX_RESPONSE_BYTES);
  const response = new Response(exact, {
    status:200,
    headers:{ 'content-length':String(MAX_RESPONSE_BYTES) },
  });
  assert.equal(await readLimitedText(response, MAX_RESPONSE_BYTES), exact);
});

test('issue-6091: invalid upstream JSON returns invalid_model_output and releases quota', async () => {
  const originalFetch = globalThis.fetch;
  const counters = { acquired:0, released:0 };
  globalThis.fetch = async () => new Response(
    'not-json{{{',
    { status:200, headers:{ 'content-type':'application/json' } },
  );
  try {
    const response = await worker.fetch(request(), envFor(counters));
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error.code, 'invalid_model_output');
    assert.deepEqual(counters, { acquired:1, released:1 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('issue-6091: oversized worker response is bounded and releases quota', async () => {
  const originalFetch = globalThis.fetch;
  const counters = { acquired:0, released:0 };
  globalThis.fetch = async () => new Response(
    'x'.repeat(MAX_RESPONSE_BYTES + 1),
    { status:200, headers:{ 'content-type':'application/json' } },
  );
  try {
    const response = await worker.fetch(request(), envFor(counters));
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error.code, 'invalid_model_output');
    assert.deepEqual(counters, { acquired:1, released:1 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
