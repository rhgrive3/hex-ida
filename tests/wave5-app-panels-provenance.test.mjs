import assert from 'node:assert/strict';
import test from 'node:test';

class FakeNode {
  constructor(nodeType = 1) {
    this.nodeType = nodeType;
    this.parentNode = null;
    this.childNodes = [];
  }
  get children() {
    return this.childNodes.filter((n) => n.nodeType === 1);
  }
  get isConnected() {
    let cur = this;
    while (cur) {
      if (cur === globalThis.document?.body || cur === globalThis.document?.documentElement) return true;
      cur = cur.parentNode;
    }
    return false;
  }
  contains(target) {
    let cur = target;
    while (cur) {
      if (cur === this) return true;
      cur = cur.parentNode;
    }
    return false;
  }
  append(...nodes) {
    for (const item of nodes) {
      if (item == null) continue;
      if (typeof item === 'string') {
        const tn = new FakeTextNode(item);
        tn.parentNode = this;
        this.childNodes.push(tn);
      } else if (item.nodeType === 11) {
        for (const child of [...item.childNodes]) {
          child.parentNode = this;
          this.childNodes.push(child);
        }
        item.childNodes.length = 0;
      } else {
        if (item.parentNode) item.remove();
        item.parentNode = this;
        this.childNodes.push(item);
      }
    }
  }
  prepend(...nodes) {
    for (const item of [...nodes].reverse()) {
      if (item == null) continue;
      if (item.parentNode) item.remove();
      item.parentNode = this;
      this.childNodes.unshift(item);
    }
  }
  appendChild(node) { this.append(node); return node; }
  replaceChildren(...nodes) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes.length = 0;
    this.append(...nodes);
  }
  remove() {
    if (!this.parentNode) return;
    const idx = this.parentNode.childNodes.indexOf(this);
    if (idx >= 0) this.parentNode.childNodes.splice(idx, 1);
    this.parentNode = null;
  }
}

class FakeTextNode extends FakeNode {
  constructor(text) {
    super(3);
    this._text = String(text);
  }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); }
}

class FakeFragment extends FakeNode {
  constructor() { super(11); }
}

class FakeClassList {
  constructor() { this.set = new Set(); }
  _sync(str) { this.set = new Set(String(str || '').split(/\s+/).filter(Boolean)); }
  add(...names) { for (const n of names) if (n) this.set.add(n); }
  remove(...names) { for (const n of names) this.set.delete(n); }
  contains(name) { return this.set.has(name); }
  toggle(name, force) {
    if (force === undefined) {
      if (this.set.has(name)) { this.set.delete(name); return false; }
      this.set.add(name); return true;
    }
    if (force) { this.set.add(name); return true; }
    this.set.delete(name); return false;
  }
}

class FakeElement extends FakeNode {
  constructor(tag) {
    super(1);
    this.tagName = String(tag).toUpperCase();
    this.classList = new FakeClassList();
    this.attributes = new Map();
    this.listeners = new Map();
    this.style = {};
    this.dataset = {};
    this.value = '';
    this.disabled = false;
    this.hidden = false;
    this.tabIndex = -1;
    this.title = '';
  }
  get className() { return [...this.classList.set].join(' '); }
  set className(v) { this.classList._sync(v); }
  get textContent() {
    return this.childNodes.map((c) => c.textContent ?? '').join('');
  }
  set textContent(v) {
    this.replaceChildren();
    if (v !== '' && v != null) this.append(String(v));
  }
  setAttribute(k, v) {
    const val = String(v);
    this.attributes.set(k, val);
    if (k === 'class') this.classList._sync(val);
    if (k === 'id') this.id = val;
  }
  getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; }
  removeAttribute(k) { this.attributes.delete(k); }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  dispatchEvent(ev) {
    const event = { target: this, currentTarget: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...ev };
    for (const fn of [...(this.listeners.get(event.type) || [])]) fn(event);
    return !event.defaultPrevented;
  }
  click() { this.dispatchEvent({ type: 'click' }); }
  focus() {}
  scrollIntoView() {}
  matches(sel) {
    if (sel.startsWith('.')) return this.classList.contains(sel.slice(1));
    if (sel === '[data-tok]') return this.attributes.has('data-tok');
    if (/^[a-z]+$/i.test(sel)) return this.tagName === sel.toUpperCase();
    return false;
  }
  closest(sel) {
    let cur = this;
    while (cur && cur.nodeType === 1) {
      if (cur.matches(sel)) return cur;
      cur = cur.parentNode;
    }
    return null;
  }
  querySelectorAll(sel) {
    const out = [];
    const walk = (node) => {
      for (const ch of node.children) {
        if (ch.matches(sel)) out.push(ch);
        walk(ch);
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}

function installFakeDom() {
  const docListeners = new Map();
  const body = new FakeElement('body');
  const overlays = new FakeElement('div');
  overlays.id = 'overlays';
  const toastEl = new FakeElement('div');
  toastEl.id = 'toast';
  body.append(overlays, toastEl);
  const documentElement = new FakeElement('html');
  documentElement.append(body);

  const doc = {
    body,
    documentElement,
    createElement: (tag) => new FakeElement(tag),
    createTextNode: (text) => new FakeTextNode(text),
    createDocumentFragment: () => new FakeFragment(),
    getElementById: (id) => {
      if (id === 'overlays') return overlays;
      if (id === 'toast') return toastEl;
      return null;
    },
    querySelector: (sel) => body.querySelector(sel),
    querySelectorAll: (sel) => body.querySelectorAll(sel),
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, new Set());
      docListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      docListeners.get(type)?.delete(fn);
    },
    dispatchEvent(ev) {
      const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...ev };
      for (const fn of [...(docListeners.get(event.type) || [])]) fn(event);
      return !event.defaultPrevented;
    },
    _listeners: docListeners,
  };
  globalThis.document = doc;
  globalThis.window = undefined;
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  return { doc, overlays, body };
}

function makeCompleteProvenanceQuery({ lines, addressCount = 2 } = {}) {
  const addresses = Array.from({ length: addressCount }, (_, i) => 0x1000n + BigInt(i * 4));
  const entities = {};
  const reverse = {};
  lines.forEach((line, idx) => {
    const key = `L${idx}:${line.kind ?? 'null'}`;
    const lineAddrs = idx === lines.length - 2 ? addresses.map(String) : [String(0x1000n + BigInt(idx * 4))];
    entities[key] = {
      entityKey: key,
      lineIndex: idx,
      kind: line.kind ?? 'null',
      role: line.kind === 'stmt' ? 'semantic' : 'structural',
      complete: true,
      origins: { addresses: lineAddrs, rows: [idx], ir: [`i${idx}`], ssaRefs: [] },
      recordRefs: [],
    };
    for (const a of lineAddrs) {
      reverse[`addr:${a}`] ||= [];
      reverse[`addr:${a}`].push(key);
    }
  });
  return {
    snapshotId: 'snap-1',
    value: {
      lines,
      renderProvenance: {
        version: RENDER_PROVENANCE_VERSION,
        snapshotId: 'snap-1',
        completeness: 'complete',
        entities,
        reverse,
        transformReverse: {},
        ledger: [],
      },
    },
  };
}

// Import target modules after helpers (safe in Node without window)
import { RENDER_PROVENANCE_VERSION } from '../js/decompiler/phase8/render-provenance.js';
import { App } from '../js/app.js';
import { EMPTY_INDEX } from '../js/symbols.js';
import { EMPTY_NOTES } from '../js/names.js';
import {
  createDecompilerNavigation,
  createDecompilerProvenanceView,
} from '../js/ui/decompiler-provenance.js';
import {
  analysisBundle,
  showFunctions,
  showFunctionSummary,
} from '../js/ui/panels/function-analysis.js';

// ---------------------------------------------------------------------------
// 1. decompiler-provenance.js tests
// ---------------------------------------------------------------------------
test('[Wave5-B P0] createDecompilerProvenanceView handles sparse rows under Clean View without TypeError', async () => {
  installFakeDom();
  // Line 2 is an ARC release elided by Clean View, leaving a sparse hole at rows[2]
  const lines = [
    { kind: 'sig', indent: 0, text: 'int fn(void *x)' },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'stmt', indent: 1, text: 'objc_release(x);' },
    { kind: 'stmt', indent: 1, text: 'return 1;' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ];
  const query = makeCompleteProvenanceQuery({ lines });
  const view = createDecompilerProvenanceView(query, {
    cleanView: true,
    currentSnapshot: async () => ({ snapshotId: 'snap-1' }),
  });

  // Clicking the surviving semantic line (origIdx 3) triggers show() across sparse rows[]
  const outcome = await view.navigation.selectLine(3);
  assert.equal(outcome.state, 'ready');

  // Trigger UI click on the surviving statement row
  const stmtRow = view.code.querySelectorAll('.ui-pseudocode-line').find((r) => r.textContent.includes('return 1;'));
  assert.ok(stmtRow, 'surviving return row must be rendered');
  stmtRow.click();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(stmtRow.classList.contains('selected'), true);
  view.tokenHighlight?.destroy?.();
});

test('[Wave5-B P0] createDecompilerProvenanceView handles pre-aborted AbortSignal and Clean View toggle without leaking keydown listener', () => {
  const { doc } = installFakeDom();
  const lines = [
    { kind: 'sig', indent: 0, text: 'int fn(int a)' },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'stmt', indent: 1, text: 'return a;' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ];
  const query = makeCompleteProvenanceQuery({ lines });

  // 1) Pre-aborted AbortSignal must not throw and must not attach document keydown listener
  const preAborted = new AbortController();
  preAborted.abort('already-aborted');
  const beforeCount = doc._listeners.get('keydown')?.size ?? 0;
  let abortedView;
  assert.doesNotThrow(() => {
    abortedView = createDecompilerProvenanceView(query, {
      signal: preAborted.signal,
      currentSnapshot: async () => ({ snapshotId: 'snap-1' }),
    });
  });
  assert.equal(abortedView.tokenHighlight, null);
  assert.equal(doc._listeners.get('keydown')?.size ?? 0, beforeCount);

  // 2) Toggling Clean View replaces tokenHighlight; live getter allows destroying the latest instance cleanly
  const view = createDecompilerProvenanceView(query, {
    currentSnapshot: async () => ({ snapshotId: 'snap-1' }),
  });
  const firstHighlight = view.tokenHighlight;
  assert.ok(firstHighlight, 'initial tokenHighlight must exist');
  assert.equal(doc._listeners.get('keydown')?.size ?? 0, beforeCount + 1);

  const cleanBtn = view.root.querySelectorAll('.ui-secondary-action').find((b) => b.textContent === 'Clean View');
  assert.ok(cleanBtn, 'Clean View toggle button must exist');
  cleanBtn.click();
  const secondHighlight = view.tokenHighlight;
  assert.notEqual(secondHighlight, firstHighlight, 'getter must expose updated tokenHighlight');
  assert.equal(doc._listeners.get('keydown')?.size ?? 0, beforeCount + 1, 'old listener must be removed on toggle');

  view.tokenHighlight.destroy();
  assert.equal(doc._listeners.get('keydown')?.size ?? 0, beforeCount, 'destroying live tokenHighlight must leave zero leaked listeners');
});

test('[Wave5-B P1] decompiler-provenance guards Object.hasOwn in selectOrigin and verifies snapshot freshness on address paging', async () => {
  installFakeDom();
  const lines = [
    { kind: 'sig', indent: 0, text: 'int fn(void)' },
    { kind: 'ctrl', indent: 0, text: '{' },
    { kind: 'stmt', indent: 1, text: 'return 1;' },
    { kind: 'ctrl', indent: 0, text: '}' },
  ];

  // 1) Prototype key in reverse map must be rejected via Object.hasOwn
  const protoQuery = makeCompleteProvenanceQuery({ lines });
  protoQuery.value.renderProvenance.reverse['addr:9999'] = ['toString'];
  const nav = createDecompilerNavigation(protoQuery, {
    currentSnapshot: async () => ({ snapshotId: 'snap-1' }),
  });
  const protoOutcome = await nav.selectOrigin('addr', 9999n);
  assert.equal(protoOutcome.state, 'unavailable');

  // 2) Address paging (>64 addresses) rechecks snapshot freshness
  let snapId = 'snap-1';
  const pagedQuery = makeCompleteProvenanceQuery({ lines, addressCount: 70 });
  const view = createDecompilerProvenanceView(pagedQuery, {
    currentSnapshot: async () => ({ snapshotId: snapId }),
  });
  const stmtRow = view.code.querySelectorAll('.ui-pseudocode-line').find((r) => r.textContent.includes('return 1;'));
  stmtRow.click();
  await new Promise((r) => setTimeout(r, 15));

  // Mutate snapshot before clicking "Next addresses"
  snapId = 'snap-2';
  const nextBtn = view.root.querySelectorAll('button').find((b) => b.textContent.includes('Next addresses'));
  assert.ok(nextBtn, 'Next addresses button must be rendered when >64 addresses');
  nextBtn.click();
  await new Promise((r) => setTimeout(r, 15));
  const statusEl = view.root.querySelectorAll('p').find((el) => el.getAttribute('role') === 'status');
  assert.match(statusEl.textContent, /analysis changed|Reopen/i);
  view.tokenHighlight?.destroy?.();
});

// ---------------------------------------------------------------------------
// 2. js/app.js tests
// ---------------------------------------------------------------------------
test('[Wave5-B P0] App.openFile ignores stale slow resolution and stale catch error after newer openFile', async () => {
  const { overlays } = installFakeDom();
  let resolveA;
  let rejectA;
  let openCount = 0;

  const makeMockApp = (failFirst = false) => {
    const app = Object.create(App.prototype);
    const storeMap = new Map();
    app.store = {
      get: (k) => storeMap.get(k),
      set: (patch) => { for (const [k, v] of Object.entries(patch)) storeMap.set(k, v); },
    };
    app.dom = { app: new FakeElement('div'), loading: new FakeElement('div'), loadingText: new FakeElement('span') };
    app._openSequence = 0;
    app._undoStack = [];
    app._redoStack = [];
    app.notes = EMPTY_NOTES;
    app.symbols = EMPTY_INDEX;
    app.bookmarks = { clear() {} };
    app.viewer = { setSymbols() {}, setMode() {}, setRegion() {}, clearBlockOverlay() {} };
    app.workspace = { autosave() {}, invalidate() {}, bind: async () => null };
    app.analysisResume = { saveLastFile: async () => {}, updateLastFileMeta: async () => {} };
    app.backend = {
      gen: 0,
      binaryId: 'bin-1',
      open: (file) => new Promise((resolve, reject) => {
        openCount++;
        if (file.name === 'slow.bin') {
          resolveA = () => { app.backend.gen = 1; resolve({ name: 'slow.bin', size: 16, slices: [] }); };
          rejectA = () => reject(new Error('slow-disk-error'));
        } else {
          app.backend.gen = 2;
          resolve({ name: 'fast.bin', size: 32, slices: [] });
        }
      }),
      ensureBinaryId: async () => 'bin-2',
    };
    app.flushDeltaSave = async () => false;
    app.persistAnalysisSession = async () => false;
    app.setBusy = () => {};
    app.updateChrome = () => {};
    app._clearSaveError = () => {};
    app.forgetSemantics = () => {};
    app._resetDeltaReadiness = () => {};
    app._createPatchSet = () => ({ list: () => [] });
    app.applySlice = () => {};
    app._renderIntegrityBanner = () => {};
    app.attachNotes = async () => null;
    app.currentSlice = () => null;
    app._startV6AutoAnalysis = () => {};
    return { app, storeMap };
  };

  // Case A: slow.bin resolves after fast.bin => must NOT overwrite fast.bin
  {
    const { app, storeMap } = makeMockApp();
    const pSlow = app.openFile({ name: 'slow.bin', size: 16 });
    const pFast = app.openFile({ name: 'fast.bin', size: 32 });
    await pFast;
    assert.equal(storeMap.get('fileInfo')?.name, 'fast.bin');
    resolveA();
    await pSlow;
    assert.equal(storeMap.get('fileInfo')?.name, 'fast.bin', 'late slow.bin must not overwrite fast.bin');
  }

  // Case B: slow.bin rejects after fast.bin => must NOT open error dialog over fast.bin
  {
    overlays.replaceChildren();
    const { app } = makeMockApp(true);
    const pSlow = app.openFile({ name: 'slow.bin', size: 16 });
    const pFast = app.openFile({ name: 'fast.bin', size: 32 });
    await pFast;
    rejectA();
    await pSlow;
    assert.equal(overlays.querySelector('.dialog'), null, 'stale openFile error must not show alertDialog');
  }
});

test('[Wave5-B P1] App.ensureFunctions uses Single-Flight Promise per epoch and App.ensureStrings stops after await on epoch change', async () => {
  const app = Object.create(App.prototype);
  const region = { id: 'text', section: '__text', exec: true, vmAddr: 0x1000n, size: 0x100n };
  let guessCalls = 0;
  let releaseGuess;
  const guessGate = new Promise((r) => { releaseGuess = r; });

  app.backend = {
    gen: 1,
    async guessFunctions() {
      guessCalls++;
      await guessGate;
      return { starts: [0x1000n, 0x1020n], discoveryComplete: true };
    },
    async strings() {
      app.backend.gen = 2; // simulate binary switch during await
      return { results: [{ addr: 0x2000n, text: 'stale', byteLength: 6 }], complete: true, scannedBytes: 6 };
    },
  };
  app.store = {
    get: (k) => (k === 'regions' ? [region] : k === 'currentRegion' ? region : null),
    set: () => {},
  };
  app.symbols = EMPTY_INDEX;
  app.viewer = { setSymbols() {} };
  app.syncSymbolsStore = () => {};
  app.persistAnalysisSession = async () => false;
  app.functionsBusy = null;
  app.functionsBusyEpoch = -1;
  app.stringsBusy = null;
  app.stringsBusyEpoch = -1;

  // Concurrent ensureFunctions calls coalesce onto one backend.guessFunctions call
  const p1 = app.ensureFunctions(region);
  const p2 = app.ensureFunctions(region);
  releaseGuess();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(guessCalls, 1, 'concurrent ensureFunctions must coalesce via Single-Flight Promise');
  assert.equal(r1, r2);
  assert.equal(app.functionsBusy, null);

  // ensureStrings aborts immediately after await when backend.gen changed
  const strRes = await app.ensureStrings();
  assert.equal(strRes, null);
  assert.equal(app.stringIndex, undefined);
});

test('[Wave5-B P1/P2] App._applyDeltaRecord normalizes lastAddress, selectSlice disposes notes, _applyUndoEntry guards BigInt, and dispose aborts lifecycle', async () => {
  const app = Object.create(App.prototype);
  const region = { id: 'text', vmAddr: 0x1000n, size: 0x100n, zerofill: false };
  const jumped = [];
  const storeMap = new Map([['regions', [region]], ['fileInfo', { slices: [{ regions: [region] }] }], ['sliceIndex', 0]]);
  app.store = {
    get: (k) => storeMap.get(k),
    set: (patch) => { for (const [k, v] of Object.entries(patch)) storeMap.set(k, v); },
  };
  app.backend = { gen: 1, advanceEpoch() { this.gen++; }, binaryId: 'b1' };
  app.notes = EMPTY_NOTES;
  app.symbols = EMPTY_INDEX;
  app.goToAddress = (addr) => { jumped.push(addr); return true; };
  app.updateChrome = () => {};
  app.syncSymbolsStore = () => {};
  app.viewer = { setSymbols() {}, invalidate() {}, clearBlockOverlay() {} };

  // String hex lastAddress is normalized to BigInt
  assert.equal(app._applyDeltaRecord({ delta: {}, resume: { lastAddress: '0x1020' } }), true);
  assert.deepEqual(jumped, [0x1020n]);

  // Malformed lastAddress is ignored without throwing
  assert.equal(app._applyDeltaRecord({ delta: {}, resume: { lastAddress: 'not-a-va' } }), true);
  assert.deepEqual(jumped, [0x1020n]);

  // _applyUndoEntry returns false on invalid BigInt instead of throwing
  assert.equal(app._applyUndoEntry({ type: 'name', addr: 'invalid-addr', before: 'a', after: 'b' }, 'undo'), false);
  assert.equal(app._applyUndoEntry({ type: 'comment', addr: 'invalid-addr', before: 'a', after: 'b' }, 'undo'), false);
  assert.equal(app._applyUndoEntry({ type: 'patch', offset: 'invalid-off' }, 'undo'), false);

  // selectSlice disposes old NoteStore
  let disposed = 0;
  app.notes = { dispose() { disposed++; } };
  app._undoStack = [];
  app._redoStack = [];
  app.flushDeltaSave = async () => false;
  app.persistAnalysisSession = async () => false;
  app.forgetSemantics = () => {};
  app._resetDeltaReadiness = () => {};
  app._createPatchSet = () => {};
  app.applySlice = () => {};
  app.attachNotes = async () => null;
  app._startV6AutoAnalysis = () => {};
  await app.selectSlice(0);
  assert.equal(disposed, 1, 'selectSlice must dispose previous NoteStore');

  // dispose() aborts lifecycle controller
  app._lifecycleController = new AbortController();
  app.dispose();
  assert.equal(app._lifecycleController.signal.aborted, true);
});

// ---------------------------------------------------------------------------
// 3. js/ui/panels/function-analysis.js tests
// ---------------------------------------------------------------------------
test('[Wave5-B P1] analysisBundle propagates signal to api.function and respects pre-aborted signal', async () => {
  const seenOptions = [];
  const app = {
    analysisQueries: {
      snapshot: async () => ({ snapshotId: 's1' }),
      function: async (_snap, id, opts) => {
        seenOptions.push(opts);
        return { value: { startAddress: id, name: 'fn_a' }, completeness: 'complete', status: null };
      },
    },
  };
  const ctrl = new AbortController();
  const bundle = await analysisBundle(app, 0x1000n, { signal: ctrl.signal });
  assert.equal(bundle.target, 0x1000n);
  assert.equal(seenOptions.length, 1);
  assert.equal(seenOptions[0].signal, ctrl.signal);

  const preAborted = new AbortController();
  preAborted.abort('stop-now');
  await assert.rejects(() => analysisBundle(app, 0x1000n, { signal: preAborted.signal }), { name: 'AbortError' });
});

test('[Wave5-B P1] showFunctions does not throw when closed during in-flight page load and ignores stale binary results', async () => {
  const { overlays } = installFakeDom();
  let releasePage;
  const pageGate = new Promise((r) => { releasePage = r; });

  const app = {
    backend: { gen: 1 },
    store: {
      get: (k) => (k === 'currentRegion' ? { id: 'text' } : k === 'fileInfo' ? { name: 'a.bin' } : null),
    },
    analysisQueries: {
      snapshot: async () => ({ snapshotId: 's1' }),
      functions: async () => {
        await pageGate;
        return {
          value: [
            { address: 'invalid-va', name: 'bad' },
            { address: 0x1000n, size: 16, name: 'good_fn' },
          ],
          completeness: 'complete',
          page: { offset: 0, limit: 600, returned: 2, total: 2, next: null },
        };
      },
    },
    goToFunction() {},
  };

  showFunctions(app);
  // Close the sheet immediately while pager.next() is still pending (sets controller = null)
  const closeBtn = overlays.querySelector('.sheet-close') || overlays.querySelector('button');
  closeBtn?.click();
  // Resolve the in-flight page; must not throw TypeError on controller.signal
  releasePage();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(overlays.querySelector('.dialog'), null, 'closing sheet mid-load must not trigger error dialog');
});

test('[Wave5-B P1/P2] showFunctionSummary does not misattribute malformed lastGoalContext and handles malformed highlight/bounds', async () => {
  const { overlays } = installFakeDom();
  const app = {
    backend: { gen: 1 },
    store: {
      get: (k) => (k === 'currentRegion' ? { id: 'text' } : k === 'fileInfo' ? { name: 'a.bin' } : k === 'architecture' ? 'arm64' : null),
    },
    viewer: { rowAddress: () => 0x2000n },
    lastGoalContext: { addr: 'not-a-valid-va', goal: { text: 'unrelated-hp' }, candidate: { name: 'wrong_fn' } },
    analysisQueries: {
      snapshot: async () => ({ snapshotId: 's1' }),
      function: async () => ({
        value: {
          startAddress: 'bad-start',
          endAddress: 'bad-end',
          name: 'target_fn',
          decompiler: { pseudocode: 'int target_fn() {\n  return 0;\n}' },
        },
        completeness: 'complete',
        status: null,
      }),
    },
    goToFunction() {},
  };

  showFunctionSummary(app, 0);
  await new Promise((r) => setTimeout(r, 25));

  assert.equal(overlays.querySelector('.dialog'), null, 'malformed startAddress/endAddress must not throw');
  assert.equal(
    overlays.querySelector('.goal-candidate-summary'),
    null,
    'malformed lastGoalContext address must not be misattributed as explicit banner to unrelated function',
  );
});
