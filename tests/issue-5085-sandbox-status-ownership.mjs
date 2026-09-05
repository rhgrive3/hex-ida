import assert from 'node:assert/strict';
import { createChatGPTSandboxHost } from '../js/userscript/chatgpt-sandbox-host.js';

// Issue #5085: ensureStatus() reused any document-global
// #hex-userscript-iframe-status node without checking ownership, so a foreign
// node planted by the page broke `wrapper.insertBefore(iframe, status)` with
// NotFoundError. That setup ran outside the startup try/catch behind
// `void startGeneration()`, so the failure also escaped as an unhandled
// rejection instead of reaching onFailure().

const STATUS_ID = 'hex-userscript-iframe-status';
const HOST_ID = 'hex-userscript-iframe-host';

class FakeNode {
  constructor(tag, doc) {
    this.tagName = String(tag).toUpperCase();
    this.doc = doc || null;
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.dataset = {};
    this.hidden = false;
    this.textContent = '';
    this.onclick = null;
    this._id = '';
    this._attrs = new Map();
    this._listeners = new Map();
  }
  get id() { return this._id; }
  set id(value) {
    const next = String(value || '');
    if (this.doc) this.doc.unregister(this);
    this._id = next;
    if (this.doc && next) this.doc.register(this);
  }
  setAttribute(key, value) { this._attrs.set(String(key), String(value)); }
  getAttribute(key) { return this._attrs.get(String(key)) ?? null; }
  removeAttribute(key) { this._attrs.delete(String(key)); }
  addEventListener(type, listener) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) { this._listeners.get(type)?.delete(listener); }
  append(...nodes) {
    for (const node of nodes) this.appendChild(node);
    return this;
  }
  appendChild(node) {
    if (node?.parentNode) node.parentNode.removeChild(node);
    this.children.push(node);
    node.parentNode = this;
    return node;
  }
  insertBefore(node, ref) {
    if (ref != null && ref.parentNode !== this) {
      const error = new Error("Failed to execute 'insertBefore': reference node is not a child of this node.");
      error.name = 'NotFoundError';
      throw error;
    }
    if (node?.parentNode) node.parentNode.removeChild(node);
    if (ref == null) this.children.push(node);
    else this.children.splice(this.children.indexOf(ref), 0, node);
    node.parentNode = this;
    return node;
  }
  removeChild(node) {
    const index = this.children.indexOf(node);
    if (index === -1) throw new Error('NotFoundError');
    this.children.splice(index, 1);
    node.parentNode = null;
    return node;
  }
  remove() {
    this.parentNode?.removeChild(this);
    this.doc?.unregister(this);
  }
  contains(node) {
    let current = node;
    while (current) {
      if (current === this) return true;
      current = current.parentNode;
    }
    return false;
  }
  focus() {}
}

class FakeDocument {
  constructor() {
    this._byId = new Map();
    this.documentElement = new FakeNode('html', this);
    this.activeElement = null;
  }
  register(node) { if (node.id) this._byId.set(node.id, node); }
  unregister(node) { if (node.id && this._byId.get(node.id) === node) this._byId.delete(node.id); }
  createElement(tag) { return new FakeNode(tag, this); }
  getElementById(id) { return this._byId.get(String(id)) || null; }
  contains(node) { return this.documentElement.contains(node); }
}

const fakeWindow = () => ({ addEventListener() {}, removeEventListener() {} });
class FakeMessageChannel {
  constructor() {
    this.port1 = { close() {} };
    this.port2 = { close() {} };
  }
}

const hostOptions = (documentRef, extra = {}) => ({
  documentRef,
  windowRef: fakeWindow(),
  MessageChannelCtor: FakeMessageChannel,
  hostHtml: '',
  cspNonce: 'test-nonce-1',
  virtualSrc: 'https://example.com/hex-embed',
  loaderVersion: 'test',
  buildId: 'test',
  runtimeContentHash: 'ab'.repeat(32),
  runtimeSourceProvider: () => new ArrayBuffer(8),
  bootstrapTimeoutMs: 0,
  readyTimeoutMs: 0,
  ...extra,
});

const unhandled = [];
const onUnhandled = (reason) => { unhandled.push(reason); };
process.on('unhandledRejection', onUnhandled);
try {
  // A foreign status node planted by the page must not be adopted as ours.
  {
    const doc = new FakeDocument();
    const foreignParent = doc.createElement('div');
    doc.documentElement.append(foreignParent);
    const foreign = doc.createElement('div');
    foreign.id = STATUS_ID;
    foreignParent.append(foreign);

    let failures = 0;
    const host = createChatGPTSandboxHost(hostOptions(doc, { onFailure: () => { failures++; } }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(foreign.parentNode, foreignParent, 'the foreign node must stay untouched under its own parent');
    const wrapper = doc.getElementById(HOST_ID);
    const owned = wrapper.children.find((node) => node.tagName === 'DIV' && node !== host.iframe);
    assert.ok(owned && owned !== foreign, 'the host must create its own status node inside its wrapper');
    assert.equal(owned.parentNode, wrapper);
    assert.equal(failures, 0, 'startup must proceed, not fail, despite the foreign id collision');
    assert.equal(host.state().status, 'sandbox-loading');
    host.destroy();
  }

  // A setup failure at insertBefore must route to onFailure, not escape.
  {
    const doc = new FakeDocument();
    const wrapper = doc.createElement('div');
    wrapper.id = HOST_ID;
    doc.documentElement.append(wrapper);
    wrapper.insertBefore = () => {
      const error = new Error('simulated foreign-status insertBefore failure');
      error.name = 'NotFoundError';
      throw error;
    };
    let failure = null;
    const host = createChatGPTSandboxHost(hostOptions(doc, { onFailure: (info) => { failure = info; } }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(failure, 'setup failure must reach onFailure');
    assert.equal(host.state().status, 'failed');
    host.destroy();
  }

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(unhandled.length, 0, `startup must not produce unhandled rejections, got ${unhandled.length}`);
} finally {
  process.off('unhandledRejection', onUnhandled);
}

console.log('issue #5085 sandbox status ownership: PASS');
