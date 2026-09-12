import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkerAIProvider } from '../../../js/ai/provider/index.js';

const CAP = 64 * 1024;
const encoder = new TextEncoder();

function readerResponse(chunks, { contentLength = null, text = '{}' } = {}) {
  let next = 0;
  const state = {
    readCalls: 0,
    cancelCalls: 0,
    releaseCalls: 0,
    textCalls: 0,
    cancelReason: null,
  };
  const body = {
    getReader() {
      return {
        async read() {
          state.readCalls++;
          if (next >= chunks.length) return { done: true, value: undefined };
          return { done: false, value: chunks[next++] };
        },
        async cancel(reason) {
          state.cancelCalls++;
          state.cancelReason = reason;
        },
        releaseLock() { state.releaseCalls++; },
      };
    },
    async cancel(reason) {
      state.cancelCalls++;
      state.cancelReason = reason;
    },
  };
  return {
    state,
    response: {
      ok: true,
      status: 200,
      headers: { get: (name) => name.toLowerCase() === 'content-length' ? contentLength : null },
      body,
      async text() {
        state.textCalls++;
        return text;
      },
    },
  };
}

test('#5089 capabilities accept a valid bounded response', async () => {
  const payload = JSON.stringify({ capabilities: { maxTools: 3, contextTokens: 12345 } });
  const fixture = readerResponse([encoder.encode(payload)]);
  const provider = new WorkerAIProvider({ fetchImpl: async () => fixture.response });

  const capabilities = await provider.prepareCapabilities();

  assert.equal(capabilities.maxTools, 3);
  assert.equal(capabilities.contextTokens, 12345);
  assert.equal(fixture.state.textCalls, 0, 'capability reads should use the bounded streaming reader');
  assert.equal(fixture.state.cancelCalls, 0);
});

test('#5089 declared oversized Content-Length is rejected before body materialization', async () => {
  const payload = JSON.stringify({ capabilities: { maxTools: 1 } });
  const fixture = readerResponse([encoder.encode(payload)], {
    contentLength: String(CAP + 1),
    text: payload,
  });
  const provider = new WorkerAIProvider({ fetchImpl: async () => fixture.response });

  const capabilities = await provider.prepareCapabilities();

  assert.equal(capabilities.maxTools, 10, 'oversized preflight must keep conservative defaults');
  assert.equal(fixture.state.textCalls, 0, 'declared oversize must be rejected before response.text()');
  assert.equal(fixture.state.readCalls, 0, 'declared oversize must be rejected before streaming reads');
  assert.equal(fixture.state.cancelCalls, 1, 'declared oversized body should be cancelled');
  assert.equal(fixture.state.cancelReason, 'response-too-large');
});

test('#5089 unknown-length stream stops immediately after crossing 64 KiB', async () => {
  const chunks = [
    new Uint8Array(32 * 1024).fill(0x78),
    new Uint8Array(32 * 1024).fill(0x78),
    Uint8Array.of(0x78),
    new Uint8Array(4 * 1024 * 1024).fill(0x78),
  ];
  const fixture = readerResponse(chunks, {
    text: 'x'.repeat(CAP + 1),
  });
  const provider = new WorkerAIProvider({ fetchImpl: async () => fixture.response });

  const capabilities = await provider.prepareCapabilities();

  assert.equal(capabilities.maxTools, 10);
  assert.equal(fixture.state.textCalls, 0, 'streaming preflight must not materialize the full body');
  assert.equal(fixture.state.readCalls, 3, 'reader must stop on the first chunk that crosses the cap');
  assert.equal(fixture.state.cancelCalls, 1, 'oversized stream must cancel the reader');
  assert.equal(fixture.state.cancelReason, 'response-too-large');
});


test('#5089 a misleading small Content-Length cannot bypass the streaming cap', async () => {
  const chunks = [
    new Uint8Array(CAP).fill(0x78),
    Uint8Array.of(0x78),
    new Uint8Array(1024 * 1024).fill(0x78),
  ];
  const fixture = readerResponse(chunks, { contentLength: '1' });
  const provider = new WorkerAIProvider({ fetchImpl: async () => fixture.response });

  const capabilities = await provider.prepareCapabilities();

  assert.equal(capabilities.maxTools, 10);
  assert.equal(fixture.state.textCalls, 0);
  assert.equal(fixture.state.readCalls, 2, 'declared length is only an early-reject hint, never an authority to skip the stream cap');
  assert.equal(fixture.state.cancelCalls, 1);
  assert.equal(fixture.state.cancelReason, 'response-too-large');
});

test('#5089 exactly 64 KiB remains admissible', async () => {
  const prefix = '{"capabilities":{"maxTools":4},"padding":"';
  const suffix = '"}';
  const padding = 'x'.repeat(CAP - encoder.encode(prefix + suffix).byteLength);
  const payload = prefix + padding + suffix;
  assert.equal(encoder.encode(payload).byteLength, CAP);
  const fixture = readerResponse([encoder.encode(payload)], { contentLength: String(CAP) });
  const provider = new WorkerAIProvider({ fetchImpl: async () => fixture.response });

  const capabilities = await provider.prepareCapabilities();

  assert.equal(capabilities.maxTools, 4);
  assert.equal(fixture.state.textCalls, 0);
  assert.equal(fixture.state.cancelCalls, 0, 'the contract rejects only payloads larger than 64 KiB');
});

test('#5089 malformed bounded JSON keeps conservative fallback', async () => {
  const fixture = readerResponse([encoder.encode('{not-json')]);
  const provider = new WorkerAIProvider({ fetchImpl: async () => fixture.response });

  const capabilities = await provider.prepareCapabilities();

  assert.equal(capabilities.maxTools, 10);
  assert.equal(fixture.state.textCalls, 0);
  assert.equal(fixture.state.cancelCalls, 0);
});
