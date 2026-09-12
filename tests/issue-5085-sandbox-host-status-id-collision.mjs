import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createChatGPTSandboxHost } from '../js/userscript/chatgpt-sandbox-host.js';

const HOST_ID = 'hex-userscript-iframe-host';
const IFRAME_ID = 'hex-userscript-iframe';
const STATUS_ID = 'hex-userscript-iframe-status';
const WORKER = 'https://ida.rhgrive.workers.dev';
const RUNTIME = 'globalThis.__HEX_5085_RUNTIME__=true;';
const runtimeContentHash = createHash('sha256').update(RUNTIME).digest('hex');

class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.id = '';
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.style = {};
    this.attributes = new Map();
    this.hidden = false;
    this.textContent = '';
    this.onclick = null;
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  contains(node) {
    for (let current = node; current; current = current.parentNode) if (current === this) return true;
    return false;
  }
  append(...nodes) {
    for (const node of nodes) {
      node.detach();
      node.parentNode = this;
      this.children.push(node);
    }
  }
  insertBefore(newNode, referenceNode) {
    if (referenceNode !== null && referenceNode.parentNode !== this) {
      throw new DOMException('The node to be inserted references a node that is not a child of this node.', 'NotFoundError');
    }
    newNode.detach();
    const index = referenceNode === null ? this.children.length : this.children.indexOf(referenceNode);
    newNode.parentNode = this;
    this.children.splice(index, 0, newNode);
  }
  remove() { this.detach(); }
  detach() {
    if (!this.parentNode) return;
    const index = this.parentNode.children.indexOf(this);
    if (index >= 0) this.parentNode.children.splice(index, 1);
    this.parentNode = null;
  }
}

class FakeDocument {
  constructor() {
    this.documentElement = new FakeElement('html');
    this.activeElement = null;
    this.throwOnCreate = '';
  }
  createElement(tagName) {
    if (String(tagName).toUpperCase() === this.throwOnCreate) throw new Error('synthetic iframe element failure');
    return new FakeElement(tagName);
  }
  getElementById(id) { return findById(this.documentElement, id); }
}

function findById(node, id) {
  for (const child of node.children) {
    if (child.id === id) return child;
    const nested = findById(child, id);
    if (nested) return nested;
  }
  return null;
}

function createScenario({ foreignStatus = false, throwOnCreate = '' } = {}) {
  const documentRef = new FakeDocument();
  documentRef.throwOnCreate = String(throwOnCreate).toUpperCase();
  let foreign = null;
  if (foreignStatus) {
    const body = documentRef.createElement('body');
    body.id = 'page-body';
    foreign = documentRef.createElement('div');
    foreign.id = STATUS_ID;
    foreign.textContent = 'page owned status';
    foreign.setAttribute('role', 'note');
    body.append(foreign);
    documentRef.documentElement.append(body);
  }
  const failures = [];
  const host = createChatGPTSandboxHost({
    documentRef,
    windowRef: new EventTarget(),
    MessageChannelCtor: globalThis.MessageChannel,
    hostHtml: '<main id="app"></main>',
    cspNonce: 'nonce-5085-regression',
    virtualSrc: `${WORKER}/embed/chatgpt`,
    loaderVersion: '2.0.test',
    buildId: '0123456789abcdef01234567',
    runtimeContentHash,
    runtimeSourceProvider: () => new TextEncoder().encode(RUNTIME).buffer,
    bootstrapTimeoutMs: 40,
    onFailure: (failure) => failures.push(failure),
  });
  return { host, failures, foreign, documentRef };
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

const rejections = [];
const onUnhandledRejection = (reason) => rejections.push(String(reason?.message || reason));
process.on('unhandledRejection', onUnhandledRejection);

try {
  {
    const { host, failures, foreign, documentRef } = createScenario({ foreignStatus: true });
    await waitFor(
      () => host.state().status === 'failed' || rejections.length > 0,
      'sandbox host startup must reach the failure boundary after a status ID collision',
    );
    assert.deepEqual(rejections, [], 'a status ID collision must not leak an unhandled rejection from startup');
    assert.equal(foreign.parentNode?.tagName, 'BODY', 'a page-owned status node must never be adopted into the Hex wrapper');
    assert.equal(foreign.textContent, 'page owned status', 'a page-owned status node must never be mutated by Hex');
    const wrapper = documentRef.getElementById(HOST_ID);
    assert.ok(wrapper, 'the Hex wrapper must be attached to the document');
    const statuses = wrapper.children.filter((node) => node.id === STATUS_ID);
    assert.equal(statuses.length, 1, 'the Hex wrapper must own exactly one status node');
    const [status] = statuses;
    assert.ok(status !== foreign, 'the owned status node must be distinct from the colliding page node');
    const frames = wrapper.children.filter((node) => node.id === IFRAME_ID);
    assert.equal(frames.length, 1, 'the sandbox iframe must be attached inside the Hex wrapper');
    assert.equal(wrapper.children.indexOf(frames[0]), 0, 'the iframe must stay inserted before the owned status node');
    assert.equal(documentRef.getElementById(IFRAME_ID), frames[0], 'the iframe must be reachable by its id from the live tree');
    assert.equal(host.state().status, 'failed', 'setup must normalize into the failure state');
    assert.equal(host.state().failure.stage, 'sandbox-bootstrap', 'the bootstrap timeout must remain the reported stage');
    assert.equal(failures.length, 1, 'onFailure must receive exactly one normalized startup failure');
    assert.match(status.textContent, /Tap here to retry/);
    await host.reload();
    await waitFor(() => failures.length === 2, 'retry must reach the failure boundary again');
    assert.deepEqual(rejections, [], 'retry must not leak an unhandled rejection either');
    assert.equal(wrapper.children.filter((node) => node.id === STATUS_ID).length, 1, 'retry must reuse the owned status node');
    assert.equal(wrapper.children.filter((node) => node.id === IFRAME_ID).length, 1, 'retry must attach exactly one iframe');
  }

  {
    const { host, failures } = createScenario({ throwOnCreate: 'IFRAME' });
    await waitFor(
      () => host.state().status === 'failed' || rejections.length > 0,
      'iframe setup failure must reach the failure boundary',
    );
    assert.deepEqual(rejections, [], 'iframe setup failure must not leak an unhandled rejection');
    assert.equal(failures.length, 1, 'onFailure must receive the normalized setup failure');
    assert.equal(host.state().status, 'failed');
    assert.equal(host.state().failure.stage, 'sandbox-startup');
    assert.match(host.state().failure.message, /synthetic iframe element failure/);
    assert.equal(host.iframe, null, 'a failed setup must not leave a partially created iframe behind');
  }

  {
    const { host, documentRef } = createScenario();
    await waitFor(
      () => host.state().status === 'failed' || rejections.length > 0,
      'clean startup must reach the failure boundary',
    );
    assert.deepEqual(rejections, [], 'the collision-free startup path must stay free of unhandled rejections');
    const wrapper = documentRef.getElementById(HOST_ID);
    const statuses = wrapper.children.filter((node) => node.id === STATUS_ID);
    const frames = wrapper.children.filter((node) => node.id === IFRAME_ID);
    assert.equal(statuses.length, 1);
    assert.equal(frames.length, 1);
    assert.equal(wrapper.children.indexOf(frames[0]), 0, 'the iframe must be inserted before the status node');
    assert.equal(documentRef.getElementById(STATUS_ID), statuses[0], 'the owned status node must win the document id lookup');
    assert.equal(host.state().failure.stage, 'sandbox-bootstrap');
  }
} finally {
  process.off('unhandledRejection', onUnhandledRejection);
}

console.log('issue 5085 sandbox host status ownership: ok');
