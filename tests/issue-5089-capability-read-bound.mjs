import assert from 'node:assert/strict';
import { WorkerAIProvider } from '../js/ai/provider/index.js';

const LIMIT = 64 * 1024;

function streamingResponse({ totalBytes, chunkBytes = 16 * 1024, contentLength = null }) {
  const state = { delivered: 0, chunks: 0, cancelled: false, textCalled: false };
  const headers = { get: (name) => (String(name).toLowerCase() === 'content-length' ? contentLength : 'application/json') };
  return {
    state,
    response: {
      ok: true,
      status: 200,
      headers,
      body: {
        getReader() {
          return {
            async read() {
              if (state.delivered >= totalBytes) return { done: true, value: undefined };
              const size = Math.min(chunkBytes, totalBytes - state.delivered);
              state.delivered += size;
              state.chunks += 1;
              return { done: false, value: new Uint8Array(size) };
            },
            async cancel() { state.cancelled = true; },
            releaseLock() {},
          };
        },
        async cancel() { state.cancelled = true; },
      },
      text: async () => { state.textCalled = true; return `{"configured":true,"padding":"${'x'.repeat(totalBytes)}"}`; },
    },
  };
}

// Streaming body far over the limit: the reader must be cancelled at the limit,
// not after materializing the whole body.
{
  const { state, response } = streamingResponse({ totalBytes: 1024 * 1024 });
  const provider = new WorkerAIProvider({ fetchImpl: async () => response });
  const before = provider.getCapabilities();
  const caps = await provider.prepareCapabilities();
  assert.deepEqual(caps, before, 'an oversize capability body must fall back to the conservative envelope');
  assert.equal(state.cancelled, true, 'the over-limit stream must be cancelled');
  assert.equal(state.textCalled, false, 'the body must not be re-materialized via response.text()');
  assert.ok(state.delivered <= LIMIT + 16 * 1024, `read must stop at the limit, delivered=${state.delivered}`);
}

// Content-Length over the limit: reject before reading the body at all.
{
  const { state, response } = streamingResponse({ totalBytes: 1024 * 1024, contentLength: String(1024 * 1024) });
  const provider = new WorkerAIProvider({ fetchImpl: async () => response });
  const before = provider.getCapabilities();
  const caps = await provider.prepareCapabilities();
  assert.deepEqual(caps, before);
  assert.equal(state.textCalled, false, 'an over-limit Content-Length must not be read');
  assert.equal(state.delivered, 0, 'an over-limit Content-Length must deliver zero body bytes');
}

// A small body still flows through.
{
  const payload = JSON.stringify({ configured: true, capabilities: { provider: 'gemini', maxTools: 7 } });
  const bytes = new TextEncoder().encode(payload);
  let delivered = 0;
  const response = {
    ok: true,
    status: 200,
    headers: { get: () => String(bytes.byteLength) },
    body: {
      getReader() {
        let done = false;
        return {
          async read() {
            if (done) return { done: true, value: undefined };
            done = true;
            delivered += bytes.byteLength;
            return { done: false, value: bytes };
          },
          async cancel() {},
          releaseLock() {},
        };
      },
    },
    text: async () => payload,
  };
  const provider = new WorkerAIProvider({ fetchImpl: async () => response });
  const caps = await provider.prepareCapabilities();
  assert.equal(caps.maxTools, 7, 'a small capability body must still be adopted');
  assert.equal(provider.isConfigured(), true);
  assert.ok(delivered <= LIMIT);
}

console.log('issue-5089-capability-read-bound: ok');
