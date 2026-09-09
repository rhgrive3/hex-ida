import assert from 'node:assert/strict';
import { createActionRunner } from '../js/ai/interaction/actions.js';
import { closeAllSheets } from '../js/ui.js';

// Keep this regression on the public action-runner boundary. A private helper
// export would test implementation shape instead of the routing behavior that
// broke when sanitized string addresses met semantic BigInt addresses.
class FakeElement {
  constructor(tagName, nodeType = 1) {
    this.tagName = String(tagName).toUpperCase();
    this.nodeType = nodeType;
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.style = { setProperty() {} };
    this.dataset = {};
    this.listeners = new Map();
    this.isConnected = true;
    this.tabIndex = -1;
    this._text = '';
    this.className = '';
    this.classList = {
      add: (...names) => {
        const current = new Set(this.className.split(/\s+/).filter(Boolean));
        for (const name of names) current.add(name);
        this.className = [...current].join(' ');
      },
      remove: (...names) => {
        const current = new Set(this.className.split(/\s+/).filter(Boolean));
        for (const name of names) current.delete(name);
        this.className = [...current].join(' ');
      },
      toggle: (name, force) => {
        const present = this.classList.contains(name);
        const next = force == null ? !present : !!force;
        if (next) this.classList.add(name); else this.classList.remove(name);
        return next;
      },
      contains: (name) => this.className.split(/\s+/).includes(name),
    };
  }

  set textContent(value) {
    this._text = value == null ? '' : String(value);
    this.replaceChildren();
  }

  get textContent() {
    return this._text + this.childNodes.map((child) => child.textContent || '').join('');
  }

  append(...nodes) {
    for (const node of nodes) {
      if (node == null) continue;
      if (node.nodeType === 11) {
        this.append(...node.childNodes);
        continue;
      }
      this.childNodes.push(node);
      node.parentNode = this;
    }
  }

  replaceChildren(...nodes) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    this.append(...nodes);
  }

  remove() {
    if (this.parentNode) {
      this.parentNode.childNodes = this.parentNode.childNodes.filter((node) => node !== this);
      this.parentNode = null;
    }
    this.isConnected = false;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'id') this.id = String(value);
  }

  removeAttribute(name) { this.attributes.delete(name); }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    this.listeners.set(type, listeners.filter((entry) => entry !== listener));
  }

  dispatchEvent(event) {
    for (const listener of this.listeners.get(event.type) || []) listener(event);
  }

  focus() { globalThis.document.activeElement = this; }

  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }

  querySelectorAll(selector) {
    const matches = [];
    const visit = (node) => {
      for (const child of node.childNodes || []) {
        if (child.matchesSelector?.(selector)) matches.push(child);
        visit(child);
      }
    };
    visit(this);
    return matches;
  }

  matchesSelector(selector) {
    return selector.split(',').some((part) => {
      const token = part.trim();
      if (token.startsWith('.')) return this.classList.contains(token.slice(1));
      if (/^[a-z][a-z0-9-]*$/i.test(token)) return this.tagName === token.toUpperCase();
      return false;
    });
  }
}

const previousDocument = globalThis.document;
const previousAnimationFrames = globalThis.requestAnimationFrame;
const previousUiRoot = globalThis.__HEX_UI_ROOT__;
const overlays = new FakeElement('div');
const uiRoot = new FakeElement('html');
uiRoot.lang = 'en';
const fakeDocument = {
  activeElement: null,
  documentElement: uiRoot,
  body: new FakeElement('body'),
  getElementById: (id) => (id === 'overlays' ? overlays : null),
  createElement: (tag) => new FakeElement(tag),
  createTextNode: (text) => {
    const node = new FakeElement('#text', 3);
    node.textContent = text;
    return node;
  },
  createDocumentFragment: () => new FakeElement('#fragment', 11),
  addEventListener() {},
  removeEventListener() {},
};
globalThis.document = fakeDocument;
globalThis.requestAnimationFrame = (callback) => callback();
globalThis.__HEX_UI_ROOT__ = uiRoot;

const navigations = [];
const model = {
  instructions: [
    {
      address: 0x1000n,
      row: 7,
      mnemonic: 'mov',
      operands: 'x0, x1',
      reads: [],
      writes: ['x0'],
      ops: [],
    },
    {
      address: 0x1001n,
      row: 8,
      mnemonic: 'add',
      operands: 'x1, x2',
      reads: [],
      writes: ['x1'],
      ops: [],
    },
  ],
};
const app = {
  semantic: { model },
  // No viewer rowOfAddress helper: a semantic row must be enough to route.
  store: { get: (key) => (key === 'currentRegion' ? { vmAddr: 0x1000n } : null) },
};
const run = createActionRunner(app, {
  ui: { router: { navigate: (route) => navigations.push(route) } },
});

function valueFlowSheets() {
  return overlays.childNodes.filter((node) => node.classList?.contains('sheet'));
}

async function assertValueFlow(action, expectedAddress) {
  const before = valueFlowSheets().length;
  const actionLabel = `${action.address ?? action.target}`;
  await run(action);
  assert.equal(navigations.length, 0,
    `${actionLabel} must not use the overview fallback`);
  const sheets = valueFlowSheets();
  assert.equal(sheets.length, before + 1,
    `${actionLabel} must open one Value flow sheet`);
  const latest = sheets.at(-1);
  assert.equal(latest.querySelector('.sheet-title')?.textContent, '値の流れ');

  // Open the real expert-details control so the selected semantic instruction
  // is rendered. This distinguishes the 0x1000 and 0x1001 rows through the
  // public action path rather than inspecting the private comparator.
  const details = latest.querySelector('details');
  assert.ok(details, 'Value flow sheet must expose its details control');
  details.open = true;
  details.dispatchEvent({ type: 'toggle' });
  assert.match(latest.textContent, new RegExp(expectedAddress),
    `Value flow must describe semantic instruction ${expectedAddress}`);
}

try {
  // The action address and target aliases accept canonical hex, decimal, and
  // BigInt values while resolving the same semantic instruction row.
  await assertValueFlow({ kind: 'trace-value', target: '0x1000' }, '0x00001000');
  await assertValueFlow({ kind: 'trace-value', target: '4096' }, '0x00001000');
  await assertValueFlow({ kind: 'trace-value', target: 0x1000n }, '0x00001000');
  await assertValueFlow({ kind: 'trace-value', address: '0x1001' }, '0x00001001');

  // address is the established alias and takes precedence when both fields
  // are present; the distinct row must stay distinct from 0x1000.
  await assertValueFlow({ kind: 'trace-value', address: '0x1001', target: '0x1000' }, '0x00001001');

  // Invalid input remains a normal overview fallback and never escapes as an
  // exception. There is intentionally no catch around run(): valid routing
  // above must fail the test if the DOM path throws.
  await run({ kind: 'trace-value', address: 'not-an-address', target: '0x1000' });
  assert.deepEqual(navigations, ['/function/not-an-address/overview'],
    'invalid address must keep the existing overview fallback');
  assert.equal(valueFlowSheets().length, 5,
    'invalid address must not open a Value flow sheet');
} finally {
  closeAllSheets();
  if (previousDocument === undefined) delete globalThis.document;
  else globalThis.document = previousDocument;
  if (previousAnimationFrames === undefined) delete globalThis.requestAnimationFrame;
  else globalThis.requestAnimationFrame = previousAnimationFrames;
  if (previousUiRoot === undefined) delete globalThis.__HEX_UI_ROOT__;
  else globalThis.__HEX_UI_ROOT__ = previousUiRoot;
}

console.log('issue #6098 trace-value address identity regressions PASS');
