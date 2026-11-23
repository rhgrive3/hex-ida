import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Emulator, EmulatorFault } from '../js/emu-base.js';
import { assemble, decodeArm64PatchWord, PatchSet } from '../js/patch.js';
import { detectLang, setLang, lang, pick } from '../js/i18n.js';
import { PRIMARY_NAV, EXPLORER_SCOPES, FUNCTION_TABS } from '../js/ui/registry.js';
import { installViewerDragReturnGuard } from '../js/ui/viewer-gesture-guard.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

/* ── Minimal DOM shim for unit-testing UI primitives & CodeViewer in Node ── */
function createMiniDom() {
  class MiniClassList {
    constructor(el) { this._el = el; this._set = new Set(); }
    add(...cls) { for (const c of cls) if (c) this._set.add(c); this._sync(); }
    remove(...cls) { for (const c of cls) this._set.delete(c); this._sync(); }
    toggle(c, force) {
      const on = force === undefined ? !this._set.has(c) : !!force;
      if (on) this._set.add(c); else this._set.delete(c);
      this._sync();
      return on;
    }
    contains(c) { return this._set.has(c); }
    _sync() { this._el._className = [...this._set].join(' '); }
    _load(str) {
      this._set = new Set(String(str || '').split(/\s+/).filter(Boolean));
    }
  }

  class MiniElement {
    constructor(tag) {
      this.tagName = String(tag || 'div').toUpperCase();
      this.children = [];
      this.parentElement = null;
      this.parentNode = null;
      this.dataset = {};
      this.attributes = new Map();
      this._listeners = new Map();
      this._className = '';
      this.classList = new MiniClassList(this);
      this.style = {
        _props: new Map(),
        setProperty(k, v) { this._props.set(k, String(v)); },
        getPropertyValue(k) { return this._props.get(k) || ''; },
      };
      this.textContent = '';
      this.title = '';
      this.hidden = false;
      this.tabIndex = -1;
      this.id = '';
      this.lang = '';
      this.scrollTop = 0;
      this.scrollLeft = 0;
      this.clientHeight = 480;
      this.clientWidth = 640;
      this.scrollWidth = 640;
      this.isConnected = true;
    }
    get className() { return this._className; }
    set className(v) { this._className = String(v || ''); this.classList._load(this._className); }
    get childNodes() { return this.children; }
    setAttribute(k, v) {
      this.attributes.set(k, String(v));
      if (k === 'id') this.id = String(v);
      if (k === 'lang') this.lang = String(v);
    }
    getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; }
    removeAttribute(k) { this.attributes.delete(k); if (k === 'lang') this.lang = ''; }
    append(...nodes) {
      for (const n of nodes) {
        if (!n) continue;
        if (n.isFragment) {
          for (const ch of [...n.children]) this.append(ch);
          continue;
        }
        if (typeof n === 'string') continue;
        n.parentElement = this;
        n.parentNode = this;
        this.children.push(n);
      }
    }
    appendChild(n) { this.append(n); return n; }
    prepend(...nodes) {
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i];
        if (!n || typeof n === 'string') continue;
        n.parentElement = this;
        n.parentNode = this;
        this.children.unshift(n);
      }
    }
    after(...nodes) {
      if (!this.parentElement) return;
      const idx = this.parentElement.children.indexOf(this);
      if (idx < 0) return;
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        n.parentElement = this.parentElement;
        n.parentNode = this.parentElement;
        this.parentElement.children.splice(idx + 1 + i, 0, n);
      }
    }
    insertBefore(node, ref) {
      const idx = this.children.indexOf(ref);
      node.parentElement = this;
      node.parentNode = this;
      if (idx < 0) this.children.push(node);
      else this.children.splice(idx, 0, node);
      return node;
    }
    replaceChildren(...nodes) {
      for (const ch of this.children) { ch.parentElement = null; ch.parentNode = null; }
      this.children = [];
      this.append(...nodes);
    }
    remove() {
      this.isConnected = false;
      if (!this.parentElement) return;
      const idx = this.parentElement.children.indexOf(this);
      if (idx >= 0) this.parentElement.children.splice(idx, 1);
      this.parentElement = null;
      this.parentNode = null;
    }
    contains(other) {
      if (other === this) return true;
      for (const c of this.children) if (c.contains?.(other)) return true;
      return false;
    }
    matches(sel) {
      if (!sel) return false;
      if (sel.startsWith('#')) return this.id === sel.slice(1);
      if (sel.startsWith('.')) return this.classList.contains(sel.slice(1));
      const attrMatch = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(sel);
      if (attrMatch) {
        const [, attr, val] = attrMatch;
        if (val === undefined) return this.attributes.has(attr);
        return this.getAttribute(attr) === val;
      }
      const dataMatch = /^\[data-([a-z-]+)="([^"]*)"\]$/.exec(sel);
      if (dataMatch) {
        const key = dataMatch[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        return this.dataset[key] === dataMatch[2];
      }
      return this.tagName.toLowerCase() === sel.toLowerCase();
    }
    closest(sel) {
      let cur = this;
      while (cur) { if (cur.matches?.(sel)) return cur; cur = cur.parentElement; }
      return null;
    }
    querySelectorAll(sel) {
      const out = [];
      const walk = (node) => {
        for (const ch of node.children || []) {
          if (ch.matches?.(sel)) out.push(ch);
          walk(ch);
        }
      };
      walk(this);
      return out;
    }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    addEventListener(type, fn, opts) {
      const signal = opts && typeof opts === 'object' ? opts.signal : null;
      if (signal?.aborted) return;
      if (!this._listeners.has(type)) this._listeners.set(type, []);
      this._listeners.get(type).push(fn);
      if (signal) {
        signal.addEventListener('abort', () => this.removeEventListener(type, fn), { once: true });
      }
    }
    removeEventListener(type, fn) {
      const list = this._listeners.get(type);
      if (!list) return;
      const idx = list.indexOf(fn);
      if (idx >= 0) list.splice(idx, 1);
    }
    dispatchEvent(event) {
      const list = [...(this._listeners.get(event.type) || [])];
      let stopped = false;
      event.stopImmediatePropagation = () => { stopped = true; };
      event.preventDefault = () => {};
      for (const fn of list) {
        if (stopped) break;
        fn(event);
      }
      return true;
    }
    listenerCount(type) { return (this._listeners.get(type) || []).length; }
    getBoundingClientRect() { return { top: 0, left: 0, width: 100, height: 100, bottom: 100, right: 100 }; }
    setPointerCapture() {}
    focus() {}
    blur() {}
  }

  const documentElement = new MiniElement('html');
  const body = new MiniElement('body');
  const sheets = new MiniElement('div');
  sheets.id = 'overlays';
  const toasts = new MiniElement('div');
  toasts.id = 'toasts';
  body.append(sheets, toasts);
  documentElement.append(body);
  const doc = {
    documentElement,
    body,
    activeElement: null,
    title: '',
    _listeners: new Map(),
    createElement: (tag) => new MiniElement(tag),
    createTextNode: (t) => ({ nodeValue: String(t), textContent: String(t) }),
    createDocumentFragment: () => {
      const f = new MiniElement('#fragment');
      f.isFragment = true;
      return f;
    },
    getElementById: (id) => documentElement.querySelector('#' + id),
    querySelector: (sel) => documentElement.querySelector(sel),
    querySelectorAll: (sel) => documentElement.querySelectorAll(sel),
    addEventListener(type, fn) {
      if (!this._listeners.has(type)) this._listeners.set(type, []);
      this._listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = this._listeners.get(type);
      if (!list) return;
      const idx = list.indexOf(fn);
      if (idx >= 0) list.splice(idx, 1);
    },
    dispatchEvent(event) {
      const list = [...(this._listeners.get(event.type) || [])];
      for (const fn of list) fn(event);
      return true;
    },
  };
  return { MiniElement, document: doc };
}

function withMiniDom(fn) {
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const prevNav = globalThis.navigator;
  const prevRaf = globalThis.requestAnimationFrame;
  const prevCaf = globalThis.cancelAnimationFrame;
  const prevGetComputed = globalThis.getComputedStyle;
  const dom = createMiniDom();
  const winListeners = new Map();
  globalThis.document = dom.document;
  globalThis.window = {
    innerWidth: 1024,
    innerHeight: 768,
    location: { pathname: '/', search: '', hash: '', href: 'http://localhost/' },
    history: { pushState() {}, replaceState() {}, back() {} },
    addEventListener(type, fn) {
      if (!winListeners.has(type)) winListeners.set(type, []);
      winListeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = winListeners.get(type);
      if (!list) return;
      const idx = list.indexOf(fn);
      if (idx >= 0) list.splice(idx, 1);
    },
    _listenerCount(type) { return (winListeners.get(type) || []).length; },
  };
  if (typeof globalThis.navigator === 'undefined') {
    Object.defineProperty(globalThis, 'navigator', { value: { language: 'ja-JP', languages: ['ja-JP'] }, configurable: true });
  }
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '24' });
  const restore = () => {
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
    if (prevNav === undefined) delete globalThis.navigator;
    else Object.defineProperty(globalThis, 'navigator', { value: prevNav, configurable: true });
    globalThis.requestAnimationFrame = prevRaf;
    globalThis.cancelAnimationFrame = prevCaf;
    globalThis.getComputedStyle = prevGetComputed;
  };
  try {
    const res = fn(dom);
    if (res && typeof res.then === 'function') return res.finally(restore);
    restore();
    return res;
  } catch (err) {
    restore();
    throw err;
  }
}

/* ── [T9-P1-1] Patch menu conduit & list refresh ── */
test('[T9-P1-1] showPatches & showPatchEditor enforce capability.supported === true and invoke onChange on commit and undo', async () => {
  const toolsSrc = fs.readFileSync(path.join(REPO_ROOT, 'js/tools-base.js'), 'utf8');
  const productSrc = fs.readFileSync(path.join(REPO_ROOT, 'js/ui/product-base.js'), 'utf8');
  assert.match(toolsSrc, /export function showPatches\(app,\s*targetAddr\s*=\s*null\)/);
  assert.match(toolsSrc, /if \(capability\.supported === true\)/);
  assert.match(toolsSrc, /if \(capability\.supported !== true\)/);
  assert.match(toolsSrc, /showPatchEditor\(app,\s*addr,\s*insn,\s*\{\s*onChange:\s*render\s*\}\)/);
  assert.match(productSrc, /showPatches\(app,\s*addr\)/);

  await withMiniDom(async () => {
    setLang('ja');
    const { showPatchEditor } = await import('../js/tools-base.js');
    const region = { id: 'text', name: '__text', vmAddr: 0x1000n, size: 0x100n, fileOffset: 0n, exec: true };
    const state = { architecture: 'arm64', sliceIndex: 0, file: { size: 0x200 }, patches: 0 };
    const patches = new PatchSet();
    const app = {
      backend: {
        gen: 1,
        readAt: async () => ({ found: true, bytes: new Uint8Array([0x00, 0x00, 0x80, 0x52]) }),
      },
      store: {
        get: (k) => state[k],
        set: (p) => Object.assign(state, p),
      },
      executableRegionFor: () => region,
      patches,
      symbols: { functionAt: () => ({ start: 0x1000n, end: 0x1040n }) },
    };

    let changeCount = 0;
    await showPatchEditor(app, 0x1000n, { mnemonic: 'mov', operands: 'w0, #0', address: 0x1000n }, {
      onChange: () => { changeCount++; },
    });
    // Trigger the first suggested patch (nop) in the rendered sheet
    const rows = globalThis.document.body.querySelectorAll('.tappable');
    assert.ok(rows.length > 0, 'patch suggestions should render');
    rows[0].dispatchEvent({ type: 'click' });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(patches.size, 1, 'patch should be staged on commit');
    assert.equal(state.patches, 1, 'store patches count should update');
    assert.equal(changeCount, 1, 'onChange should be invoked on commit');

    // Reopen editor on the patched address and click Undo
    await showPatchEditor(app, 0x1000n, { mnemonic: 'mov', operands: 'w0, #0', address: 0x1000n }, {
      onChange: () => { changeCount++; },
    });
    const undoBtn = globalThis.document.body.querySelectorAll('button')
      .find((b) => /Undo|元に戻す/.test(b.textContent));
    assert.ok(undoBtn, 'Undo button should render for active patch');
    undoBtn.dispatchEvent({ type: 'click' });
    assert.equal(patches.size, 0, 'patch should be removed on Undo');
    assert.equal(state.patches, 0, 'store patches count should reset to 0');
    assert.equal(changeCount, 2, 'onChange should be invoked on Undo');

    // Dynamic verification of showPatches(app, targetAddr) direct-edit button + refresh
    const { showPatches } = await import('../js/tools-base.js');
    showPatches(app, 0x1000n);
    const directBtn = globalThis.document.body.querySelectorAll('button')
      .find((b) => /書き換える|Patch/.test(b.textContent));
    assert.ok(directBtn, 'showPatches(app, targetAddr) must render direct edit button');
    directBtn.dispatchEvent({ type: 'click' });
    await new Promise((r) => setTimeout(r, 15));
    const sheetRows = globalThis.document.body.querySelectorAll('.tappable');
    assert.ok(sheetRows.length > 0, 'direct edit button must open patch editor');
  });
});

/* ── [T9-P1-2] Emulator.branchTarget(ops, expectedIndex) & _recordConditionalBranch ── */
test('[T9-P1-2] Emulator.branchTarget validates expectedIndex and never falls back to bit index or tested register', async () => {
  const insns = new Map([
    [0x1000n, { mn: 'tbz', ops: 'x0, #3' }],       // malformed: missing 3rd operand target
    [0x1004n, { mn: 'cbz', ops: 'x0' }],           // malformed: missing 2nd operand target
    [0x1008n, { mn: 'tbz', ops: 'x0, #3, #0x2000' }],
    [0x2000n, { mn: 'ret', ops: '' }],
  ]);
  const makeEmu = (startPc) => {
    const e = new Emulator({
      fetch: async (addr) => insns.get(addr) || null,
      isExecutable: () => true,
    });
    e.setup(startPc, []);
    return e;
  };

  const emu1 = makeEmu(0x1000n);
  emu1.x[0] = 0n;
  // Direct unit check on branchTarget
  assert.equal(emu1.branchTarget([{ k: 'reg', text: 'x0' }, { k: 'imm', value: 3n }], 2), null);
  assert.equal(emu1.branchTarget([{ k: 'reg', text: 'x0' }], 1), null);
  assert.equal(emu1.branchTarget([{ k: 'reg', text: 'x0' }], 0), null);
  assert.equal(emu1.branchTarget([{ k: 'reg', text: 'x0' }, { k: 'imm', value: 3n }, { k: 'imm', value: 0x2000n }], 2), 0x2000n);

  // Executing malformed tbz must fault with unknown-branch-target (not jump to 0x3)
  const step1 = await emu1.step();
  assert.equal(step1.ok, false);
  assert.equal(step1.code, 'unknown-branch-target');
  assert.equal(emu1.stopCode, 'unknown-branch-target');
  assert.notEqual(emu1.pc, 3n);

  // Executing malformed cbz must fault with unknown-branch-target (not jump to x0)
  const emu2 = makeEmu(0x1004n);
  emu2.x[0] = 0n;
  const step2 = await emu2.step();
  assert.equal(step2.ok, false);
  assert.equal(step2.code, 'unknown-branch-target');
  assert.equal(emu2.stopCode, 'unknown-branch-target');

  // Valid tbz records conditional branch target cleanly
  const emu3 = makeEmu(0x1008n);
  emu3.x[0] = 0n;
  const step3 = await emu3.step();
  assert.equal(step3.ok, true);
  assert.equal(emu3.pc, 0x2000n);
  assert.deepEqual(emu3.trace[0].branch, { conditional: true, taken: true, target: 0x2000n });
});

/* ── [T9-P1-3] English mode i18n & hex:language-changed ── */
test('[T9-P1-3] English mode labels in registry, primitives, and address bar update on language change', async () => {
  for (const item of PRIMARY_NAV) assert.ok(item.labelEn, `PRIMARY_NAV ${item.routeId} needs labelEn`);
  for (const item of EXPLORER_SCOPES) assert.ok(item.labelEn, `EXPLORER_SCOPES ${item.id} needs labelEn`);
  for (const item of FUNCTION_TABS) assert.ok(item.labelEn, `FUNCTION_TABS ${item.id} needs labelEn`);

  await withMiniDom(async () => {
    const { loadingState, evidenceBadge, tabs } = await import('../js/ui/primitives.js');
    setLang('en');
    const loadEl = loadingState();
    assert.equal(loadEl.children[1].textContent, 'Loading…');

    const badgeEl = evidenceBadge('confirmed');
    assert.equal(badgeEl.textContent, 'Confirmed');

    const tabBar = tabs(FUNCTION_TABS, 'overview', () => {});
    const labels = tabBar.children.map((b) => b.textContent);
    assert.deepEqual(labels, ['Overview', 'Pseudo-C', 'Flow', 'Calls', 'Evidence', 'Runtime']);

    setLang('ja');
    assert.equal(evidenceBadge('confirmed').textContent, '確認済み');
    assert.equal(loadingState().children[1].textContent, '読み込み中…');

    // Dynamic verification of tools-base.js showPatchEditor EN strings
    setLang('en');
    const { showPatchEditor } = await import('../js/tools-base.js');
    const enRegion = { id: 'text', name: '__text', vmAddr: 0x1000n, size: 0x100n, fileOffset: 0n, exec: true };
    const enState = { architecture: 'arm64', sliceIndex: 0, file: { size: 0x200 }, patches: 0 };
    const enPatches = new PatchSet();
    await showPatchEditor({
      backend: { gen: 1, readAt: async () => ({ found: true, bytes: new Uint8Array([0, 0, 0x80, 0x52]) }) },
      store: { get: (k) => enState[k], set: (p) => Object.assign(enState, p) },
      executableRegionFor: () => enRegion,
      patches: enPatches,
      symbols: { functionAt: () => null },
    }, 0x1000n, { mnemonic: 'mov', operands: 'w0, #0', address: 0x1000n });
    const collectText = (n) => (n.textContent || "") + (n.children || []).map(collectText).join(" ");
    const bodyText = collectText(globalThis.document.body);
    assert.ok(!bodyText.includes('ファイルの中では'), 'EN patch editor must not leak Japanese file offset label');
    assert.ok(bodyText.includes('Current instruction'), 'EN patch editor must render English current instruction heading');
    setLang('ja');
  });

  // Dynamic verification of ProductRouter._render on hex:language-changed for non-code routes
  await withMiniDom(async ({ MiniElement }) => {
    const prevHistory = globalThis.history;
    globalThis.history = { state: null, replaceState() {}, pushState() {} };
    try {
    const { ProductRouter } = await import('../js/ui/router.js');
    let renderCount = 0;
    const outlet = new MiniElement('div');
    const r = new ProductRouter([
      { id: 'investigate', pattern: '/investigate' },
    ], { defaultPath: '/investigate', onRoute: () => { renderCount++; return { dispose() {} }; } });
    r.start();
    assert.equal(renderCount, 1);
    assert.equal(r.navigate('/investigate', { replace: true }), false, 'navigate() short-circuits same path');
    assert.equal(r._render(r.current.fullPath, { replace: true, restoredState: null }), true, '_render(fullPath) forces re-render on language change');
    assert.equal(renderCount, 2);
    r.stop();
    } finally {
      if (prevHistory === undefined) delete globalThis.history;
      else globalThis.history = prevHistory;
    }
  });

  // Verify app.js dispatches hex:language-changed and product-base.js handles !addrbar + refreshLanguage
  const appSrc = fs.readFileSync(path.join(REPO_ROOT, 'js/app.js'), 'utf8');
  assert.match(appSrc, /new CustomEvent\('hex:language-changed'/);
  const productSrc = fs.readFileSync(path.join(REPO_ROOT, 'js/ui/product-base.js'), 'utf8');
  assert.match(productSrc, /if \(!addrbar\) return \{ refreshLanguage\(\) \{\}, destroy\(\) \{\} \};/);
  assert.match(productSrc, /document\.addEventListener\('hex:language-changed',\s*onLanguageChanged\)/);
  assert.match(productSrc, /document\.removeEventListener\('hex:language-changed',\s*onLanguageChanged\)/);
});

/* ── [T9-P1-4] CodeViewer.dispose() AbortController & long-press timer cleanup ── */
test('[T9-P1-4] CodeViewer.dispose aborts all viewport/scrubber listeners and clears active long-press timer', async () => {
  await withMiniDom(async ({ MiniElement }) => {
    const { CodeViewer } = await import('../js/viewer.js');
    const vp = new MiniElement('div');
    const rowsEl = new MiniElement('div');
    vp.append(rowsEl);
    const track = new MiniElement('div');
    const thumb = new MiniElement('div');
    let longPressCalls = 0;
    const viewer = new CodeViewer({
      viewport: vp,
      rows: rowsEl,
      backend: { fetchChunk: async () => null },
      onLongPress: () => { longPressCalls++; },
    });
    viewer.totalRows = 10;
    viewer.attachScrubber(track, thumb);

    assert.ok(vp.listenerCount('scroll') >= 1);
    assert.ok(vp.listenerCount('pointerdown') >= 1);
    assert.ok(track.listenerCount('pointerdown') >= 1);

    // Start a long-press gesture on row 0, then dispose before 500ms
    const rowEl = new MiniElement('div');
    rowEl.className = 'row';
    rowEl._row = 0;
    vp.dispatchEvent({ type: 'pointerdown', pointerType: 'touch', button: 0, pointerId: 1, clientX: 10, clientY: 10, target: rowEl });

    viewer.dispose();

    assert.equal(vp.listenerCount('scroll'), 0, 'scroll listener must be removed on dispose');
    assert.equal(vp.listenerCount('pointerdown'), 0, 'pointerdown listener must be removed on dispose');
    assert.equal(vp.listenerCount('pointermove'), 0, 'pointermove listener must be removed on dispose');
    assert.equal(vp.listenerCount('pointerup'), 0, 'pointerup listener must be removed on dispose');
    assert.equal(vp.listenerCount('pointercancel'), 0, 'pointercancel listener must be removed on dispose');
    assert.equal(vp.listenerCount('contextmenu'), 0, 'contextmenu listener must be removed on dispose');
    assert.equal(track.listenerCount('pointerdown'), 0, 'scrubber pointerdown must be removed on dispose');
    assert.equal(track.listenerCount('pointermove'), 0, 'scrubber pointermove must be removed on dispose');

    await new Promise((r) => setTimeout(r, 550));
    assert.equal(longPressCalls, 0, 'long-press timer must not fire after dispose');
  });
});

/* ── [T9-P1-5] Epoch/sliceIndex guards & patches reset ── */
test('[T9-P1-5] selectSlice resets patches and async tools/panels bail on epoch or sliceIndex change', async () => {
  const appSrc = fs.readFileSync(path.join(REPO_ROOT, 'js/app.js'), 'utf8');
  const selectSliceBlock = appSrc.slice(appSrc.indexOf('async selectSlice(index)'), appSrc.indexOf('async exportProjectFile()'));
  assert.match(selectSliceBlock, /this\.patches\s*=\s*new PatchSet\(\)/, 'selectSlice must reset patches');
  assert.match(selectSliceBlock, /this\.store\.set\(\{\s*patches:\s*0\s*\}\)/, 'selectSlice must reset store patches count');

  const panelsSrc = fs.readFileSync(path.join(REPO_ROOT, 'js/panels-base.js'), 'utf8');
  assert.match(panelsSrc, /sliceIndex === app\.store\?\.get\?\.\('sliceIndex'\)/);
  assert.match(panelsSrc, /reportSlice === app\.store\?\.get\?\.\('sliceIndex'\)/);

  // Runtime test: modelOf returns null if sliceIndex changes mid-flight
  const { modelOf } = await import('../js/tools-base.js');
  const state = { currentRegion: { id: 'r0', exec: true }, sliceIndex: 0 };
  let addedFunctions = false;
  const app = {
    backend: {
      gen: 1,
      guessFunctions: async () => {
        state.sliceIndex = 1; // slice switched while awaiting!
        return { starts: [0x1000n] };
      },
    },
    store: { get: (k) => state[k] },
    executableRegionFor: () => state.currentRegion,
    symbols: {
      functionAt: () => null,
      addFunctions: () => { addedFunctions = true; },
    },
    analyzeFunctionAt: async () => ({ model: {} }),
  };
  const res = await modelOf(app, 0x1000n);
  assert.equal(res, null, 'modelOf must return null after sliceIndex change');
  assert.equal(addedFunctions, false, 'stale guessFunctions must not mutate symbols');
});

/* ── [T9-P2-1] product-base.js matchMedia / pagehide cleanup ── */
test('[T9-P2-1] product-base.js cleans up matchMedia and pagehide listeners in destroy()', () => {
  const productSrc = fs.readFileSync(path.join(REPO_ROOT, 'js/ui/product-base.js'), 'utf8');
  assert.match(productSrc, /narrow\?\.removeEventListener\?\.\('change',\s*setPlaceholder\)/);
  assert.match(productSrc, /window\.addEventListener\('pagehide',\s*onPageHide/);
  assert.match(productSrc, /window\.removeEventListener\('pagehide',\s*onPageHide\)/);
});

/* ── [T9-P2-2] viewer-gesture-guard.js cleanup & multi-touch ── */
test('[T9-P2-2] installViewerDragReturnGuard cleans up on dispose and handles secondary pointers', () => {
  const dom = createMiniDom();
  const vp = new dom.MiniElement('div');
  const row = new dom.MiniElement('div');
  row.className = 'row';
  row._row = 2;
  const viewer = { vp };
  assert.equal(installViewerDragReturnGuard(viewer), true);
  assert.equal(vp.listenerCount('pointerdown'), 1);

  // Secondary finger cancels tap semantics
  let upReached = false;
  vp.addEventListener('pointerup', () => { upReached = true; });
  vp.dispatchEvent({ type: 'pointerdown', pointerType: 'touch', isPrimary: true, pointerId: 1, clientX: 50, clientY: 50, target: row });
  vp.dispatchEvent({ type: 'pointerdown', pointerType: 'touch', isPrimary: false, pointerId: 2, clientX: 80, clientY: 80, target: row });
  vp.dispatchEvent({ type: 'pointerup', pointerType: 'touch', isPrimary: true, pointerId: 1, clientX: 50, clientY: 50, target: row });
  assert.equal(upReached, false, 'multi-touch secondary pointer must suppress tap on primary pointerup');

  viewer.__disposeDragReturnGuard();
  assert.equal(vp.listenerCount('pointerdown'), 0, 'guard pointerdown must be removed on dispose');
  assert.equal(vp.listenerCount('pointermove'), 0, 'guard pointermove must be removed on dispose');
  assert.equal(vp.listenerCount('pointercancel'), 0, 'guard pointercancel must be removed on dispose');
});

/* ── [T9-P2-3] primitives.js tabPanel null guard ── */
test('[T9-P2-3] tabPanel handles null tabbar or missing selected tab without throwing', async () => {
  await withMiniDom(async ({ MiniElement }) => {
    const { tabPanel } = await import('../js/ui/primitives.js');
    const p1 = tabPanel(null, 'ui-workspace-content');
    assert.equal(p1.getAttribute('role'), 'tabpanel');
    assert.equal(p1.id, '');

    const emptyBar = new MiniElement('div');
    const p2 = tabPanel(emptyBar, 'ui-workspace-content');
    assert.equal(p2.getAttribute('role'), 'tabpanel');
    assert.equal(p2.getAttribute('aria-labelledby'), null);
  });
});

/* ── [T9-P2-4] VirtualList proportional scroll & iPadOS overscroll clamp ── */
test('[T9-P2-4] VirtualList caps spacer height at 1_000_000, scales proportionally, preserves overscan, and clamps overscroll', async () => {
  await withMiniDom(async ({ MiniElement }) => {
    const { VirtualList } = await import('../js/ui/primitives.js');
    const lazy = {
      length: 100_000,
      itemAt: (i) => ({ id: i }),
    };
    const vl = new VirtualList({
      items: lazy,
      rowHeight: 60,
      overscan: 4,
      renderRow: (item) => {
        const el = new MiniElement('div');
        el.textContent = String(item.id);
        return el;
      },
    });
    assert.equal(vl.spacer.style.height, '1000000px');
    assert.equal(vl.root.style.getPropertyValue('--ui-virtual-content'), '1000002px');

    // Scroll to middle: upper overscan should be maintained
    vl.root.clientHeight = 480;
    vl.root.scrollTop = 500_000;
    vl.render();
    const midIndices = vl.window.children.map((c) => Number(c.dataset.virtualIndex));
    assert.ok(midIndices[0] > 40_000 && midIndices[0] < 55_000, `expected middle index, got ${midIndices[0]}`);

    // Scroll to bottom + iPadOS overscroll beyond maxScroll: clamps cleanly to last item
    vl.root.scrollTop = 1_500_000;
    vl.render();
    const bottomIndices = vl.window.children.map((c) => Number(c.dataset.virtualIndex));
    assert.equal(bottomIndices[bottomIndices.length - 1], 99_999, 'bottom scroll must reach final item');

    // Negative iPadOS rubber-band overscroll: clamps cleanly to 0
    vl.root.scrollTop = -150;
    vl.render();
    const topIndices = vl.window.children.map((c) => Number(c.dataset.virtualIndex));
    assert.equal(topIndices[0], 0, 'negative overscroll must clamp to index 0');
    vl.dispose();
  });
});

/* ── [T9-P2-5] patch.js BigInt.asUintN(64, ...) ── */
test('[T9-P2-5] decodeArm64PatchWord wraps 64-bit PC-relative branch targets with BigInt.asUintN(64, ...)', () => {
  // Backward branch by -4 bytes from pc = 0n -> 0xfffffffffffffffc (not -0x4)
  const bBack = 0x17FFFFFF; // b -4
  assert.deepEqual(decodeArm64PatchWord(bBack, 0n), { mn: 'b', ops: '#0xfffffffffffffffc' });

  const beqBack = 0x54FFFFE0; // b.eq -4
  assert.deepEqual(decodeArm64PatchWord(beqBack, 0n), { mn: 'b.eq', ops: '#0xfffffffffffffffc' });

  const cbzBack = 0xB4FFFFE0; // cbz x0, -4
  assert.deepEqual(decodeArm64PatchWord(cbzBack, 0n), { mn: 'cbz', ops: 'x0, #0xfffffffffffffffc' });

  const tbzBack = 0x3607FFE0; // tbz w0, #0, -4
  assert.deepEqual(decodeArm64PatchWord(tbzBack, 0n), { mn: 'tbz', ops: 'w0, #0, #0xfffffffffffffffc' });

  // Forward wrap past 2^64 from 0xfffffffffffffffc + 4 -> 0x0
  const bFwd = 0x14000001; // b +4
  assert.deepEqual(decodeArm64PatchWord(bFwd, 0xfffffffffffffffcn), { mn: 'b', ops: '#0x0' });

  // assemble roundtrip still works
  const built = assemble('b 0x1008', 0x1000n);
  assert.ok(built.bytes && built.bytes.length === 4);
});

/* ── [T9-P2-6] i18n.js detectLang() 'en' fallback ── */
test('[T9-P2-6] detectLang falls back to en for non-Japanese locales', () => {
  const prevNav = globalThis.navigator;
  try {
    Object.defineProperty(globalThis, 'navigator', { value: { languages: ['fr-FR', 'de-DE'], language: 'fr-FR' }, configurable: true });
    assert.equal(detectLang(), 'en');

    Object.defineProperty(globalThis, 'navigator', { value: { languages: ['ja-JP'], language: 'ja-JP' }, configurable: true });
    assert.equal(detectLang(), 'ja');

    Object.defineProperty(globalThis, 'navigator', { value: { languages: ['en-US'], language: 'en-US' }, configurable: true });
    assert.equal(detectLang(), 'en');
  } finally {
    if (prevNav === undefined) delete globalThis.navigator;
    else Object.defineProperty(globalThis, 'navigator', { value: prevNav, configurable: true });
  }
});

/* ── [T9-P2-7] pick(ja, en) 化 ── */
test('[T9-P2-7] pick(ja, en) switches output between ja and en consistently', () => {
  const prev = lang();
  try {
    setLang('ja');
    assert.equal(pick('日本語', 'English'), '日本語');
    setLang('en');
    assert.equal(pick('日本語', 'English'), 'English');
  } finally {
    setLang(prev);
  }
});
