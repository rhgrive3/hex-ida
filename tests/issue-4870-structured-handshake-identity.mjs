import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import vm from 'node:vm';
import { MessageChannel } from 'node:worker_threads';

import {
  EMBED_PROTOCOL,
  EMBED_PROTOCOL_VERSION,
  createEmbedNonce,
} from '../js/userscript/embed-protocol.js';
import {
  EMBED_BOOTSTRAP_TYPE,
  normalizeEmbedGeneration,
  normalizeSandboxToken,
  waitForEmbedChildBootstrap,
} from '../js/userscript/embed-bootstrap.js';
import { buildSandboxSrcdoc, createChatGPTSandboxHost } from '../js/userscript/chatgpt-sandbox-host.js';
import { EMBED_PATH, waitForEmbedParentAttach } from '../js/userscript/embed-child.js';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const worker = 'https://ida.rhgrive.workers.dev';
const token = 'ab'.repeat(32);
const otherToken = 'cd'.repeat(32);
const runtimeSource = 'globalThis.__HEX_TEST_RUNTIME__=true;';
const runtimeContentHash = createHash('sha256').update(runtimeSource).digest('hex');
const SANDBOX_READY = 'hex.embed.sandbox-ready';
const SANDBOX_RUNTIME = 'hex.embed.runtime';
const ATTACH = 'hex.embed.attach';

class FakeElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.id = '';
    this.title = '';
    this.referrerPolicy = '';
    this.style = {};
    this.dataset = {};
    this.hidden = false;
    this.textContent = '';
    this.attributes = new Map();
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  append(...nodes) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } }
  insertBefore(node, ref) {
    const existing = this.children.indexOf(node);
    if (existing >= 0) this.children.splice(existing, 1);
    const at = ref ? this.children.indexOf(ref) : -1;
    if (at < 0) this.children.push(node); else this.children.splice(at, 0, node);
    node.parentElement = this;
  }
  remove() {
    if (!this.parentElement) return;
    const index = this.parentElement.children.indexOf(this);
    if (index >= 0) this.parentElement.children.splice(index, 1);
    this.parentElement = null;
  }
  contains(node) { return this === node || this.children.some((child) => child.contains?.(node)); }
  focus() {}
}

await canonicalizerRejectsStructuredIdentity();
await bootstrapReadyRejectsStructuredIdentity();
await sandboxMonitorRejectsStructuredIdentity();
await sandboxRuntimeRejectsStructuredIdentity();
await parentAttachRejectsStructuredIdentity();

console.log('issue 4870 structured handshake identity: ok');

async function canonicalizerRejectsStructuredIdentity() {
  for (const value of [[1], ['1'], [{ toString: () => '1' }], { toString: () => '1' }, true]) {
    assert.throws(() => normalizeEmbedGeneration(value), TypeError,
      `structured generation ${JSON.stringify(String(value))} must not be promoted to a canonical identity`);
  }
  for (const value of [[token], [token.toUpperCase()], { toString: () => token }, true]) {
    assert.throws(() => normalizeSandboxToken(value), TypeError,
      'structured sandboxToken must not be promoted to a canonical identity');
  }
  assert.throws(() => normalizeEmbedGeneration(1.5), TypeError);
  assert.throws(() => normalizeEmbedGeneration(0), TypeError);
  assert.throws(() => normalizeSandboxToken('ab'.repeat(31)), TypeError);
  assert.equal(normalizeEmbedGeneration(7), '7');
  assert.equal(normalizeEmbedGeneration('7'), '7');
  assert.equal(normalizeSandboxToken(token), token);
  assert.equal(normalizeSandboxToken(token.toUpperCase()), token);
}

async function bootstrapReadyRejectsStructuredIdentity() {
  const parent = eventTarget();
  const child = {};
  let settled = false;
  const pending = waitForEmbedChildBootstrap({
    windowRef: parent, expectedSource: child, opaque: true, sandboxToken: token, generation: 1, timeoutMs: 60,
  }).then((value) => { settled = true; return value; });

  parent.dispatch(bootstrapEvent(child, 'null', { generation: [1], sandboxToken: [token] }));
  parent.dispatch(bootstrapEvent(child, 'null', { generation: ['1'], sandboxToken: token }));
  parent.dispatch(bootstrapEvent(child, 'null', { generation: { toString: () => '1' }, sandboxToken: token }));
  parent.dispatch(bootstrapEvent(child, 'null', { generation: '1', sandboxToken: [token] }));
  parent.dispatch(bootstrapEvent(child, 'null', { generation: '2', sandboxToken: token }));
  parent.dispatch(bootstrapEvent(child, 'null', { generation: '1', sandboxToken: otherToken }));
  parent.dispatch(bootstrapEvent({}, 'null', { generation: '1', sandboxToken: token }));
  parent.dispatch(bootstrapEvent(child, 'https://evil.invalid', { generation: '1', sandboxToken: token }));
  await delay(20);
  assert.equal(settled, false, 'structured, stale, wrong-token, wrong-source and wrong-origin messages must stay unsettled');
  await assert.rejects(pending, (error) => error?.code === 'EMBED_BOOTSTRAP_TIMEOUT');

  const okParent = eventTarget();
  const ok = waitForEmbedChildBootstrap({
    windowRef: okParent, expectedSource: child, opaque: true, sandboxToken: token, generation: 1, timeoutMs: 100,
  });
  okParent.dispatch(bootstrapEvent(child, 'null', { generation: '1', sandboxToken: token }));
  const result = await ok;
  assert.equal(result.generation, '1');
  assert.equal(result.sandboxToken, token);
  assert.equal(result.origin, 'null');
}

async function sandboxMonitorRejectsStructuredIdentity() {
  const env = fakeEnvironment();
  const host = makeHost(env, { bootstrapTimeoutMs: 5000, readyTimeoutMs: 5000 });
  const frame = host.iframe;
  const generation = frame.dataset.hexGeneration;
  const sandboxToken = frame.dataset.hexSandboxToken;
  const dispatch = (data) => env.windowRef.dispatchMessage({
    source: frame.contentWindow, origin: 'null', data,
  });

  dispatch(monitorMessage({ type: SANDBOX_READY, generation: [Number(generation)], sandboxToken: [sandboxToken] }, generation, sandboxToken));
  dispatch(monitorMessage({ type: SANDBOX_READY, generation: { toString: () => generation }, sandboxToken }, generation, sandboxToken));
  dispatch(monitorMessage({ type: SANDBOX_READY, generation: '999999', sandboxToken }, generation, sandboxToken));
  dispatch(monitorMessage({ type: SANDBOX_READY, generation, sandboxToken: otherToken }, generation, sandboxToken));
  await delay(20);
  assert.equal(env.calls.length, 0, 'structured sandbox-ready identity must not authorize the runtime transfer');
  assert.equal(host.state().status, 'sandbox-loading');

  dispatch({ type: SANDBOX_READY, protocol: EMBED_PROTOCOL, version: EMBED_PROTOCOL_VERSION, generation, sandboxToken });
  await waitFor(() => env.calls.some((call) => call.data.type === SANDBOX_RUNTIME));
  const transfer = env.calls.find((call) => call.data.type === SANDBOX_RUNTIME).data;
  assert.equal(typeof transfer.generation, 'string');
  assert.equal(transfer.generation, generation);
  assert.equal(transfer.sandboxToken, sandboxToken);
  host.destroy();
}

async function sandboxRuntimeRejectsStructuredIdentity() {
  const html = buildSandboxSrcdoc(sandboxConfig(7, token));
  const bootstrap = html.match(/<script nonce="[^"]+">([\s\S]*)<\/script><\/body>/)?.[1];
  assert.ok(bootstrap, 'sandbox bootstrap source must be extractable');
  const listeners = new Map();
  const appended = [];
  const parent = { postMessage() {} };
  const context = {
    parent, URL, ArrayBuffer, Uint8Array, TextDecoder, crypto: webcrypto, globalThis: null,
    document: {
      createElement() { return { type: '', nonce: '', textContent: '', addEventListener() {}, remove() {} }; },
      head: { append(node) { appended.push(node); } },
    },
    addEventListener(type, handler) { listeners.set(type, handler); },
  };
  context.globalThis = context;
  vm.runInNewContext(bootstrap, context);
  const onMessage = listeners.get('message');
  const trusted = new TextEncoder().encode(runtimeSource).buffer;

  await onMessage({
    source: parent,
    origin: 'https://chatgpt.com',
    data: {
      type: SANDBOX_RUNTIME, protocol: EMBED_PROTOCOL, version: EMBED_PROTOCOL_VERSION,
      generation: [7], sandboxToken: [token], runtime: trusted,
    },
  });
  assert.equal(appended.length, 0, 'structured generation/sandboxToken must not authorize protected runtime execution');

  await onMessage({
    source: parent,
    origin: 'https://chatgpt.com',
    data: {
      type: SANDBOX_RUNTIME, protocol: EMBED_PROTOCOL, version: EMBED_PROTOCOL_VERSION,
      generation: '7', sandboxToken: token, runtime: new TextEncoder().encode(runtimeSource).buffer,
    },
  });
  assert.equal(appended.length, 1, 'a canonical primitive identity must still transfer the protected runtime');
  assert.equal(appended[0].textContent, runtimeSource);
}

async function parentAttachRejectsStructuredIdentity() {
  const location = {
    origin: worker, pathname: EMBED_PATH, search: '?__hex_embed_generation=4',
    href: `${worker}${EMBED_PATH}?__hex_embed_generation=4`,
  };
  const rejectingParent = { postMessage() {} };
  const window = fakeWindow({ parent: rejectingParent });
  const rejected = waitForEmbedParentAttach({
    window, location, expectedParent: rejectingParent, timeoutMs: 25,
    globalObject: { __HEX_EMBED_SANDBOX_TOKEN__: token },
  });
  const structuredChannel = new MessageChannel();
  window.dispatchMessage(attachEvent({
    source: rejectingParent, nonce: createEmbedNonce(), port: structuredChannel.port1,
    data: { generation: [4], sandboxToken: [token] },
  }));
  await assert.rejects(rejected, /attach timeout/);
  structuredChannel.port1.close(); structuredChannel.port2.close();

  const acceptingParent = { postMessage() {} };
  const okWindow = fakeWindow({ parent: acceptingParent });
  const okChannel = new MessageChannel();
  const nonce = createEmbedNonce();
  const accepted = waitForEmbedParentAttach({
    window: okWindow, location, expectedParent: acceptingParent, timeoutMs: 100,
    globalObject: { __HEX_EMBED_SANDBOX_TOKEN__: token },
  });
  okWindow.dispatchMessage(attachEvent({
    source: acceptingParent, nonce, port: okChannel.port1, data: { generation: '4', sandboxToken: token },
  }));
  const result = await accepted;
  assert.equal(result.generation, '4');
  assert.equal(result.sandboxToken, token);
  assert.equal(result.nonce, nonce);
  okChannel.port1.close(); okChannel.port2.close();
}

function bootstrapEvent(source, origin, identity) {
  return {
    source,
    origin,
    data: { type: EMBED_BOOTSTRAP_TYPE, protocol: EMBED_PROTOCOL, version: EMBED_PROTOCOL_VERSION, ...identity },
  };
}
function monitorMessage(patch, generation, sandboxToken) {
  return { ...patch, protocol: EMBED_PROTOCOL, version: EMBED_PROTOCOL_VERSION, generation: patch.generation ?? generation, sandboxToken: patch.sandboxToken ?? sandboxToken };
}
function attachEvent({ source, nonce, port, data }) {
  return {
    origin: 'https://chatgpt.com', source, ports: [port],
    data: { type: ATTACH, protocol: EMBED_PROTOCOL, version: EMBED_PROTOCOL_VERSION, nonce, ...data },
  };
}
function sandboxConfig(generation, sandboxToken) {
  return {
    hostHtml: '<main id="app"><button id="btn-open">Open</button></main>',
    cspNonce: 'chatgpt-nonce-1',
    generation,
    sandboxToken,
    apiOrigin: worker,
    virtualSrc: `${worker}${EMBED_PATH}?__hex_ai_provider=chatgpt&__hex_embed_generation=${generation}`,
    loaderVersion: '2.0.test',
    buildId: '0123456789abcdef01234567',
    runtimeContentHash,
  };
}
function eventTarget() {
  const listeners = new Set();
  return {
    addEventListener(type, fn) { if (type === 'message') listeners.add(fn); },
    removeEventListener(type, fn) { if (type === 'message') listeners.delete(fn); },
    dispatch(event) { for (const fn of [...listeners]) fn(event); },
  };
}
function fakeWindow({ parent = null } = {}) {
  const listeners = new Set();
  const value = {
    parent: null,
    addEventListener(type, fn) { if (type === 'message') listeners.add(fn); },
    removeEventListener(type, fn) { if (type === 'message') listeners.delete(fn); },
    dispatchMessage(event) { for (const fn of [...listeners]) fn(event); },
  };
  value.parent = parent || value;
  return value;
}
function findById(root, id) {
  if (root.id === id) return root;
  for (const child of root.children) {
    const found = findById(child, id);
    if (found) return found;
  }
  return null;
}
function fakeEnvironment() {
  const root = new FakeElement('html');
  const listeners = new Map();
  const windowRef = {
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    dispatchMessage(event) { for (const fn of [...(listeners.get('message') || [])]) fn(event); },
  };
  const calls = [];
  const documentRef = {
    documentElement: root,
    activeElement: null,
    createElement(tag) {
      const element = new FakeElement(tag);
      if (String(tag).toLowerCase() === 'iframe') {
        element.contentWindow = {
          focus() {},
          postMessage(data, targetOrigin, transfer) {
            calls.push({ data, targetOrigin, transfer: Array.isArray(transfer) ? transfer : [] });
          },
        };
      }
      return element;
    },
    getElementById(id) { return findById(root, id); },
    contains(node) { return root.contains(node); },
  };
  return { documentRef, windowRef, calls };
}
function makeHost(env, overrides = {}) {
  return createChatGPTSandboxHost({
    ...sandboxConfig(1, token),
    documentRef: env.documentRef,
    windowRef: env.windowRef,
    MessageChannelCtor: MessageChannel,
    runtimeSourceProvider: () => new TextEncoder().encode(runtimeSource).buffer,
    ...overrides,
  });
}
async function waitFor(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (predicate()) return; await delay(2); }
  throw new Error('condition did not become true');
}
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
