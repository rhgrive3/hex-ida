import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { MessageChannel } from 'node:worker_threads';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

import {
  createEmbedNonce,
  createRpcClient,
  createRpcServer,
  waitForEmbedReady,
} from '../js/userscript/embed-protocol.js';
import { createChatGPTIframeHost } from '../js/userscript/chatgpt-iframe-host.js';
import { createChatGPTSandboxHost } from '../js/userscript/chatgpt-sandbox-host.js';
import { installChatGPTWebBridge } from '../js/userscript/chatgpt-bridge.js';

const BRIDGE_KEY = '__HEX_CHATGPT_BRIDGE__';

await testRpcServerBudgetRejectsStructured();
await testRpcClientAndReadyRejectStructured();
await testIframeHostRejectsStructured();
await testSandboxHostRejectsStructured();
await testBridgeTurnTimeoutRejectsStructured();

console.log('issue-4861 timeout number coercion: ok');

async function testRpcServerBudgetRejectsStructured() {
  const channel = new MessageChannel();
  try {
    assert.throws(() => createRpcServer(channel.port1, { handlers: {}, requestIdTtlMs: ['0'] }), TypeError, 'array TTL must not become a request-id TTL');
    assert.throws(() => createRpcServer(channel.port1, { handlers: {}, requestIdTtlMs: '5' }), TypeError, 'string TTL must not become a request-id TTL');
    assert.throws(() => createRpcServer(channel.port1, { handlers: {}, recentRequestIdLimit: ['1'] }), TypeError, 'array cache limit must not become a request-id cache limit');
    assert.throws(() => createRpcServer(channel.port1, { handlers: {}, recentRequestIdLimit: true }), TypeError, 'boolean cache limit must not become a request-id cache limit');
    assert.throws(() => createRpcServer(channel.port1, { handlers: {}, requestIdTtlMs: { valueOf: () => 5 } }), TypeError, 'object TTL must not be coerced via ToNumber');
    assert.doesNotThrow(() => createRpcServer(channel.port1, { handlers: {}, requestIdTtlMs: 5, recentRequestIdLimit: 2 }).close(), 'primitive finite budget must stay accepted');
    assert.doesNotThrow(() => createRpcServer(channel.port1, { handlers: {}, requestIdTtlMs: 0, recentRequestIdLimit: 0 }).close(), 'explicit 0 domain semantics must be preserved');
  } finally {
    channel.port1.close();
    channel.port2.close();
  }
}

async function testRpcClientAndReadyRejectStructured() {
  const channel = new MessageChannel();
  const nonce = createEmbedNonce();
  try {
    assert.throws(() => createRpcClient(channel.port1, { timeoutMs: ['1'] }), TypeError, 'array timeout must not become an RPC ready/call timeout');
    assert.throws(() => createRpcClient(channel.port1, { timeoutMs: '200' }), TypeError, 'string timeout must not become an RPC timeout');
    assert.throws(() => createRpcClient(channel.port1, { timeoutMs: true }), TypeError, 'boolean timeout must not become an RPC timeout');
    assert.doesNotThrow(() => createRpcClient(channel.port1, { timeoutMs: 200 }).close(), 'primitive timeout must stay accepted');
    assert.doesNotThrow(() => createRpcClient(channel.port1, { timeoutMs: 100.7 }).close(), 'primitive fractional timeout must keep floor semantics');

    assert.throws(() => waitForEmbedReady(channel.port1, { nonce, timeoutMs: ['1'] }), TypeError, 'structured ready timeout must not coerce to 1ms');
    assert.doesNotThrow(() => waitForEmbedReady(channel.port1, { nonce, timeoutMs: 25 }).then(() => {}, () => {}), 'primitive ready timeout must stay accepted');
  } finally {
    channel.port1.close();
    channel.port2.close();
  }
}

function fakeIframeDocument() {
  const element = () => ({
    style: {}, attributes: new Map(), dataset: {}, children: [],
    setAttribute() {}, removeAttribute() {}, append() {}, remove() {},
    addEventListener() {}, removeEventListener() {}, contains() { return false; }, focus() {},
  });
  return { createElement: element, documentElement: element(), body: element(), contains() { return false; } };
}

async function testIframeHostRejectsStructured() {
  assert.throws(() => createChatGPTIframeHost({
    src: 'https://ida.rhgrive.workers.dev/embed/chatgpt',
    onPort: () => {},
    documentRef: fakeIframeDocument(),
    windowRef: { addEventListener() {}, removeEventListener() {} },
    MessageChannelCtor: function () {},
    loadTimeoutMs: ['1'],
  }), TypeError, 'array load timeout must not coerce to an iframe bootstrap timeout');

  assert.throws(() => createChatGPTIframeHost({
    src: 'https://ida.rhgrive.workers.dev/embed/chatgpt',
    onPort: () => {},
    documentRef: fakeIframeDocument(),
    windowRef: { addEventListener() {}, removeEventListener() {} },
    MessageChannelCtor: function () {},
    readyTimeoutMs: true,
  }), TypeError, 'boolean ready timeout must not coerce to an iframe app-ready timeout');
}

async function testSandboxHostRejectsStructured() {
  assert.throws(() => createChatGPTSandboxHost({
    cspNonce: 'ab'.repeat(8),
    virtualSrc: 'https://ida.rhgrive.workers.dev/embed/chatgpt?__hex_ai_provider=chatgpt',
    runtimeContentHash: 'a'.repeat(64),
    bootstrapTimeoutMs: ['1'],
  }), TypeError, 'array bootstrap timeout must not coerce to a sandbox bootstrap timeout');

  assert.throws(() => createChatGPTSandboxHost({
    cspNonce: 'ab'.repeat(8),
    virtualSrc: 'https://ida.rhgrive.workers.dev/embed/chatgpt?__hex_ai_provider=chatgpt',
    runtimeContentHash: 'a'.repeat(64),
    readyTimeoutMs: true,
  }), TypeError, 'boolean ready timeout must not coerce to a sandbox ready timeout');
}

function fakeBridge() {
  const runs = [];
  const adapter = { conversation: () => null };
  const router = { async route() { return { conversation: null, isNew: true }; }, binding: () => null, bind: (_key, value) => value };
  const models = { async select() { return {}; } };
  const turns = { async run(_prompt, options) { runs.push(options); return { text: 'done', turnId: null, conversation: null }; } };
  return { adapter, router, models, turns, runs };
}

async function testBridgeTurnTimeoutRejectsStructured() {
  const parts = fakeBridge();
  delete globalThis[BRIDGE_KEY];
  const bridge = installChatGPTWebBridge({
    adapter: parts.adapter, router: parts.router, models: parts.models, turns: parts.turns,
    lateBindingWaitMs: ['1'],
  });
  await bridge.request('hello', { timeoutMs: ['1000'] });
  assert.equal(parts.runs.length, 1);
  assert.equal(parts.runs[0].timeoutMs, undefined, 'structured turn timeout must not be promoted to a 1000ms budget');

  const second = fakeBridge();
  delete globalThis[BRIDGE_KEY];
  const bridge2 = installChatGPTWebBridge({
    adapter: second.adapter, router: second.router, models: second.models, turns: second.turns,
  });
  await bridge2.request('hello', { timeoutMs: 1000 });
  assert.equal(second.runs[0].timeoutMs, 1000, 'primitive turn timeout must keep existing semantics');

  delete globalThis[BRIDGE_KEY];
}
