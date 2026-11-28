import test from 'node:test';
import assert from 'node:assert/strict';

import { Store } from '../js/state.js';
import { SymbolIndex } from '../js/symbols.js';
import { createAppAnalysisQueryAdapter } from '../js/analysis/query/app-adapter.js';
import { reasonText } from '../js/ui/primitives.js';

// Minimal deterministic DOM harness for headless Node testing of product-base.js.
class FakeClassList {
  constructor(el) { this.el = el; this.set = new Set(); }
  _syncFromAttr(val) {
    this.set = new Set(String(val || '').trim().split(/\s+/).filter(Boolean));
  }
  _syncToAttr() {
    this.el._attrs.set('class', [...this.set].join(' '));
  }
  add(...names) { for (const n of names) if (n) this.set.add(String(n)); this._syncToAttr(); }
  remove(...names) { for (const n of names) this.set.delete(String(n)); this._syncToAttr(); }
  toggle(name, force) {
    const has = this.set.has(name);
    const next = force === undefined ? !has : Boolean(force);
    if (next) this.set.add(name); else this.set.delete(name);
    this._syncToAttr();
    return next;
  }
  contains(name) { return this.set.has(name); }
}

class FakeElement {
  constructor(tagName, ownerDocument, ns = null) {
    this.tagName = String(tagName).toUpperCase();
    this.nodeName = this.tagName;
    this.namespaceURI = ns;
    this.ownerDocument = ownerDocument;
    this.parentElement = null;
    this.parentNode = null;
    this.children = [];
    this.childNodes = [];
    this._attrs = new Map();
    this.classList = new FakeClassList(this);
    this.dataset = {};
    this.style = {
      _props: new Map(),
      setProperty(k, v) { this._props.set(k, String(v)); },
      getPropertyValue(k) { return this._props.get(k) || ''; },
    };
    this._listeners = new Map();
    this._textContent = '';
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.type = '';
    this.title = '';
    this.scrollTop = 0;
    this.scrollLeft = 0;
    this.clientWidth = 600;
    this.clientHeight = 400;
  }
  get id() { return this._attrs.get('id') || ''; }
  set id(v) { this.setAttribute('id', String(v)); }
  get className() { return this._attrs.get('class') || ''; }
  set className(v) { this.setAttribute('class', String(v)); }
  get textContent() {
    if (!this.childNodes.length) return this._textContent;
    return this.childNodes.map((c) => (typeof c === 'string' ? c : c.textContent)).join('');
  }
  set textContent(v) {
    this.children.length = 0;
    this.childNodes.length = 0;
    this._textContent = String(v ?? '');
  }
  get isConnected() {
    let cur = this;
    while (cur) {
      if (cur === this.ownerDocument?.body || cur === this.ownerDocument?.documentElement) return true;
      cur = cur.parentNode;
    }
    return false;
  }
  setAttribute(name, value) {
    const s = String(value);
    this._attrs.set(name, s);
    if (name === 'class') this.classList._syncFromAttr(s);
    if (name === 'lang') this.lang = s;
  }
  getAttribute(name) { return this._attrs.has(name) ? this._attrs.get(name) : null; }
  hasAttribute(name) { return this._attrs.has(name); }
  removeAttribute(name) {
    this._attrs.delete(name);
    if (name === 'class') this.classList._syncFromAttr('');
  }
  append(...nodes) {
    for (const node of nodes) {
      if (node == null || node === false) continue;
      if (typeof node === 'string' || typeof node === 'number') {
        this.childNodes.push(String(node));
      } else if (node.tagName === '#FRAGMENT') {
        const fragChildren = [...node.childNodes];
        node.childNodes.length = 0;
        node.children.length = 0;
        this.append(...fragChildren);
      } else {
        if (node.parentNode) node.remove();
        node.parentNode = this;
        node.parentElement = this;
        this.childNodes.push(node);
        this.children.push(node);
      }
    }
  }
  prepend(...nodes) {
    const arr = [];
    for (const node of nodes) {
      if (node == null || node === false) continue;
      if (typeof node === 'string' || typeof node === 'number') {
        arr.push(String(node));
      } else {
        if (node.parentNode) node.remove();
        node.parentNode = this;
        node.parentElement = this;
        arr.push(node);
      }
    }
    this.childNodes.unshift(...arr);
    this.children = this.childNodes.filter((n) => typeof n !== 'string');
  }
  appendChild(node) { this.append(node); return node; }
  before(...nodes) {
    if (!this.parentNode) return;
    const p = this.parentNode;
    const idx = p.childNodes.indexOf(this);
    if (idx < 0) return;
    const insert = [];
    for (const n of nodes) {
      if (n == null || n === false) continue;
      if (typeof n === 'string' || typeof n === 'number') insert.push(String(n));
      else {
        if (n.parentNode) n.remove();
        n.parentNode = p;
        n.parentElement = p;
        insert.push(n);
      }
    }
    p.childNodes.splice(idx, 0, ...insert);
    p.children = p.childNodes.filter((n) => typeof n !== 'string');
  }
  after(...nodes) {
    if (!this.parentNode) return;
    const p = this.parentNode;
    const idx = p.childNodes.indexOf(this);
    if (idx < 0) return;
    const insert = [];
    for (const n of nodes) {
      if (n == null || n === false) continue;
      if (typeof n === 'string' || typeof n === 'number') insert.push(String(n));
      else {
        if (n.parentNode) n.remove();
        n.parentNode = p;
        n.parentElement = p;
        insert.push(n);
      }
    }
    p.childNodes.splice(idx + 1, 0, ...insert);
    p.children = p.childNodes.filter((n) => typeof n !== 'string');
  }
  replaceChildren(...nodes) {
    for (const c of this.children) { c.parentNode = null; c.parentElement = null; }
    this.children.length = 0;
    this.childNodes.length = 0;
    this._textContent = '';
    this.append(...nodes);
  }
  remove() {
    if (!this.parentNode) return;
    const p = this.parentNode;
    p.childNodes = p.childNodes.filter((n) => n !== this);
    p.children = p.children.filter((n) => n !== this);
    this.parentNode = null;
    this.parentElement = null;
  }
  contains(node) {
    if (node === this) return true;
    for (const c of this.children) if (c.contains(node)) return true;
    return false;
  }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) { this._listeners.get(type)?.delete(fn); }
  dispatchEvent(evt) {
    const e = evt && typeof evt === 'object' ? evt : { type: String(evt) };
    e.target = e.target || this;
    e.currentTarget = this;
    e.preventDefault = e.preventDefault || (() => {});
    e.stopPropagation = e.stopPropagation || (() => {});
    for (const fn of [...(this._listeners.get(e.type) || [])]) fn(e);
    return true;
  }
  click() { this.dispatchEvent({ type: 'click' }); }
  focus() {}
  getBoundingClientRect() { return { top: 0, left: 0, right: this.clientWidth, bottom: this.clientHeight, width: this.clientWidth, height: this.clientHeight }; }
  closest(sel) {
    let cur = this;
    while (cur) {
      if (cur._matches(sel)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }
  _matches(selector) {
    const parts = String(selector || '').split(',').map((s) => s.trim()).filter(Boolean);
    return parts.some((part) => this._matchesSingle(part));
  }
  _matchesSingle(sel) {
    if (!sel) return false;
    if (sel.includes(' ')) {
      const tokens = sel.trim().split(/\s+/);
      if (!this._matchesSimple(tokens[tokens.length - 1])) return false;
      let cur = this.parentElement;
      for (let i = tokens.length - 2; i >= 0; i--) {
        while (cur && !cur._matchesSimple(tokens[i])) cur = cur.parentElement;
        if (!cur) return false;
        cur = cur.parentElement;
      }
      return true;
    }
    return this._matchesSimple(sel);
  }
  _matchesSimple(sel) {
    let rest = sel;
    if (rest.endsWith(':last-child')) {
      rest = rest.slice(0, -':last-child'.length);
      const siblings = this.parentNode?.children || [];
      if (siblings[siblings.length - 1] !== this) return false;
    }
    const attrMatches = [...rest.matchAll(/\[([^\]=]+)(?:="([^"]*)")?\]/g)];
    rest = rest.replace(/\[[^\]]+\]/g, '');
    for (const m of attrMatches) {
      const [, attr, val] = m;
      if (val === undefined) { if (!this.hasAttribute(attr)) return false; }
      else if (this.getAttribute(attr) !== val) return false;
    }
    const idMatch = rest.match(/#([A-Za-z0-9_-]+)/);
    if (idMatch) {
      if (this.id !== idMatch[1]) return false;
      rest = rest.replace(idMatch[0], '');
    }
    const classes = [...rest.matchAll(/\.([A-Za-z0-9_-]+)/g)].map((m) => m[1]);
    rest = rest.replace(/\.[A-Za-z0-9_-]+/g, '');
    for (const c of classes) if (!this.classList.contains(c)) return false;
    if (rest && rest !== '*') {
      if (this.tagName !== rest.toUpperCase()) return false;
    }
    return true;
  }
  querySelectorAll(selector) {
    const out = [];
    const walk = (node) => {
      for (const c of node.children) {
        if (c._matches(selector)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function createFakeDom() {
  const listeners = new Map();
  const doc = {
    title: 'Hex',
    documentElement: null,
    body: null,
    createElement(tag) { return new FakeElement(tag, doc); },
    createElementNS(ns, tag) { return new FakeElement(tag, doc, ns); },
    createTextNode(text) { return String(text ?? ''); },
    createDocumentFragment() { return new FakeElement('#fragment', doc); },
    getElementById(id) { return doc.documentElement.querySelector('#' + id); },
    querySelector(sel) { return doc.documentElement.querySelector(sel); },
    querySelectorAll(sel) { return doc.documentElement.querySelectorAll(sel); },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    dispatchEvent(evt) {
      for (const fn of [...(listeners.get(evt.type) || [])]) fn(evt);
    },
  };
  doc.documentElement = new FakeElement('html', doc);
  doc.documentElement.lang = 'en';
  doc.body = new FakeElement('body', doc);
  doc.documentElement.append(doc.body);

  const appRoot = doc.createElement('div');
  appRoot.id = 'app';
  const titlebar = doc.createElement('div');
  titlebar.className = 'titlebar';
  const btnOpen = doc.createElement('button');
  btnOpen.id = 'btn-open';
  btnOpen.className = 'tb-btn';
  const fileInput = doc.createElement('input');
  fileInput.id = 'file-input';
  const overlays = doc.createElement('div');
  overlays.id = 'overlays';
  const viewer = doc.createElement('div');
  viewer.id = 'viewer';
  titlebar.append(btnOpen);
  appRoot.append(titlebar, fileInput, viewer, overlays);
  doc.body.append(appRoot);

  const winListeners = new Map();
  const win = {
    document: doc,
    innerWidth: 1024,
    innerHeight: 768,
    location: { href: 'https://hex.test/', pathname: '/', search: '', hash: '#/investigate' },
    history: {
      state: null,
      pushState(state, _title, url) {
        this.state = state;
        const hashIdx = String(url).indexOf('#');
        win.location.hash = hashIdx >= 0 ? String(url).slice(hashIdx) : '';
      },
      replaceState(state, _title, url) {
        this.state = state;
        const hashIdx = String(url).indexOf('#');
        win.location.hash = hashIdx >= 0 ? String(url).slice(hashIdx) : '';
      },
      back() {},
    },
    addEventListener(type, fn) {
      if (!winListeners.has(type)) winListeners.set(type, new Set());
      winListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) { winListeners.get(type)?.delete(fn); },
    dispatchEvent(evt) {
      for (const fn of [...(winListeners.get(evt.type) || [])]) fn(evt);
    },
    requestAnimationFrame(fn) { return setTimeout(() => fn(Date.now()), 0); },
    cancelAnimationFrame(id) { clearTimeout(id); },
  };
  return { doc, win, appRoot };
}

function withDom(fn) {
  const prev = {
    window: globalThis.window,
    document: globalThis.document,
    location: globalThis.location,
    history: globalThis.history,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
  };
  const dom = createFakeDom();
  globalThis.window = dom.win;
  globalThis.document = dom.doc;
  globalThis.location = dom.win.location;
  globalThis.history = dom.win.history;
  globalThis.requestAnimationFrame = dom.win.requestAnimationFrame;
  globalThis.cancelAnimationFrame = dom.win.cancelAnimationFrame;
  return Promise.resolve()
    .then(() => fn(dom))
    .finally(() => {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete globalThis[k];
        else globalThis[k] = v;
      }
    });
}

function createMockStore(initial = {}) {
  const data = { ...initial };
  const subs = new Set();
  return {
    get(key) { return data[key]; },
    set(patch) {
      Object.assign(data, patch);
      for (const fn of [...subs]) fn(data, patch);
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

function flushMicrotasks(turns = 10) {
  let p = Promise.resolve();
  for (let i = 0; i < turns; i++) p = p.then(() => new Promise((r) => setTimeout(r, 0)));
  return p;
}

test('Store DEFAULTS include symbolsGen: 0 and symbolsReady: false and reset() restores them', () => {
  const store = new Store();
  assert.equal(store.get('symbolsGen'), 0);
  assert.equal(store.get('symbolsReady'), false);
  store.set({ symbolsGen: 7, symbolsReady: true });
  assert.equal(store.get('symbolsGen'), 7);
  assert.equal(store.get('symbolsReady'), true);
  store.reset();
  assert.equal(store.get('symbolsGen'), 0);
  assert.equal(store.get('symbolsReady'), false);
});

test('Track 1: Explorer -> Functions shows loading while symbolsReady === false && analysisBaseSymbolsReady is pending, then auto-refreshes', async () => {
  const { installProductUI } = await import('../js/ui/product-base.js');
  await withDom(async (dom) => {
    let resolveBaseSymbols;
    const baseSymbolsPromise = new Promise((r) => { resolveBaseSymbols = r; });

    const store = new Store();
    store.set({
      fileInfo: { name: 'app.macho', size: 4096, format: 'Mach-O', slices: [] },
      sliceIndex: 0,
      architecture: 'arm64',
      canDisassemble: true,
      regions: [{ id: '__text', section: '__text', vmAddr: 0x1000n, size: 0x400n, exec: true }],
      symbolsGen: 0,
      symbolsReady: false,
    });

    const app = {
      store,
      symbols: new SymbolIndex({ regions: store.get('regions') }),
      analysisBaseSymbolsReady: baseSymbolsPromise,
      goToAddress: () => true,
    };

    const installed = installProductUI(app);
    installed.router.navigate('/explorer/functions');
    await flushMicrotasks();

    const host = dom.doc.getElementById('ui-route-host');
    assert.ok(host.querySelector('.ui-loading-state'), 'must show loading state while symbols are recovering');
    assert.match(host.textContent, /Recovering functions in the background|関数一覧をバックグラウンドで復元しています/);
    assert.equal(host.querySelector('.ui-empty-state'), null, 'must NOT show empty state while recovering');

    // Simulate background symbol recovery completing.
    const recovered = new SymbolIndex({
      addrs: new BigUint64Array([0x1000n, 0x1100n]),
      kinds: new Uint8Array([0, 0]),
      flags: new Uint8Array([1, 1]),
      names: ['_main', '_helper_fn'],
      funcs: new BigUint64Array([0x1000n, 0x1100n]),
      regions: store.get('regions'),
    });
    app.symbols = recovered;
    resolveBaseSymbols(true);
    store.set({ symbolsGen: recovered.gen, symbolsReady: true });
    await flushMicrotasks();

    assert.equal(host.querySelector('.ui-loading-state'), null, 'loading state must clear once symbols recover');
    assert.match(host.textContent, /_main/, 'recovered function _main must render automatically');
    assert.match(host.textContent, /_helper_fn/, 'recovered function _helper_fn must render automatically');
  });
});

test('Track 1: Mock store with symbolsReady === undefined does NOT get stuck in loading', async () => {
  const { installProductUI } = await import('../js/ui/product-base.js');
  await withDom(async (dom) => {
    // Mock store deliberately omits symbolsReady (get('symbolsReady') === undefined).
    const store = createMockStore({
      fileInfo: { name: 'mock.bin', size: 1024, format: 'Mach-O', slices: [] },
      regions: [{ id: '__text', section: '__text', vmAddr: 0x1000n, size: 0x100n, exec: true }],
    });
    assert.equal(store.get('symbolsReady'), undefined);

    const app = {
      store,
      symbols: new SymbolIndex({ regions: store.get('regions') }),
      analysisBaseSymbolsReady: new Promise(() => {}), // never resolves
      goToAddress: () => true,
    };

    const installed = installProductUI(app);
    installed.router.navigate('/explorer/functions');
    await flushMicrotasks();

    const host = dom.doc.getElementById('ui-route-host');
    assert.equal(host.querySelector('.ui-loading-state'), null, 'mock store with undefined symbolsReady must NOT stay in loading');
    assert.ok(host.querySelector('.ui-empty-state'), 'mock store with 0 functions must show normal empty state');
  });
});

test('Track 2: app-adapter.js preserves function-symbol-missing on decompile()', async () => {
  const store = new Store();
  store.set({
    fileInfo: { name: 'sample.macho', size: 4096, format: 'Mach-O', slices: [{ info: { architecture: 'arm64', isArm64: true } }] },
    sliceIndex: 0,
    architecture: 'arm64',
    canDisassemble: true,
    regions: [{ id: '__text', section: '__text', vmAddr: 0x1000n, size: 0x400n, exec: true }],
  });

  const app = {
    store,
    symbols: new SymbolIndex({ regions: store.get('regions') }),
    validatedFunctionRange: () => ({ ok: false, reason: 'function-symbol-missing' }),
    backend: { gen: 1 },
  };

  const adapter = createAppAnalysisQueryAdapter(app);
  const res = await adapter.decompile({ id: 'snap-1' }, 0x1000n);

  assert.equal(res.status?.completeness, 'unsupported');
  assert.equal(res.value, null);
  assert.equal(res.status?.reason, 'function-symbol-missing');
});

test('Track 2: renderPseudocodeTab awaits analysisBaseSymbolsReady, cleans up abort listener, and renders localized emptyState without raw reason code', async () => {
  const { installProductUI } = await import('../js/ui/product-base.js');

  // Track AbortSignal listener add/remove counts to verify zero listener leaks.
  const origAdd = AbortSignal.prototype.addEventListener;
  const origRemove = AbortSignal.prototype.removeEventListener;
  const trackedSignals = new Map();
  AbortSignal.prototype.addEventListener = function (type, fn, opts) {
    if (type === 'abort') {
      if (!trackedSignals.has(this)) trackedSignals.set(this, new Set());
      trackedSignals.get(this).add(fn);
    }
    return origAdd.call(this, type, fn, opts);
  };
  AbortSignal.prototype.removeEventListener = function (type, fn, opts) {
    if (type === 'abort') trackedSignals.get(this)?.delete(fn);
    return origRemove.call(this, type, fn, opts);
  };

  try {
    // Case A: Normal settle -> decompile returns unsupported('function-symbol-missing')
    await withDom(async (dom) => {
      let resolveBaseSymbols;
      const baseSymbolsPromise = new Promise((r) => { resolveBaseSymbols = r; });
      let decompileCalled = false;

      const store = new Store();
      store.set({
        fileInfo: { name: 'sample.macho', size: 4096, format: 'Mach-O', slices: [] },
        sliceIndex: 0,
        architecture: 'arm64',
        canDisassemble: true,
        capability: { architecture: 'arm64', fixedInstructionSize: 4 },
        regions: [{ id: '__text', section: '__text', vmAddr: 0x1000n, size: 0x400n, exec: true }],
        currentAddress: 0x1000n,
        symbolsGen: 0,
        symbolsReady: false,
      });

      const navigated = [];
      const app = {
        store,
        symbols: new SymbolIndex({ regions: store.get('regions') }),
        analysisBaseSymbolsReady: baseSymbolsPromise,
        goToAddress: () => true,
        analysisQueries: {
          async snapshot() { return { id: 'snap-1' }; },
          async decompile() {
            decompileCalled = true;
            return { completeness: 'unsupported', value: null, status: { reason: 'function-symbol-missing' } };
          },
        },
      };

      const installed = installProductUI(app);
      const origNav = installed.router.navigate.bind(installed.router);
      installed.router.navigate = (path, opts) => {
        navigated.push(path);
        return origNav(path, opts);
      };

      installed.router.navigate('/function/4096/pseudocode');
      await flushMicrotasks();

      const host = dom.doc.getElementById('ui-route-host');
      assert.equal(decompileCalled, false, 'decompile must wait until analysisBaseSymbolsReady settles');
      assert.match(host.textContent, /Waiting for symbol recovery|シンボル復元を待機しています/);

      resolveBaseSymbols(true);
      store.set({ symbolsReady: true });
      await flushMicrotasks();

      assert.equal(decompileCalled, true, 'decompile must proceed after analysisBaseSymbolsReady resolves');
      assert.equal(host.textContent.includes('function-symbol-missing'), false, 'raw reason code must NEVER appear in DOM');
      assert.equal(host.querySelector('.ui-state-code'), null, 'must not render internal reason code element');

      const expectedPlain = reasonText('function-symbol-missing');
      assert.ok(expectedPlain, 'reasonText(function-symbol-missing) must exist');
      assert.ok(host.textContent.includes(expectedPlain), `DOM must include localized reasonText: ${expectedPlain}`);

      const actionsWrap = host.querySelector('.ui-actions');
      assert.ok(actionsWrap, 'must wrap actions in a single .ui-actions container');
      const buttons = actionsWrap.querySelectorAll('button');
      assert.equal(buttons.length, 2, 'must render Open in Assembly and Browse Functions buttons');

      const asmBtn = buttons.find((b) => /Open in Assembly|アセンブリで開く/.test(b.textContent));
      const browseBtn = buttons.find((b) => /Browse Functions|関数一覧を開く/.test(b.textContent));
      assert.ok(asmBtn, 'must render Open in Assembly button');
      assert.ok(browseBtn, 'must render Browse Functions button');

      asmBtn.click();
      assert.equal(navigated.includes('/code/4096'), true, 'Open in Assembly must navigate to /code/<addr>');
      browseBtn.click();
      assert.equal(navigated.includes('/explorer/functions'), true, 'Browse Functions must navigate to /explorer/functions');
    });

    // Case B: User cancels while waiting on analysisBaseSymbolsReady -> abort listener removed cleanly
    trackedSignals.clear();
    await withDom(async (dom) => {
      const pendingBaseSymbols = new Promise(() => {});
      let decompileCalled = false;

      const store = new Store();
      store.set({
        fileInfo: { name: 'sample.macho', size: 4096, format: 'Mach-O', slices: [] },
        sliceIndex: 0,
        architecture: 'arm64',
        canDisassemble: true,
        capability: { architecture: 'arm64', fixedInstructionSize: 4 },
        regions: [{ id: '__text', section: '__text', vmAddr: 0x1000n, size: 0x400n, exec: true }],
        currentAddress: 0x1000n,
        symbolsGen: 0,
        symbolsReady: false,
      });

      const app = {
        store,
        symbols: new SymbolIndex({ regions: store.get('regions') }),
        analysisBaseSymbolsReady: pendingBaseSymbols,
        goToAddress: () => true,
        analysisQueries: {
          async snapshot() { return { id: 'snap-1' }; },
          async decompile() { decompileCalled = true; return { completeness: 'complete', value: {} }; },
        },
      };

      const installed = installProductUI(app);
      installed.router.navigate('/function/4096/pseudocode');
      await flushMicrotasks();

      const host = dom.doc.getElementById('ui-route-host');
      const cancelBtn = host.querySelectorAll('button').find((b) => /Cancel|キャンセル/.test(b.textContent));
      assert.ok(cancelBtn, 'must render Cancel button while waiting for symbol recovery');
      cancelBtn.click();
      await flushMicrotasks();

      assert.equal(decompileCalled, false, 'cancelled wait must not start decompile');
      for (const listeners of trackedSignals.values()) {
        assert.equal(listeners.size, 0, 'abort listeners on localSignal must be removed in finally block');
      }
    });

    // Case C: Rejected error with known reason code ('function-symbol-missing') renders clean emptyState
    await withDom(async (dom) => {
      const store = new Store();
      store.set({
        fileInfo: { name: 'sample.macho', size: 4096, format: 'Mach-O', slices: [] },
        sliceIndex: 0,
        architecture: 'arm64',
        canDisassemble: true,
        capability: { architecture: 'arm64', fixedInstructionSize: 4 },
        regions: [{ id: '__text', section: '__text', vmAddr: 0x1000n, size: 0x400n, exec: true }],
        currentAddress: 0x1000n,
        symbolsGen: 1,
        symbolsReady: true,
      });

      const app = {
        store,
        symbols: new SymbolIndex({ regions: store.get('regions') }),
        goToAddress: () => true,
        analysisQueries: {
          async snapshot() { return { id: 'snap-1' }; },
          async decompile() { throw new Error('function-symbol-missing'); },
        },
      };

      const installed = installProductUI(app);
      installed.router.navigate('/function/4096/pseudocode');
      await flushMicrotasks();

      const host = dom.doc.getElementById('ui-route-host');
      assert.equal(host.textContent.includes('function-symbol-missing'), false, 'catch path must NOT leak raw reason code');
      assert.ok(host.querySelector('.ui-empty-state'), 'catch path must render emptyState instead of errorState');
      assert.equal(host.querySelector('.ui-error-state'), null, 'catch path must NOT render errorState for known reasonText');
      assert.equal(host.querySelectorAll('.ui-actions button').length, 2, 'catch path must include both action buttons');
    });

    // Case D: function-symbol-missing on non-fixed-width arch (e.g. x86_64 with fixedInstructionSize: null)
    await withDom(async (dom) => {
      const store = new Store();
      store.set({
        fileInfo: { name: 'x86.elf', size: 4096, format: 'ELF', slices: [] },
        sliceIndex: 0,
        architecture: 'x86_64',
        canDisassemble: true,
        capability: { architecture: 'x86_64', fixedInstructionSize: null, instructionAlignment: 1 },
        regions: [{ id: '.text', section: '.text', vmAddr: 0x401000n, size: 0x400n, exec: true }],
        currentAddress: 0x401000n,
        symbolsGen: 1,
        symbolsReady: true,
      });

      const app = {
        store,
        symbols: new SymbolIndex({ regions: store.get('regions') }),
        goToAddress: () => true,
        analysisQueries: {
          async snapshot() { return { id: 'snap-x86' }; },
          async decompile() {
            return {
              completeness: 'unsupported',
              value: null,
              status: { completeness: 'unsupported', reason: 'function-symbol-missing' },
            };
          },
        },
      };

      const installed = installProductUI(app);
      installed.router.navigate('/function/4198400/pseudocode');
      await flushMicrotasks();

      const host = dom.doc.getElementById('ui-route-host');
      assert.equal(host.textContent.includes('function-symbol-missing'), false, 'must NOT leak raw reason code');
      assert.equal(host.textContent.includes('architecture'), false, 'must NOT show unsupported-architecture message for function-symbol-missing');
      assert.ok(host.querySelector('.ui-empty-state'), 'must render localized emptyState');
      assert.equal(host.querySelectorAll('.ui-actions button').length, 2, 'must include Open in Assembly + Browse Functions buttons');
    });
  } finally {
    AbortSignal.prototype.addEventListener = origAdd;
    AbortSignal.prototype.removeEventListener = origRemove;
  }
});

test('Track 2: renderFunctionWorkspace waiting guard force-re-renders when validatedFunctionRange recovers, and cleans up on dispose', async () => {
  const { installProductUI } = await import('../js/ui/product-base.js');
  // Recovery case
  await withDom(async (dom) => {
    const store = new Store();
    store.set({
      fileInfo: { name: 'big.macho', size: 1024 * 1024, format: 'Mach-O', slices: [] },
      sliceIndex: 0,
      architecture: 'arm64',
      canDisassemble: true,
      capability: { architecture: 'arm64', fixedInstructionSize: 4 },
      regions: [{ id: '__text', section: '__text', vmAddr: 0x1000n, size: 0x400n, exec: true }],
      currentAddress: 0x1000n,
      symbolsGen: 0,
      symbolsReady: false,
    });

    let resolveBase;
    const baseReady = new Promise((r) => { resolveBase = r; });
    let rangeOk = false;

    const app = {
      store,
      symbols: new SymbolIndex({ regions: store.get('regions') }),
      analysisBaseSymbolsReady: baseReady,
      validatedFunctionRange: (a) => rangeOk
        ? { ok: true, start: BigInt(a), end: BigInt(a) + 0x20n, complete: true }
        : { ok: false, reason: 'function-symbol-missing' },
      goToAddress: () => true,
      analysisQueries: {
        async snapshot() { return { id: 'snap-rec' }; },
        async decompile() {
          return {
            completeness: 'unsupported',
            value: null,
            status: { completeness: 'unsupported', reason: 'function-end-unproven' },
          };
        },
      },
    };

    const installed = installProductUI(app);
    installed.router.navigate('/function/4096/pseudocode');
    await flushMicrotasks();

    const host = dom.doc.getElementById('ui-route-host');
    assert.ok(host.querySelector('.ui-loading-state'), 'must show waiting spinner while symbolsReady === false');

    // Now simulate background symbol recovery succeeding
    rangeOk = true;
    store.set({ symbolsGen: 1, symbolsReady: true });
    resolveBase(true);
    await flushMicrotasks();
    await flushMicrotasks();

    assert.equal(host.querySelector('.ui-loading-state'), null, 'must exit waiting spinner after forcePush re-render');
    assert.ok(host.querySelector('.ui-empty-state'), 'must render workspace pseudocode view after recovery');
  });

  // Dispose before settlement case
  await withDom(async (dom) => {
    const store = new Store();
    store.set({
      fileInfo: { name: 'big.macho', size: 1024 * 1024, format: 'Mach-O', slices: [] },
      sliceIndex: 0,
      architecture: 'arm64',
      canDisassemble: true,
      capability: { architecture: 'arm64', fixedInstructionSize: 4 },
      regions: [{ id: '__text', section: '__text', vmAddr: 0x1000n, size: 0x400n, exec: true }],
      currentAddress: 0x1000n,
      symbolsGen: 0,
      symbolsReady: false,
    });

    let resolveBase;
    const baseReady = new Promise((r) => { resolveBase = r; });
    const app = {
      store,
      symbols: new SymbolIndex({ regions: store.get('regions') }),
      analysisBaseSymbolsReady: baseReady,
      validatedFunctionRange: () => ({ ok: false, reason: 'function-symbol-missing' }),
      goToAddress: () => true,
    };

    const installed = installProductUI(app);
    installed.router.navigate('/function/4096/pseudocode');
    await flushMicrotasks();

    // Navigate away (disposes waiting view) before symbols settle
    installed.router.navigate('/explorer/functions');
    await flushMicrotasks();

    store.set({ symbolsGen: 1, symbolsReady: true });
    resolveBase(true);
    await flushMicrotasks();

    assert.equal(installed.router.current.fullPath, '/explorer/functions', 'disposed wait must not hijack active route');
  });
});
