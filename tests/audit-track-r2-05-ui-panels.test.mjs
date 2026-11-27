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
    if (!(target instanceof FakeNode)) {
      throw new TypeError("Failed to execute 'contains' on 'Node': parameter 1 is not of type 'Node'.");
    }
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
        const textNode = new FakeTextNode(item);
        textNode.parentNode = this;
        this.childNodes.push(textNode);
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
  appendChild(node) {
    this.append(node);
    return node;
  }
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
    this.textContent = String(text);
  }
}

class FakeDocumentFragment extends FakeNode {
  constructor() {
    super(11);
  }
}

class FakeClassList {
  constructor(el) {
    this.el = el;
    this.set = new Set();
  }
  _syncFrom(str) {
    this.set = new Set(String(str || '').split(/\s+/).filter(Boolean));
  }
  add(...names) {
    for (const n of names) if (n) this.set.add(n);
    this.el._className = [...this.set].join(' ');
  }
  remove(...names) {
    for (const n of names) this.set.delete(n);
    this.el._className = [...this.set].join(' ');
  }
  toggle(name, force) {
    if (force === true) this.add(name);
    else if (force === false) this.remove(name);
    else if (this.set.has(name)) this.remove(name);
    else this.add(name);
  }
  contains(name) {
    return this.set.has(name);
  }
}

class FakeElement extends FakeNode {
  constructor(tagName) {
    super(1);
    this.tagName = String(tagName || 'div').toUpperCase();
    this._className = '';
    this.classList = new FakeClassList(this);
    this.style = {};
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.value = '';
    this.disabled = false;
    this.type = '';
    this.tabIndex = 0;
    this.scrollTop = 0;
    this._textContent = '';
  }
  get className() {
    return this._className;
  }
  set className(val) {
    this._className = String(val || '');
    this.classList._syncFrom(this._className);
  }
  get textContent() {
    if (this.childNodes.length === 0) return this._textContent;
    return this.childNodes.map((c) => c.textContent).join('');
  }
  set textContent(val) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes.length = 0;
    this._textContent = String(val ?? '');
  }
  setAttribute(k, v) {
    this.attributes.set(k, String(v));
  }
  getAttribute(k) {
    return this.attributes.has(k) ? this.attributes.get(k) : null;
  }
  removeAttribute(k) {
    this.attributes.delete(k);
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) {
    this.listeners.get(type)?.delete(fn);
  }
  dispatchEvent(event) {
    const ev = event || { type: '' };
    if (!('target' in ev)) ev.target = this;
    ev.currentTarget = this;
    ev.preventDefault ||= () => {};
    ev.stopPropagation ||= () => {};
    for (const fn of [...(this.listeners.get(ev.type) || [])]) {
      fn(ev);
    }
  }
  click() {
    if (this.disabled) return;
    this.dispatchEvent({ type: 'click', target: this });
  }
  focus() {
    if (globalThis.document) globalThis.document.activeElement = this;
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 120, height: 80, right: 120, bottom: 80 };
  }
  matches(selector) {
    const s = selector.trim();
    if (s === 'button:not([disabled])') return this.tagName === 'BUTTON' && !this.disabled;
    if (s.startsWith('.')) return this.classList.contains(s.slice(1));
    return this.tagName === s.toUpperCase();
  }
  querySelectorAll(selector) {
    const out = [];
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === 1) {
          if (child.matches(selector)) out.push(child);
          walk(child);
        }
      }
    };
    walk(this);
    return out;
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

class FakeEventTarget {
  constructor() {
    this.listeners = new Map();
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) {
    this.listeners.get(type)?.delete(fn);
  }
  dispatchEvent(event) {
    const ev = event || { type: '' };
    ev.preventDefault ||= () => {};
    ev.stopPropagation ||= () => {};
    for (const fn of [...(this.listeners.get(ev.type) || [])]) {
      fn(ev);
    }
  }
}

function installFakeDom() {
  const docTarget = new FakeEventTarget();
  const body = new FakeElement('body');
  const documentElement = new FakeElement('html');
  documentElement.append(body);
  const overlaysEl = new FakeElement('div');
  overlaysEl.setAttribute('id', 'overlays');
  const sheetHost = new FakeElement('div');
  sheetHost.setAttribute('id', 'sheet-host');
  const toastEl = new FakeElement('div');
  toastEl.setAttribute('id', 'toast');
  body.append(overlaysEl, sheetHost, toastEl);

  const byId = new Map([
    ['overlays', overlaysEl],
    ['sheet-host', sheetHost],
    ['toast', toastEl],
  ]);

  const doc = {
    body,
    documentElement,
    activeElement: body,
    createElement: (tag) => new FakeElement(tag),
    createDocumentFragment: () => new FakeDocumentFragment(),
    getElementById: (id) => byId.get(id) || null,
    querySelector: (sel) => body.querySelector(sel),
    querySelectorAll: (sel) => body.querySelectorAll(sel),
    addEventListener: (t, fn) => docTarget.addEventListener(t, fn),
    removeEventListener: (t, fn) => docTarget.removeEventListener(t, fn),
    dispatchEvent: (ev) => docTarget.dispatchEvent(ev),
  };

  const visualViewport = new FakeEventTarget();
  visualViewport.offsetLeft = 0;
  visualViewport.offsetTop = 0;
  visualViewport.width = 1024;
  visualViewport.height = 768;

  const win = new FakeEventTarget();
  win.innerWidth = 1024;
  win.innerHeight = 768;
  win.visualViewport = visualViewport;
  win.document = doc;
  win.localStorage = {
    _m: new Map(),
    getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
    setItem(k, v) { this._m.set(k, String(v)); },
  };
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

  globalThis.Node = FakeNode;
  globalThis.Element = FakeElement;
  globalThis.document = doc;
  globalThis.window = win;
  globalThis.localStorage = win.localStorage;
  globalThis.requestAnimationFrame = (fn) => { fn(); return 1; };
  globalThis.cancelAnimationFrame = () => {};

  return { doc, win, body, sheetHost, visualViewport };
}

function flushMicrotasks(n = 6) {
  let p = Promise.resolve();
  for (let i = 0; i < n; i++) p = p.then(() => {});
  return p;
}

installFakeDom();

const { menu, closeMenu } = await import('../js/ui.js');
const panelsBase = await import('../js/panels-base.js');
const { showFunctions } = await import('../js/ui/panels/function-analysis.js');
const { showSearch: showCanonicalSearch } = await import('../js/ui/panels/search.js');
const { showSearch: showLegacySearch } = await import('../js/ui/panels/navigation.js');

// ── Bug 1 [P1]: panels-base.js showStructure / showSections / showTools ReferenceError ──
test('Bug 1 [P1]: panels-base.js resolves showTools, showSections, and showStructure without ReferenceError', () => {
  const { body } = installFakeDom();
  const state = new Map([
    ['fileInfo', { name: 'demo.bin', format: 'Mach-O', size: 0x4000n, slices: [] }],
    ['regions', [{ id: 'text', name: '__TEXT,__text', section: '__text', segment: '__TEXT', vmAddr: 0x1000n, fileOff: 0n, size: 0x100n, disasm: true }]],
    ['currentRegion', { id: 'text', name: '__TEXT,__text', section: '__text', segment: '__TEXT', vmAddr: 0x1000n, fileOff: 0n, size: 0x100n, disasm: true }],
    ['architecture', 'arm64'],
    ['selectedRow', 0],
  ]);
  const app = {
    store: {
      get: (k) => state.get(k),
      set: (obj) => { for (const [k, v] of Object.entries(obj)) state.set(k, v); },
    },
    currentSlice: () => ({
      info: {
        filetypeName: 'MH_EXECUTE',
        encrypted: false,
        segments: [],
        sections: [],
        loadCommands: [],
      },
    }),
    codeRegion: () => state.get('currentRegion'),
    symbols: { gen: 1, functionCount: 0, symbolCount: 0, nameAt: () => null, functionAt: () => null },
    fields: null,
    viewer: { rowAddress: () => 0x1000n },
    backend: { onScanProgress: null },
    ensureStrings: () => new Promise(() => {}),
    ensureProgram: () => new Promise(() => {}),
    ensureShapes: () => new Promise(() => {}),
    ensureObjc: () => new Promise(() => {}),
    ensureSwift: () => new Promise(() => {}),
    openSample: () => {},
    setExplain: () => {},
  };

  // 1a. Learning course "ファイルの構造を開いてみる" (action: 'struct') & 'sections'
  panelsBase.showLearn(app);
  // Open each chapter and click any try-action buttons for struct / sections
  const chapterButtons = body.querySelectorAll('.tappable');
  assert.ok(chapterButtons.length > 0, 'learn sheet should list chapters');
  let invokedStructOrSections = 0;
  for (let i = 0; i < chapterButtons.length; i++) {
    panelsBase.showLearn(app);
    const rows = body.querySelectorAll('.tappable');
    rows[i].click();
    const tryButtons = body.querySelectorAll('button').filter((b) =>
      b.textContent.includes('構造') || b.textContent.includes('セクション') ||
      b.textContent.toLowerCase().includes('structure') || b.textContent.toLowerCase().includes('section')
    );
    for (const btn of tryButtons) {
      assert.doesNotThrow(() => btn.click());
      invokedStructOrSections++;
    }
  }
  assert.ok(invokedStructOrSections >= 1, 'should invoke at least one struct/sections try action from learn chapters');

  // 1b. Overview "専門家向けツール" -> showTools & showStructure
  installFakeDom();
  panelsBase.showOverview(app);
  const expertDetails = globalThis.document.body.querySelector('.expert-entry');
  assert.ok(expertDetails, 'expert tools disclosure should exist');
  expertDetails.open = true;
  expertDetails.dispatchEvent({ type: 'toggle' });

  const toolsRow = globalThis.document.body.querySelectorAll('.tappable').find((b) =>
    b.textContent.includes('関数・逆コンパイル・CFG') || b.textContent.includes('Functions, decompiler, and CFG')
  );
  assert.ok(toolsRow, 'showTools row should exist');
  assert.doesNotThrow(() => toolsRow.click(), 'showTools invocation must not throw ReferenceError');

  installFakeDom();
  panelsBase.showOverview(app);
  const expertDetails2 = globalThis.document.body.querySelector('.expert-entry');
  expertDetails2.open = true;
  expertDetails2.dispatchEvent({ type: 'toggle' });
  const structRow = globalThis.document.body.querySelectorAll('.tappable').find((b) =>
    b.textContent.includes('文字列・セクション・構造') || b.textContent.includes('Strings, sections, and structure')
  );
  assert.ok(structRow, 'showStructure row should exist');
  assert.doesNotThrow(() => structRow.click(), 'showStructure invocation must not throw ReferenceError');
});

// ── Bug 2 [P2]: function-analysis.js final page status update ──
test('Bug 2 [P2]: showFunctions updates status text when loading the final page', async () => {
  const { body } = installFakeDom();
  const pages = new Map([
    [0, {
      value: Array.from({ length: 3 }, (_, i) => ({ name: `fn_${i}`, address: 0x1000n + BigInt(i * 4), size: 4n })),
      completeness: 'complete',
      page: { offset: 0, limit: 600, total: 5, next: 3 },
    }],
    [3, {
      value: Array.from({ length: 2 }, (_, i) => ({ name: `fn_${i + 3}`, address: 0x100cn + BigInt(i * 4), size: 4n })),
      completeness: 'partial',
      page: { offset: 3, limit: 600, total: 5, next: null },
    }],
  ]);

  const app = {
    store: { get: (k) => (k === 'currentRegion' ? { id: 'text', name: '__text' } : null) },
    analysisQueries: {
      snapshot: async () => ({ id: 'snap-1' }),
      functions: async (_snap, _filter, { offset }) => pages.get(offset),
    },
    goToFunction: () => {},
  };

  showFunctions(app);
  await flushMicrotasks(10);

  const status = body.querySelector('.hint');
  assert.ok(status, 'status element should exist');
  assert.equal(status.textContent, '5 個中 3 個を表示 · 完全');

  const rows = body.querySelectorAll('.tappable');
  const moreBtn = rows[rows.length - 1];
  assert.ok(moreBtn, 'more button should exist after first page');
  moreBtn.click();
  await flushMicrotasks(10);

  assert.equal(status.textContent, '5 個中 5 個を表示 · 一部',
    'final page load must update status count and completeness even when hasMore becomes false');
});

// ── Bug 3 [P2]: search.js variable-length instruction row jump ──
test('Bug 3 [P2]: showSearch jumps by address in variable-length instruction mode instead of mismatched item.row', async () => {
  const { body } = installFakeDom();
  const state = new Map([
    ['currentRegion', { id: 'text', name: '.text', vmAddr: 0x1000n, size: 0x200n }],
    ['searchKind', 'asm'],
    ['searchQuery', 'mov'],
  ]);
  const calls = {
    goToAddress: [],
    goToRow: [],
    mark: [],
    select: [],
    selectedRows: [],
  };

  const app = {
    store: {
      get: (k) => state.get(k),
      set: (obj) => {
        for (const [k, v] of Object.entries(obj)) state.set(k, v);
        if ('selectedRow' in obj) calls.selectedRows.push(obj.selectedRow);
      },
    },
    goToAddress(addr, opts) {
      calls.goToAddress.push({ addr, opts });
      return true;
    },
    viewer: {
      isVariableAsm: () => true,
      rowOfAddress: (addr) => (addr === 0x1003n ? 7 : null),
      goToRow: (row, where) => calls.goToRow.push({ row, where }),
      mark: (row) => calls.mark.push(row),
      select: (row, extend) => calls.select.push({ row, extend }),
    },
    analysisQueries: {
      snapshot: async () => ({ id: 'snap-var' }),
      search: async () => ({
        value: [
          { addr: 0x1003n, row: 999, text: 'mov eax, 1' },
          { addr: 0x1055n, row: 888, text: 'mov ebx, 2' },
        ],
        completeness: 'complete',
        page: { next: null },
      }),
    },
  };

  showCanonicalSearch(app);
  const input = body.querySelector('input');
  input.value = 'mov';
  input.dispatchEvent({ type: 'keydown', key: 'Enter' });
  await flushMicrotasks(10);

  const resultRows = body.querySelectorAll('.tappable');
  assert.equal(resultRows.length, 2);

  // Tap first result (address already decoded at variable row 7, NOT item.row 999)
  resultRows[0].click();
  assert.deepEqual(calls.goToAddress, [{ addr: 0x1003n, opts: { announce: true } }]);
  assert.equal(calls.goToRow.length, 0, 'variable-length mode must not jump directly via item.row');
  assert.deepEqual(calls.mark, [7]);
  assert.deepEqual(calls.select, [{ row: 7, extend: false }]);
  assert.deepEqual(calls.selectedRows, [7]);

  // Tap second result (address not yet decoded -> rowOfAddress returns null; must not fall back to item.row 888)
  resultRows[1].click();
  assert.equal(calls.goToAddress.length, 2);
  assert.equal(calls.goToAddress[1].addr, 0x1055n);
  assert.equal(calls.goToRow.length, 0);
  assert.deepEqual(calls.mark, [7], 'must not mark stale item.row when variable row is pending');
});

// ── Bug 4 [P2]: ui.js armMenuDismiss non-Node target .contains() TypeError ──
test('Bug 4 [P2]: armMenuDismiss ignores non-Node targets without throwing TypeError in contains()', () => {
  const { doc, win, body, visualViewport } = installFakeDom();
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    menu([{ label: 'Copy', action() {} }], 40, 40);
    const menuEl = body.querySelector('.menu');
    assert.ok(menuEl, 'menu should be mounted');

    // Inside grace window (< 50ms): non-Node resize/scroll targets must not throw TypeError
    assert.doesNotThrow(() => {
      win.dispatchEvent({ type: 'resize', target: win });
      visualViewport.dispatchEvent({ type: 'scroll', target: visualViewport });
      doc.dispatchEvent({ type: 'pointerdown', target: win, cancelable: true });
    });
    assert.ok(menuEl.isConnected, 'menu stays open during 50ms grace window');

    // Clicking an actual child Node inside menu must not close it even after 50ms
    now += 100;
    const childBtn = menuEl.querySelector('button');
    assert.doesNotThrow(() => {
      doc.dispatchEvent({ type: 'pointerdown', target: childBtn, cancelable: true });
    });
    assert.ok(menuEl.isConnected, 'pointerdown inside menu keeps menu open');

    // Non-Node resize event after grace window closes menu cleanly without TypeError
    assert.doesNotThrow(() => {
      win.dispatchEvent({ type: 'resize', target: win });
    });
    assert.equal(menuEl.isConnected, false, 'menu should close on window resize after grace window');

    // Also verify non-Node pointerdown after grace window closes menu cleanly
    menu([{ label: 'Copy', action() {} }], 40, 40);
    const menuEl2 = body.querySelector('.menu');
    now += 100;
    assert.doesNotThrow(() => {
      doc.dispatchEvent({ type: 'pointerdown', target: { notANode: true }, cancelable: true });
    });
    assert.equal(menuEl2.isConnected, false, 'menu should close on non-Node outside pointerdown');
  } finally {
    closeMenu();
    Date.now = realNow;
  }
});

// ── Bug 5 [P2]: panels-base.js app.codeRegion() === null crash ──
test('Bug 5 [P2]: showCandidates handles null app.codeRegion() in error fallback without crashing', async () => {
  const { body } = installFakeDom();
  const origError = console.error;
  console.error = () => {};
  try {
    // Case A: codeRegion() is already null when prepare fails
    const appNull = {
      store: { get: () => null },
      codeRegion: () => null,
      ensureStrings: () => Promise.reject(new Error('prepare failed')),
      ensureProgram: () => Promise.resolve(null),
      ensureShapes: () => Promise.resolve(null),
      goToAddress: () => { throw new Error('should not be called'); },
    };
    panelsBase.showCandidates(appNull, { id: 'money', title: 'お金', text: 'money' });
    await flushMicrotasks(10);
    const failureBox = body.querySelector('.beginner-empty');
    assert.ok(failureBox, 'failure fallback box should render even when codeRegion() is null');
    assert.equal(failureBox.querySelector('button'), null, 'no broken disassembly jump button when codeRegion() is null');

    // Case B: codeRegion() becomes null between render and user clicking onAction
    installFakeDom();
    let currentCode = { id: 'text', vmAddr: 0x1000n, size: 0x100n };
    let jumped = 0;
    const appBecomesNull = {
      store: { get: () => null },
      codeRegion: () => currentCode,
      ensureStrings: () => Promise.reject(new Error('prepare failed')),
      ensureProgram: () => Promise.resolve(null),
      ensureShapes: () => Promise.resolve(null),
      goToAddress: () => { jumped++; return true; },
    };
    panelsBase.showCandidates(appBecomesNull, { id: 'money', title: 'お金', text: 'money' });
    await flushMicrotasks(10);
    const actionBtn = globalThis.document.body.querySelector('.beginner-empty')?.querySelector('button');
    assert.ok(actionBtn, 'action button should render when codeRegion() is initially available');
    currentCode = null;
    assert.doesNotThrow(() => actionBtn.click(), 'clicking action after codeRegion() turns null must not crash');
    assert.equal(jumped, 0);
  } finally {
    console.error = origError;
  }
});

// ── Bug 6 [P2]: ui/panels/navigation.js async search race condition ──
test('Bug 6 [P2]: navigation.js showSearch ignores stale search progress/results/errors', async () => {
  const { body } = installFakeDom();
  const state = new Map([
    ['currentRegion', { id: 'text', name: '__text', vmAddr: 0x1000n, size: 0x200n }],
    ['searchKind', 'asm'],
    ['searchQuery', ''],
  ]);

  const requests = [];
  const cancelledIds = [];
  const app = {
    store: {
      get: (k) => state.get(k),
      set: (obj) => { for (const [k, v] of Object.entries(obj)) state.set(k, v); },
    },
    backend: {
      search(params, onProgress) {
        let resolve;
        let reject;
        const p = new Promise((res, rej) => { resolve = res; reject = rej; });
        p.id = requests.length + 1;
        requests.push({ params, onProgress, resolve, reject, promise: p });
        return p;
      },
      cancelSearch(req) {
        cancelledIds.push(req?.id);
      },
    },
    viewer: { goToRow() {}, mark() {}, select() {} },
    goToAddress() { return true; },
  };

  showLegacySearch(app);
  const input = body.querySelector('input');
  const status = body.querySelector('.hint');

  // Start Search 1
  input.value = 'old_query';
  input.dispatchEvent({ type: 'keydown', key: 'Enter' });
  assert.equal(requests.length, 1);

  // Start Search 2 before Search 1 resolves
  input.value = 'new_query';
  input.dispatchEvent({ type: 'keydown', key: 'Enter' });
  assert.equal(requests.length, 2);
  assert.deepEqual(cancelledIds, [1]);

  // Search 2 completes first
  requests[1].resolve({
    cancelled: false,
    capped: false,
    results: [{ addr: 0x2000n, row: 2, text: 'NEW_RESULT_ONLY' }],
  });
  await flushMicrotasks(8);

  assert.ok(body.textContent.includes('NEW_RESULT_ONLY'));
  const statusAfterNew = status.textContent;

  // Now Search 1 emits late progress and late stale results
  requests[0].onProgress({ done: 50, all: 100, hits: 99 });
  requests[0].resolve({
    cancelled: false,
    capped: false,
    results: [{ addr: 0x1000n, row: 1, text: 'STALE_OLD_RESULT' }],
  });
  await flushMicrotasks(8);

  assert.ok(body.textContent.includes('NEW_RESULT_ONLY'), 'newer search results must remain displayed');
  assert.equal(body.textContent.includes('STALE_OLD_RESULT'), false, 'stale search results must not overwrite newer results');
  assert.equal(status.textContent, statusAfterNew, 'stale search must not overwrite status');

  // Start Search 3, then stop it; late rejection/resolution must not overwrite stopped UI or show alert
  input.value = 'third_query';
  input.dispatchEvent({ type: 'keydown', key: 'Enter' });
  assert.equal(requests.length, 3);
  const goBtn = body.querySelector('.field').querySelector('button');
  goBtn.click(); // stop
  const stoppedStatus = status.textContent;
  requests[2].reject(new Error('late network error'));
  await flushMicrotasks(8);
  assert.equal(status.textContent, stoppedStatus, 'late error after stop must not overwrite stopped status');
});
