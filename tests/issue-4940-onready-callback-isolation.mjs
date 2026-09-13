import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { MessageChannel } from 'node:worker_threads';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

import { EMBED_PROTOCOL, EMBED_PROTOCOL_VERSION } from '../js/userscript/embed-protocol.js';
import { EMBED_BOOTSTRAP_TYPE } from '../js/userscript/embed-bootstrap.js';
import { createChatGPTSandboxHost } from '../js/userscript/chatgpt-sandbox-host.js';

const SANDBOX_READY = 'hex.embed.sandbox-ready';
const SANDBOX_RUNTIME = 'hex.embed.runtime';
const SANDBOX_FAILURE = 'hex.embed.sandbox-failure';
const ATTACH = 'hex.embed.attach';
const runtimeSource = 'globalThis.__HEX_TEST_RUNTIME__=true;';
const runtimeContentHash = createHash('sha256').update(runtimeSource).digest('hex');

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

function findById(root, id) {
  if (root.id === id) return root;
  for (const child of root.children) {
    const found = findById(child, id);
    if (found) return found;
  }
  return null;
}

function fakeEnvironment(options = {}) {
  const root = new FakeElement('html');
  const windowListeners = new Map();
  const windowRef = {
    addEventListener(type, fn) { if (!windowListeners.has(type)) windowListeners.set(type, new Set()); windowListeners.get(type).add(fn); },
    removeEventListener(type, fn) { windowListeners.get(type)?.delete(fn); },
    dispatchMessage(event) { for (const fn of [...(windowListeners.get('message') || [])]) fn(event); },
  };
  const calls = [];
  const ports = [];
  const documentRef = {
    documentElement: root,
    activeElement: null,
    createElement(tag) {
      const element = new FakeElement(tag);
      if (String(tag).toLowerCase() === 'iframe') {
        element.contentWindow = {
          focus() {},
          postMessage(data, targetOrigin, transfer) {
            const call = { data, targetOrigin, transfer: Array.isArray(transfer) ? transfer : [] };
            calls.push(call);
            if (data?.type === ATTACH) options.onAttach?.(call);
          },
        };
      }
      return element;
    },
    getElementById(id) { return findById(root, id); },
    contains(node) { return root.contains(node); },
  };
  class TrackedMessageChannel {
    constructor() {
      const channel = new MessageChannel();
      const recorder = { closeCalls: 0, postCalls: 0 };
      ports.push(recorder);
      this.port1 = {
        recorder,
        postMessage(value) { recorder.postCalls += 1; channel.port1.postMessage(value); },
        close() { recorder.closeCalls += 1; channel.port1.close(); },
        start() { channel.port1.start(); },
        addEventListener(type, fn) { channel.port1.addEventListener(type, fn); },
        removeEventListener(type, fn) { channel.port1.removeEventListener(type, fn); },
      };
      this.port2 = channel.port2;
    }
  }
  return { documentRef, windowRef, calls, ports, TrackedMessageChannel };
}

function makeHost(env, overrides = {}) {
  return createChatGPTSandboxHost({
    hostHtml: '<main id="app"></main>',
    cspNonce: 'chatgpt-nonce-1',
    virtualSrc: 'https://worker.example/embed/chatgpt?__hex_ai_provider=chatgpt',
    loaderVersion: '2.0.test',
    buildId: '0123456789abcdef01234567',
    runtimeContentHash,
    runtimeSourceProvider: () => new TextEncoder().encode(runtimeSource).buffer,
    documentRef: env.documentRef,
    windowRef: env.windowRef,
    MessageChannelCtor: env.TrackedMessageChannel,
    bootstrapTimeoutMs: 5000,
    readyTimeoutMs: 5000,
    ...overrides,
  });
}

async function bootToAttach(env, host) {
  const frame = host.iframe;
  const generation = frame.dataset.hexGeneration;
  const sandboxToken = frame.dataset.hexSandboxToken;
  const dispatch = (data) => env.windowRef.dispatchMessage({
    source: frame.contentWindow,
    origin: 'null',
    data: { protocol: EMBED_PROTOCOL, version: EMBED_PROTOCOL_VERSION, generation, sandboxToken, ...data },
  });
  dispatch({ type: SANDBOX_READY });
  await waitFor(() => env.calls.some((call) => call.data.type === SANDBOX_RUNTIME), 'runtime transfer');
  dispatch({ type: EMBED_BOOTSTRAP_TYPE });
  await waitFor(() => env.calls.some((call) => call.data.type === ATTACH), 'attach');
  return { generation, sandboxToken };
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function waitFor(predicate, label, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (predicate()) return; await delay(2); }
  assert.fail(`timed out waiting for: ${label}`);
}

function childReadyResponder(env) {
  const call = env.calls.find((entry) => entry.data.type === ATTACH);
  assert.ok(call);
  const childPort = call.transfer[0];
  childPort.postMessage({
    protocol: EMBED_PROTOCOL,
    version: EMBED_PROTOCOL_VERSION,
    kind: 'control',
    id: 'ready-1',
    method: 'ready',
    nonce: call.data.nonce,
  });
  return { nonce: call.data.nonce, childPort };
}

await testReadyObserverSuccessKeepsLifecycle();
await testReadyObserverThrowKeepsLifecycle();
await testBootstrapFailureStillFails();
await testMonitorTimeoutStillFails();
await testSiblingCallbackExceptionBoundaryParity();

console.log('issue 4940 sandbox host onReady exception isolation: ok');

async function testReadyObserverSuccessKeepsLifecycle() {
  const readyCalls = [];
  const failures = [];
  const env = fakeEnvironment();
  const host = makeHost(env, {
    onReady: (info) => readyCalls.push(info),
    onFailure: (value) => failures.push(value),
  });
  const { generation, sandboxToken } = await bootToAttach(env, host);
  const { nonce } = childReadyResponder(env);
  await waitFor(() => host.state().status === 'visible', 'visible after ready');
  assert.equal(readyCalls.length, 1);
  assert.equal(Object.isFrozen(readyCalls[0]), true);
  assert.equal(readyCalls[0].generation, Number(generation));
  assert.equal(readyCalls[0].nonce, nonce);
  assert.equal(readyCalls[0].sandboxToken, sandboxToken);
  assert.equal(failures.length, 0);
  assert.equal(env.ports[0].closeCalls, 0);
  host.hide();
  assert.equal(host.state().status, 'hidden');
  host.show();
  assert.equal(host.state().status, 'visible');
  host.destroy();
  childReadyResponderClose(env);
}

async function testReadyObserverThrowKeepsLifecycle() {
  const cleanups = [];
  const failures = [];
  const env = fakeEnvironment();
  const host = makeHost(env, {
    onPort: () => () => cleanups.push('port-cleanup'),
    onReady() { throw new Error('observer failed'); },
    onFailure: (value) => failures.push(value),
  });
  await bootToAttach(env, host);
  const { childPort } = childReadyResponder(env);
  await waitFor(() => env.calls.some((call) => call.data.type === ATTACH), 'attach');
  await delay(20);
  assert.notEqual(host.state().status, 'failed', 'onReady exception must not fail the host lifecycle');
  assert.equal(host.state().status, 'visible');
  assert.equal(host.state().failure, null);
  assert.equal(failures.length, 0, 'onFailure must not fire for an observer exception');
  assert.equal(cleanups.length, 0, 'port cleanup must not run for an observer exception');
  assert.equal(env.ports[0].closeCalls, 0, 'the established RPC port must stay open');
  host.hide();
  assert.equal(host.state().status, 'hidden', 'hidden ready state must survive an observer exception');
  host.destroy();
  childPort.close();
}

async function testBootstrapFailureStillFails() {
  const cleanups = [];
  const readyCalls = [];
  const failures = [];
  const env = fakeEnvironment();
  const host = makeHost(env, {
    onPort: () => () => cleanups.push('port-cleanup'),
    onReady: (info) => readyCalls.push(info),
    onFailure: (value) => failures.push(value),
  });
  const frame = host.iframe;
  const generation = frame.dataset.hexGeneration;
  const sandboxToken = frame.dataset.hexSandboxToken;
  env.windowRef.dispatchMessage({
    source: frame.contentWindow,
    origin: 'null',
    data: { type: SANDBOX_READY, protocol: EMBED_PROTOCOL, version: EMBED_PROTOCOL_VERSION, generation, sandboxToken },
  });
  await waitFor(() => env.calls.some((call) => call.data.type === SANDBOX_RUNTIME), 'runtime transfer');
  env.windowRef.dispatchMessage({
    source: frame.contentWindow,
    origin: 'null',
    data: { type: SANDBOX_FAILURE, protocol: EMBED_PROTOCOL, version: EMBED_PROTOCOL_VERSION, generation, sandboxToken, message: 'child died' },
  });
  await waitFor(() => host.state().status === 'failed', 'failed after sandbox failure');
  assert.equal(host.state().failure.stage, 'sandbox-runtime');
  assert.match(host.state().failure.message, /child died/);
  assert.equal(failures.length, 1);
  assert.equal(readyCalls.length, 0);
  assert.equal(cleanups.length, 0);
  host.destroy();
}

async function testMonitorTimeoutStillFails() {
  const failures = [];
  const env = fakeEnvironment();
  const host = makeHost(env, {
    bootstrapTimeoutMs: 15,
    onFailure: (value) => failures.push(value),
  });
  await waitFor(() => host.state().status === 'failed', 'failed after bootstrap timeout');
  assert.equal(host.state().failure.stage, 'sandbox-bootstrap');
  assert.equal(failures.length, 1);
  host.destroy();
}

async function testSiblingCallbackExceptionBoundaryParity() {
  const sandboxSource = await readFile(new URL('../js/userscript/chatgpt-sandbox-host.js', import.meta.url), 'utf8');
  const iframeSource = await readFile(new URL('../js/userscript/chatgpt-iframe-host.js', import.meta.url), 'utf8');
  assert.match(iframeSource, /try\s*\{\s*onReady\?\.\(.*\);\s*\}\s*catch \{\}/,
    'the iframe host must keep isolating its ready observer callback');
  assert.match(sandboxSource, /try\s*\{\s*onReady\(.*\);\s*\}\s*catch \{\}/,
    'the sandbox host must isolate its ready observer callback like the iframe host');
}

function childReadyResponderClose(env) {
  const call = env.calls.find((entry) => entry.data.type === ATTACH);
  call?.transfer[0]?.close();
}
