import assert from 'node:assert/strict';
import { MessageChannel } from 'node:worker_threads';
import { WorkerAIProvider } from '../js/ai/provider/index.js';
import { setAuthContext } from '../js/auth/runtime-context.js';
import { createAuthRpcServer, createAuthRpcClient } from '../js/auth/rpc.js';
import { streamGemini } from '../js/gemini.js';

const capability = 'capability.fixture.token';
const context = {
  auth: {
    aiCapability: async () => ({ capability, expiresAt: Date.now() + 60_000 }),
  },
  close() {},
};
const release = setAuthContext(context);
try {
  let workerCalls = 0;
  const provider = new WorkerAIProvider({
    fetchImpl: async (url, options = {}) => {
      workerCalls++;
      assert.equal(url, '/api/ai/turn');
      assert.equal(new Headers(options.headers).get('x-hex-ai-capability'), capability);
      return new Response(JSON.stringify({ decision: { type: 'final', answer: 'ok' } }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const decision = await provider.nextTurn({
    mode: 'chat', style: 'analyst', scope: 'auto', effectiveScope: 'auto',
    messages: [{ role: 'user', content: 'x' }], context: { request: { goal: 'x' } }, tools: [],
  });
  assert.equal(decision.answer, 'ok');
  assert.equal(workerCalls, 1);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options = {}) => {
    assert.equal(new Headers(options.headers).get('x-hex-ai-capability'), capability);
    return new Response('event: interaction.completed\ndata: {"event_type":"interaction.completed"}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  try {
    let done = false;
    await streamGemini({ question: 'x' }, { onDone: (value) => { done = value; } });
    assert.equal(done, true);
  } finally { globalThis.fetch = originalFetch; }
} finally { release(); }

{
  const { port1, port2 } = new MessageChannel();
  const auth = {
    aiCapability: async () => ({ capability: 'rpc-short-lived-only', expiresAt: 123 }),
    subscribe: () => () => {},
    refresh: async () => ({ authenticated: true, capabilities: {} }),
  };
  const server = createAuthRpcServer({ port: port1, auth, showLogin() {} });
  const client = createAuthRpcClient({ port: port2, timeoutMs: 1000 });
  try {
    assert.deepEqual(await client.aiCapability(), { capability: 'rpc-short-lived-only', expiresAt: 123 });
  } finally { client.close(); server.close(); port1.close(); port2.close(); }
}

console.log('issue-8750-ai-client-capability: PASS');
