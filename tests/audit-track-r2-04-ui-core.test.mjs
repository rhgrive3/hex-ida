import test from 'node:test';
import assert from 'node:assert/strict';

import { createSemanticCfg } from '../js/semantics/cfg/index.js';
import { createActionRegistry } from '../js/ui/registry.js';
import { functionViews, openFunctionView } from '../js/ui/next-views.js';
import { queryFunctions, queryStrings, stringQueryIndexStats } from '../js/ui/explorer-index.js';

// Minimal deterministic DOM harness for headless Node testing of UI modules.
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
    this.clickedCount = 0;
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
  get nextSibling() {
    if (!this.parentNode) return null;
    const idx = this.parentNode.childNodes.indexOf(this);
    return idx >= 0 && idx + 1 < this.parentNode.childNodes.length ? this.parentNode.childNodes[idx + 1] : null;
  }
  setAttribute(name, value) {
    const s = String(value);
    this._attrs.set(name, s);
    if (name === 'class') this.classList._syncFromAttr(s);
    if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
      this.dataset[key] = s;
    }
  }
  getAttribute(name) { return this._attrs.has(name) ? this._attrs.get(name) : null; }
  removeAttribute(name) { this._attrs.delete(name); }
  hasAttribute(name) { return this._attrs.has(name); }
  _attach(node) {
    if (node instanceof FakeElement) {
      if (node.parentNode) node.remove();
      node.parentNode = this;
      node.parentElement = this;
    }
  }
  append(...nodes) {
    for (const raw of nodes) {
      if (raw == null || raw === false) continue;
      if (typeof raw === 'string' || typeof raw === 'number') {
        this.childNodes.push(String(raw));
      } else {
        this._attach(raw);
        this.childNodes.push(raw);
        this.children.push(raw);
      }
    }
  }
  appendChild(node) { this.append(node); return node; }
  prepend(...nodes) {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const raw = nodes[i];
      if (raw == null || raw === false) continue;
      if (typeof raw === 'string' || typeof raw === 'number') {
        this.childNodes.unshift(String(raw));
      } else {
        this._attach(raw);
        this.childNodes.unshift(raw);
        this.children.unshift(raw);
      }
    }
  }
  insertBefore(node, ref) {
    this._attach(node);
    if (!ref) {
      this.childNodes.push(node);
      if (node instanceof FakeElement) this.children.push(node);
      return node;
    }
    const ci = this.childNodes.indexOf(ref);
    if (ci < 0) this.childNodes.push(node);
    else this.childNodes.splice(ci, 0, node);
    if (node instanceof FakeElement) {
      const ei = this.children.indexOf(ref);
      if (ei < 0) this.children.push(node);
      else this.children.splice(ei, 0, node);
    }
    return node;
  }
  after(...nodes) {
    if (!this.parentNode) return;
    const ref = this.nextSibling;
    for (const node of nodes) {
      if (node == null || node === false) continue;
      this.parentNode.insertBefore(node, ref);
    }
  }
  before(...nodes) {
    if (!this.parentNode) return;
    for (const node of nodes) {
      if (node == null || node === false) continue;
      this.parentNode.insertBefore(node, this);
    }
  }
  replaceChildren(...nodes) {
    for (const child of this.children) { child.parentNode = null; child.parentElement = null; }
    this.children.length = 0;
    this.childNodes.length = 0;
    this._textContent = '';
    this.append(...nodes);
  }
  remove() {
    if (!this.parentNode) return;
    const p = this.parentNode;
    const ci = p.childNodes.indexOf(this);
    if (ci >= 0) p.childNodes.splice(ci, 1);
    const ei = p.children.indexOf(this);
    if (ei >= 0) p.children.splice(ei, 1);
    this.parentNode = null;
    this.parentElement = null;
  }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) {
    this._listeners.get(type)?.delete(fn);
  }
  dispatchEvent(event) {
    const evt = typeof event === 'string' ? { type:event } : { ...event };
    evt.target = evt.target || this;
    evt.currentTarget = this;
    evt.preventDefault = evt.preventDefault || (() => {});
    evt.stopPropagation = evt.stopPropagation || (() => {});
    for (const fn of [...(this._listeners.get(evt.type) || [])]) fn(evt);
    return true;
  }
  click() {
    this.clickedCount++;
    if (this.disabled) return;
    this.dispatchEvent({ type:'click' });
  }
  focus() {}
  blur() {}
  getBoundingClientRect() { return { left:0, top:0, width:300, height:200, right:300, bottom:200 }; }
  _matchesSimple(sel) {
    const s = sel.trim();
    if (!s) return false;
    if (s.startsWith('#')) return this.id === s.slice(1);
    if (s.startsWith('.')) return this.classList.contains(s.slice(1));
    const attrMatch = /^\[([a-zA-Z0-9_-]+)(?:="([^"]*)")?\]$/.exec(s);
    if (attrMatch) {
      if (!this.hasAttribute(attrMatch[1])) return false;
      return attrMatch[2] === undefined ? true : this.getAttribute(attrMatch[1]) === attrMatch[2];
    }
    const tagClass = /^([a-zA-Z0-9_-]+)\.([a-zA-Z0-9_-]+)$/.exec(s);
    if (tagClass) return this.tagName === tagClass[1].toUpperCase() && this.classList.contains(tagClass[2]);
    return this.tagName === s.toUpperCase();
  }
  matches(selector) {
    return selector.split(',').some((part) => {
      const tokens = part.trim().split(/\s+/);
      if (tokens.length === 1) return this._matchesSimple(tokens[0]);
      if (!this._matchesSimple(tokens[tokens.length - 1])) return false;
      let anc = this.parentElement;
      for (let i = tokens.length - 2; i >= 0; i--) {
        while (anc && !anc._matchesSimple(tokens[i])) anc = anc.parentElement;
        if (!anc) return false;
        anc = anc.parentElement;
      }
      return true;
    });
  }
  closest(selector) {
    let cur = this;
    while (cur) {
      if (cur.matches(selector)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }
  querySelectorAll(selector) {
    const out = [];
    const walk = (el) => {
      for (const child of el.children) {
        if (child.matches(selector)) out.push(child);
        walk(child);
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
    location: { href:'https://hex.test/', pathname:'/', search:'', hash:'#/investigate' },
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
  return { doc, win, appRoot, fileInput, overlays, titlebar };
}

function withDom(fn) {
  const prev = {
    window: globalThis.window,
    document: globalThis.document,
    location: globalThis.location,
    history: globalThis.history,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    Worker: globalThis.Worker,
    prompt: globalThis.prompt,
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

function createStore(initial = {}) {
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

function flushMicrotasks(turns = 8) {
  let p = Promise.resolve();
  for (let i = 0; i < turns; i++) p = p.then(() => new Promise((r) => setTimeout(r, 0)));
  return p;
}

// ---------------------------------------------------------------------------
// Bug 1 [P1]: product-base.js renderFlowTab canonical CFG rendering & navigation
// ---------------------------------------------------------------------------
test('Bug 1 [P1]: renderFlowTab renders canonical CFG blocks, edges from successors, titles, and navigates on click', async () => {
  const { installProductUI } = await import('../js/ui/product-base.js');
  await withDom(async (dom) => {
    const canonicalCfg = createSemanticCfg({
      functionId: 'fn_0x1000',
      entryBlockId: 'bb_0x1000',
      blocks: [
        {
          id: 'bb_0x1000',
          successors: [
            { to: 'bb_0x1010', kind: 'conditional-true' },
            { to: 'bb_0x1020', kind: 'conditional-false' },
          ],
        },
        {
          id: 'bb_0x1010',
          successors: [{ to: 'bb_0x1020', kind: 'branch' }],
        },
        {
          id: 'bb_0x1020',
          successors: [],
        },
      ],
    });

    const store = createStore({
      fileInfo: { name: 'sample.bin', arch: 'arm64' },
      canDisassemble: true,
      capability: { architecture: 'arm64', fixedInstructionSize: 4 },
      regions: [{ vmAddr: 0x1000n, size: 0x100n, exec: true, name: '__TEXT' }],
      currentAddress: 0x1000n,
    });
    const navigated = [];
    const app = {
      store,
      symbols: { nameAt: () => 'demo_func' },
      goToAddress: () => true,
      analysisQueries: {
        async snapshot() { return { id: 'snap-1' }; },
        async cfg(_snap, _addr) { return { completeness: 'complete', value: canonicalCfg }; },
      },
    };

    const installed = installProductUI(app);
    const origNav = installed.router.navigate.bind(installed.router);
    installed.router.navigate = (path, opts) => {
      navigated.push(path);
      return origNav(path, opts);
    };

    installed.router.navigate('/function/4096/flow');
    await flushMicrotasks();

    const host = dom.doc.getElementById('ui-route-host');
    const nodes = host.querySelectorAll('.g-node');
    const edges = host.querySelectorAll('.g-edge-group');
    assert.equal(nodes.length, 3, `all 3 canonical CFG blocks must render as graph nodes (host text: ${host.textContent})`);
    assert.equal(edges.length, 3, 'all 3 canonical CFG successor edges must render');

    const titles = nodes.map((n) => n.querySelector('.g-title')?.textContent || '');
    assert.equal(titles.every((t) => t.trim().length > 0), true, 'every graph node must have a non-empty title');
    assert.equal(titles.some((t) => /1010/i.test(t)), true, 'block address title should be derived from canonical block id');

    // Click the node for bb_0x1010 (0x1010 = 4112) and verify navigation.
    const node1010 = nodes.find((n) => /1010/i.test(n.querySelector('.g-title')?.textContent || ''));
    assert.ok(node1010, 'must find rendered node for bb_0x1010');
    node1010.click();
    assert.equal(navigated.includes('/code/4112'), true, 'clicking a canonical CFG node must navigate to /code/<addr>');
  });
});

// ---------------------------------------------------------------------------
// Bug 2 [P2]: product-base.js & product-hardened.js noFileActions unregistered file.open
// ---------------------------------------------------------------------------
test('Bug 2 [P2]: noFileActions falls back to #file-input when file.open is unregistered without throwing', async () => {
  const { installProductUI } = await import('../js/ui/product-base.js');
  const { installHardenedProductUI } = await import('../js/ui/product-hardened.js');

  await withDom(async (dom) => {
    const store = createStore({ fileInfo: null, regions: [] });
    const app = { store, openSample: () => {} };

    // 2a: product-base.js route (/explorer/functions with no fileInfo)
    const base = installProductUI(app);
    // Replace window.__hexUi.actions with an empty registry that does NOT register 'file.open'.
    const emptyRegistry = createActionRegistry();
    dom.win.__hexUi = { actions: emptyRegistry };

    base.router.navigate('/explorer/functions');
    await flushMicrotasks();

    const baseOpenBtn = dom.doc.getElementById('ui-route-host').querySelector('.ui-primary-action');
    assert.ok(baseOpenBtn, 'product-base no-file screen must render primary open button');
    assert.doesNotThrow(() => baseOpenBtn.click(), 'unregistered file.open must not throw in product-base');
    assert.equal(dom.fileInput.clickedCount, 1, 'should fall back to #file-input.click() in product-base');

    // Register file.open and confirm it runs when registered.
    let ranFileOpen = 0;
    emptyRegistry.register('file.open', () => { ranFileOpen++; });
    baseOpenBtn.click();
    assert.equal(ranFileOpen, 1, 'registered file.open action must be invoked');
  });

  await withDom(async (dom) => {
    const store = createStore({ fileInfo: null, regions: [] });
    const app = {
      store,
      openSample: () => {},
      analysisQueries: {
        async snapshot() { return { id: 's' }; },
        async claims() { return { completeness: 'complete', value: [], page: { next: null } }; },
        async strings() { return { completeness: 'complete', value: [], page: { next: null } }; },
      },
    };

    // 2b: product-hardened.js route (/results with no fileInfo)
    const hardened = installHardenedProductUI(app);
    const emptyRegistry = createActionRegistry();
    dom.win.__hexUi = { actions: emptyRegistry };

    hardened.router.navigate('/results');
    await flushMicrotasks();

    const hardenedOpenBtn = dom.doc.getElementById('ui-route-host').querySelector('.ui-primary-action');
    assert.ok(hardenedOpenBtn, 'product-hardened no-file screen must render primary open button');
    assert.doesNotThrow(() => hardenedOpenBtn.click(), 'unregistered file.open must not throw in product-hardened');
    assert.equal(dom.fileInput.clickedCount, 1, 'should fall back to #file-input.click() in product-hardened');
  });
});

// ---------------------------------------------------------------------------
// Bug 3 [P2]: dyld-runtime-navigation.js Worker disposal leak & onmessageerror
// ---------------------------------------------------------------------------
test('Bug 3 [P2]: dyld-runtime-navigation handles onmessageerror, postMessage throw, dispose(), and file switch without leaking Workers', async () => {
  const { installDyldRuntimeNavigation } = await import('../js/ui/dyld-runtime-navigation.js');

  await withDom(async () => {
    const workers = [];
    let postMessageThrows = false;
    class MockWorker {
      constructor() {
        this.terminated = false;
        this.onmessage = null;
        this.onerror = null;
        this.onmessageerror = null;
        workers.push(this);
      }
      postMessage() {
        if (postMessageThrows) throw new Error('DataCloneError');
      }
      terminate() { this.terminated = true; }
    }
    globalThis.Worker = MockWorker;
    const answers = [];
    globalThis.prompt = () => answers.shift();

    const fileA = { name: 'cacheA' };
    const fileB = { name: 'cacheB' };
    const store = createStore({
      file: fileA,
      fileInfo: { formatId: 'dyld-shared-cache' },
      regions: [],
    });
    const app = { store, selectRegion() {}, goToAddress() { return true; }, goToFileOffset() {} };
    const nav = installDyldRuntimeNavigation(app);
    assert.ok(nav, 'dyld runtime navigation should install');

    // 3a: onmessageerror settles and terminates worker
    answers.push('0x0', '0x1000');
    nav.button.click();
    await flushMicrotasks(2);
    assert.equal(workers.length, 1);
    const w1 = workers[0];
    assert.equal(typeof w1.onmessageerror, 'function', 'onmessageerror handler must be attached');
    w1.onmessageerror({});
    await flushMicrotasks(2);
    assert.equal(w1.terminated, true, 'worker must be terminated on onmessageerror');
    assert.equal(nav.button.disabled, false, 'button must re-enable after onmessageerror');

    // 3b: postMessage synchronous throw terminates worker
    postMessageThrows = true;
    answers.push('0x0', '0x2000');
    nav.button.click();
    await flushMicrotasks(2);
    assert.equal(workers.length, 2);
    assert.equal(workers[1].terminated, true, 'worker must be terminated when postMessage throws');
    postMessageThrows = false;

    // 3c: file switch terminates in-flight worker
    answers.push('0x0', '0x3000');
    nav.button.click();
    await flushMicrotasks(2);
    assert.equal(workers.length, 3);
    assert.equal(workers[2].terminated, false);
    store.set({ file: fileB });
    await flushMicrotasks(2);
    assert.equal(workers[2].terminated, true, 'in-flight worker must be terminated on file switch');

    // 3d: dispose() terminates in-flight worker
    answers.push('0x0', '0x4000');
    nav.button.click();
    await flushMicrotasks(2);
    assert.equal(workers.length, 4);
    assert.equal(workers[3].terminated, false);
    nav.dispose();
    await flushMicrotasks(2);
    assert.equal(workers[3].terminated, true, 'in-flight worker must be terminated on dispose()');
  });
});

// ---------------------------------------------------------------------------
// Bug 4 [P2]: explorer-index.js async race condition
// ---------------------------------------------------------------------------
test('Bug 4 [P2]: explorer-index prevents concurrent string normalization races and post-await abort leaks', async () => {
  const makeRows = () => Array.from({ length: 5000 }, (_, i) => ({ text: `StringRow_${i}_end`, addr: BigInt(0x1000 + i) }));

  // Baseline sequential run
  const seqRows = makeRows();
  await queryStrings(seqRows, 'stringrow_4999_end');
  const seqStats = stringQueryIndexStats(seqRows);
  assert.equal(seqStats.normalizedRows, 5000);

  // Concurrent race across the YIELD_EVERY (4096) boundary
  const raceRows = makeRows();
  const [resA, resB] = await Promise.all([
    queryStrings(raceRows, 'stringrow_4999_end'),
    queryStrings(raceRows, 'stringrow_10_end'),
  ]);
  assert.equal(resA.length, 1);
  assert.equal(resB.length, 1);
  const raceStats = stringQueryIndexStats(raceRows);
  assert.equal(raceStats.normalizedRows, 5000, 'normalizedRows must not regress under concurrent queries');
  assert.equal(raceStats.estimatedHeapBytes, seqStats.estimatedHeapBytes, 'heapBytes must not be double-counted under concurrent queries');

  // queryFunctions: abort while snapshot() is pending must reject with AbortError, not return stale data
  const controller = new AbortController();
  let resolveSnap;
  const app = {
    analysisQueries: {
      snapshot() { return new Promise((r) => { resolveSnap = r; }); },
      functions() { return Promise.resolve({ value: [{ address: 0x1000n, name: 'stale' }], completeness: 'complete' }); },
    },
  };
  const pending = queryFunctions(app, 'stale', { signal: controller.signal });
  controller.abort();
  resolveSnap({ id: 'snap-stale' });
  await assert.rejects(pending, (err) => err?.name === 'AbortError');

  // queryStrings: already-aborted signal on empty query must reject with AbortError
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(queryStrings(seqRows, '', { signal: aborted.signal }), (err) => err?.name === 'AbortError');
});

// ---------------------------------------------------------------------------
// Bug 5 [P2]: jev-advisory.js already-aborted parent AbortSignal
// ---------------------------------------------------------------------------
test('Bug 5 [P2]: appendJevAlternativeAction immediately detects an already-aborted parent AbortSignal', async () => {
  const { appendJevAlternativeAction } = await import('../js/ui/jev-advisory.js');

  await withDom(async (dom) => {
    const parent = new AbortController();
    parent.abort('parent-gone');

    let addedListener = false;
    const origAdd = parent.signal.addEventListener.bind(parent.signal);
    parent.signal.addEventListener = (...args) => {
      addedListener = true;
      return origAdd(...args);
    };

    const { cxxMemberIndexForApp, recoverCxxMembersForQuery } = await import('../js/analysis/query/app-adapter.js');
    const symbols = { gen: 1, names: ['_ZN6PlayerC1Ev'], addrs: [1n], funcs: [1n] };
    const backend = { file: {}, gen: 1, binaryId: 'jev-aborted-fixture', readAt: async () => ({ found: false }) };
    const app = {
      fields: { classCount: 0 },
      symbols,
      backend,
      store: { get: (key) => ({ architecture: 'arm64', sliceIndex: 0 })[key] },
      executableRegionFor: () => ({ start: 1n, end: 100n }),
      analysisQueries: {
        snapshot: async () => ({ snapshotId: 'snap-1' }),
        decompile: async () => { throw new Error('metadata-only'); },
      },
    };
    await recoverCxxMembersForQuery(app, 'player', { enabled: true, planOnly: true });
    const index = cxxMemberIndexForApp(app);
    assert.ok(index, 'cxxMemberIndexForApp should return bound index');
    Object.defineProperty(index, 'fieldCount', { value: 2, configurable: true });
    index.classes.set('Player', { ivars: [{ name: 'field_0', anonymous: true }, { name: 'field_4', anonymous: true }] });

    const host = dom.doc.createElement('div');
    dom.doc.body.append(host);
    appendJevAlternativeAction(app, { text: 'hp' }, { verdict: 'unverified' }, host, parent.signal);

    const row = host.querySelector('li.tappable');
    assert.ok(row, 'advisory action row should be rendered');
    row.click();

    assert.equal(addedListener, false, 'must not attach a dead abort listener to an already-aborted parentSignal');
    const submitBtn = dom.overlays.querySelector('button.chip');
    assert.ok(submitBtn, 'sheet submit button should exist');
    assert.equal(submitBtn.disabled, true, 'submit button must be immediately disabled when parentSignal is already aborted');
  });
});

// ---------------------------------------------------------------------------
// Bug 6 [P2]: next-views.js empty string and negative address validation
// ---------------------------------------------------------------------------
test('Bug 6 [P2]: next-views rejects empty, whitespace, negative, and non-numeric addresses', () => {
  const invalidAddresses = ['', '   ', '\t\n', -1, -1n, '-1', '-0x10', Number.NaN, Number.POSITIVE_INFINITY, 1.5, true, false, {}];
  for (const bad of invalidAddresses) {
    const views = functionViews({ address: bad });
    assert.equal(views.every((v) => v.available === false && v.address === null && v.route === null), true,
      `invalid address ${String(bad)} (${typeof bad}) must disable all views`);
  }

  // Valid addresses including 0 remain accepted.
  for (const good of [0, 0n, '0', '0x0', ' 0x1000 ']) {
    const views = functionViews({ address: good });
    assert.equal(views.every((v) => v.available === true && v.address !== null && v.route !== null), true,
      `valid address ${String(good)} must be accepted`);
  }

  // openFunctionView must reject invalid address overrides before calling router.navigate.
  const validView = functionViews({ address: 0x1000n }).find((v) => v.id === 'flow');
  let navCalls = 0;
  const router = { navigate() { navCalls++; return true; } };
  for (const bad of ['', '   ', -1, -1n, '-1', '-0x20']) {
    assert.equal(openFunctionView(validView, { router, address: bad }), false,
      `openFunctionView must reject invalid override ${String(bad)}`);
  }
  assert.equal(navCalls, 0, 'router.navigate must not be called for invalid address overrides');
});

// ---------------------------------------------------------------------------
// Bug 7 [P2]: product-hardened.js unsafe meta.signal access
// ---------------------------------------------------------------------------
test('Bug 7 [P2]: product-hardened safely handles null, undefined, and non-object meta / meta.signal across routes', async () => {
  const { installHardenedProductUI } = await import('../js/ui/product-hardened.js');

  await withDom(async (dom) => {
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const store = createStore({
        fileInfo: { name: 'sample.bin', arch: 'arm64' },
        regions: [{ vmAddr: 0x1000n, size: 0x100n, exec: true, name: '__TEXT' }],
      });
      const app = {
        store,
        symbols: { nameAt: () => 'fn_demo' },
        analysisQueries: {
          async snapshot() { return { id: 'snap-1' }; },
          async classification() {
            return { completeness: 'complete', value: { classification: 'APPLICATION', confidence: 0.9, evidence: [] } };
          },
          async claims() {
            return { completeness: 'complete', value: [], page: { offset: 0, limit: 500, returned: 0, total: 0, next: null } };
          },
          async strings() {
            return { completeness: 'complete', value: [], page: { offset: 0, limit: 200, returned: 0, total: 0, next: null } };
          },
        },
      };

      const installed = installHardenedProductUI(app);
      const badMetas = [undefined, null, {}, { signal: null }, { signal: 'not-a-signal' }, { signal: 42 }, { signal: {} }];

      const overviewRoute = { route: { id: 'function' }, params: { address: '4096', tab: 'overview' }, query: new URLSearchParams() };
      const resultsRoute = { route: { id: 'results' }, params: {}, query: new URLSearchParams() };
      const stringsRoute = { route: { id: 'explorer' }, params: { scope: 'strings' }, query: new URLSearchParams() };

      for (const meta of badMetas) {
        assert.doesNotThrow(() => installed.router.onRoute(overviewRoute, meta));
        assert.doesNotThrow(() => installed.router.onRoute(resultsRoute, meta));
        const strView = installed.router.onRoute(stringsRoute, meta);
        assert.ok(strView?.root);
        strView.dispose?.();
      }
      await flushMicrotasks();

      // Also verify catch-path with missing meta.signal does not throw unhandled rejection.
      app.analysisQueries.classification = async () => { throw new Error('boom-classification'); };
      app.analysisQueries.claims = async () => { throw new Error('boom-claims'); };
      installed.router.onRoute(overviewRoute, {});
      installed.router.onRoute(resultsRoute, null);
      await flushMicrotasks();

      assert.equal(unhandled.length, 0, `expected zero unhandled rejections, got: ${unhandled.map(String).join('; ')}`);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
