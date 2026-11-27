import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Emulator } from '../js/emu-base.js';
import { setLang, lang } from '../js/i18n.js';
import { installDyldRuntimeNavigation } from '../js/ui/dyld-runtime-navigation.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

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
    _load(str) { this._set = new Set(String(str || '').split(/\s+/).filter(Boolean)); }
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
      this.disabled = false;
      this.value = '';
      this.tabIndex = -1;
      this.id = '';
      this.scrollTop = 0;
      this.clientHeight = 480;
      this.isConnected = true;
    }
    get className() { return this._className; }
    set className(v) { this._className = String(v || ''); this.classList._load(this._className); }
    get childNodes() { return this.children; }
    setAttribute(k, v) {
      this.attributes.set(k, String(v));
      if (k === 'id') this.id = String(v);
    }
    getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; }
    removeAttribute(k) { this.attributes.delete(k); }
    append(...nodes) {
      for (const n of nodes) {
        if (!n || typeof n === 'string') continue;
        if (n.isFragment) { for (const ch of [...n.children]) this.append(ch); continue; }
        n.parentElement = this;
        n.parentNode = this;
        n.isConnected = true;
        this.children.push(n);
      }
    }
    appendChild(n) { this.append(n); return n; }
    insertBefore(node, ref) {
      const idx = this.children.indexOf(ref);
      node.parentElement = this;
      node.parentNode = this;
      node.isConnected = true;
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
    matches(sel) {
      if (!sel) return false;
      if (sel.startsWith('#')) return this.id === sel.slice(1);
      if (sel.startsWith('.')) return this.classList.contains(sel.slice(1));
      return this.tagName.toLowerCase() === sel.toLowerCase();
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
      if (signal) signal.addEventListener('abort', () => this.removeEventListener(type, fn), { once: true });
    }
    removeEventListener(type, fn) {
      const list = this._listeners.get(type);
      if (!list) return;
      const idx = list.indexOf(fn);
      if (idx >= 0) list.splice(idx, 1);
    }
    dispatchEvent(event) {
      for (const fn of [...(this._listeners.get(event.type) || [])]) fn(event);
      return true;
    }
    listenerCount(type) { return (this._listeners.get(type) || []).length; }
    focus() {}
    blur() {}
  }

  const documentElement = new MiniElement('html');
  const body = new MiniElement('body');
  const overlays = new MiniElement('div');
  overlays.id = 'overlays';
  const toasts = new MiniElement('div');
  toasts.id = 'toasts';
  body.append(overlays, toasts);
  documentElement.append(body);
  const docListeners = new Map();
  const doc = {
    documentElement,
    body,
    activeElement: null,
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
      if (!docListeners.has(type)) docListeners.set(type, []);
      docListeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = docListeners.get(type);
      if (!list) return;
      const idx = list.indexOf(fn);
      if (idx >= 0) list.splice(idx, 1);
    },
    dispatchEvent(event) {
      for (const fn of [...(docListeners.get(event.type) || [])]) fn(event);
      return true;
    },
    listenerCount(type) { return (docListeners.get(type) || []).length; },
  };
  return { MiniElement, document: doc };
}

function withMiniDom(fn) {
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const prevNav = globalThis.navigator;
  const prevRaf = globalThis.requestAnimationFrame;
  const prevCaf = globalThis.cancelAnimationFrame;
  const dom = createMiniDom();
  if (typeof globalThis.navigator === 'undefined') {
    Object.defineProperty(globalThis, 'navigator', { value: { language: 'ja-JP', languages: ['ja-JP'] }, configurable: true });
  }
  globalThis.document = dom.document;
  globalThis.window = {
    innerWidth: 1024,
    innerHeight: 768,
    addEventListener() {},
    removeEventListener() {},
  };
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  const restore = () => {
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
    if (prevNav === undefined) delete globalThis.navigator;
    else Object.defineProperty(globalThis, 'navigator', { value: prevNav, configurable: true });
    globalThis.requestAnimationFrame = prevRaf;
    globalThis.cancelAnimationFrame = prevCaf;
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

// ============================================================================
// 1-2. [W1-T9] js/app.js: objcBusyState abort on reset & sampleOpen epoch guard
// ============================================================================
test('[W1-T9-1][app.js] reset aborts objcBusyState and sampleOpen guide timer checks openEpoch', () => {
  const appSrc = fs.readFileSync(path.join(REPO_ROOT, 'js/app.js'), 'utf8');
  assert.match(appSrc, /this\.objcBusyState\?\.controller\?\.abort\('objc-reset'\);\s*this\.objcBusyState = null;/);
  assert.match(appSrc, /if \(this\.sampleOpen\) setTimeout\(\(\) => \{ if \(openEpoch === this\.backend\.gen && this\.sampleOpen\) showSampleGuide\(this\); \}, 250\);/);
});

// ============================================================================
// 3. [W1-T9] js/emu-base.js: fmov supports zero register (xzr/wzr, cls === 'zr')
// ============================================================================
test('[W1-T9-2][emu-base.js] Emulator fmov supports xzr/wzr as source and destination', async () => {
  const insns = new Map([
    [0x1000n, { mn: 'fmov', ops: 'd0, xzr' }],
    [0x1004n, { mn: 'fmov', ops: 'xzr, d0' }],
    [0x1008n, { mn: 'ret', ops: '' }],
  ]);
  const emu = new Emulator({
    fetch: async (addr) => insns.get(addr) || null,
    isExecutable: () => true,
  });
  emu.setup(0x1000n, []);
  emu.fset({ text: 'd0' }, 42.5);

  const s1 = await emu.step();
  assert.equal(s1.ok, true, 'fmov d0, xzr must succeed');
  assert.equal(emu.fget({ text: 'd0' }), 0, 'fmov d0, xzr must zero d0');

  const s2 = await emu.step();
  assert.equal(s2.ok, true, 'fmov xzr, d0 must succeed');
  assert.equal(emu.get('xzr'), 0n, 'xzr must remain 0n');
});

// ============================================================================
// 4. [W1-T9] js/panels-base.js: showFeatures guards against epoch/sliceIndex change
// ============================================================================
test('[W1-T9-3][panels-base.js] showFeatures ignores stale results after backend.gen or sliceIndex changes', async () => {
  await withMiniDom(async () => {
    const prevLang = lang();
    setLang('en');
    try {
      const { showFeatures } = await import('../js/panels-base.js');
      const state = { fileInfo: { name: 'test.bin', size: 100 }, sliceIndex: 0 };
      const app = {
        backend: {
          gen: 1,
          async readAt() { return { found: false }; },
        },
        store: {
          get: (k) => state[k],
        },
        async ensureStrings() {
          await new Promise((r) => setTimeout(r, 15));
          return [{ addr: 0x1000n, text: "hp_bar" }];
        },
        featureIndex: null,
      };
      showFeatures(app);
      // Simulate switching slice/file while collectStrings is in flight
      app.backend.gen = 2;
      state.sliceIndex = 1;
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(app.featureIndex, null, 'stale showFeatures must not overwrite app.featureIndex');
    } finally {
      setLang(prevLang);
    }
  });
});

// ============================================================================
// 5-9. [W1-T9] js/tools-base.js: i18n pick(), epoch guards, abortable debugger/script/plugins
// ============================================================================
test('[W1-T9-4][tools-base.js] parseDebuggerArgument, explainEmulatorFault, and showTools support EN/JA i18n', async () => {
  await withMiniDom(async () => {
    const prevLang = lang();
    try {
      const { parseDebuggerArgument, explainEmulatorFault, showTools } = await import('../js/tools-base.js');
      setLang('en');
      const bad = parseDebuggerArgument('not-a-number');
      assert.equal(bad.ok, false);
      assert.match(bad.error, /Enter a decimal integer/);
      assert.match(explainEmulatorFault('program-return', ''), /returned normally/);

      showTools({ store: { get: () => null }, symbols: null, viewer: null });
      const title = globalThis.document.body.querySelector('.sheet-head .sheet-title');
      if (title) assert.equal(title.textContent, 'Analysis Tools');

      setLang('ja');
      const badJa = parseDebuggerArgument('not-a-number');
      assert.match(badJa.error, /10進整数/);
      assert.match(explainEmulatorFault('program-return', ''), /正常に終了/);
    } finally {
      setLang(prevLang);
    }
  });
});

test('[W1-T9-5][tools-base.js] showDebugger, showScript, showPlugins, showVtable, and showIl2cpp enforce abort & epoch guards', () => {
  const toolsSrc = fs.readFileSync(path.join(REPO_ROOT, 'js/tools-base.js'), 'utf8');
  // showVtable epoch guard
  assert.match(toolsSrc, /const vt = await readVtable\(read, cls\.vtable, app\.symbols, 64, pointerContext\);\s*if \(!isAppEpochCurrent\(app, snap, sheet\)\) return;/);
  // showDebugger activeRun AbortController + memAddr register parsing
  assert.match(toolsSrc, /abortRun\('debugger-step-replaced'\)/);
  assert.match(toolsSrc, /abortRun\('debugger-step10-replaced'\)/);
  assert.match(toolsSrc, /\^\(\?:sp\|wsp\|pc\|xzr\|wzr\)\$|\^\(sp\|wsp\|pc\|xzr\|wzr\)\$/);
  // showScript sheetController + runController
  assert.match(toolsSrc, /runController\?\.abort\('script-run-replaced'\)/);
  // showPlugins onClose aborts controller & isCurrent() guard
  assert.match(toolsSrc, /controller\.abort\('plugin-output-sheet-closed'\)/);
  // showIl2cpp epoch guard before mutating symbols
  assert.match(toolsSrc, /if \(named\.length && !controller\.signal\.aborted && isAppEpochCurrent\(app, snap, sheet\)\)/);
});

// ============================================================================
// 10. [W1-T9] js/ui/dyld-runtime-navigation.js: i18n refresh & full dispose cleanup
// ============================================================================
test('[W1-T9-6][dyld-runtime-navigation.js] updates labels on hex:language-changed and cleans up listeners/element on dispose', () => {
  withMiniDom(({ MiniElement }) => {
    const prevLang = lang();
    try {
      setLang('ja');
      const openBtn = new MiniElement('button');
      openBtn.id = 'btn-open';
      openBtn.className = 'tb-btn';
      const toolbar = new MiniElement('div');
      toolbar.append(openBtn);
      globalThis.document.body.append(toolbar);

      const app = {
        store: {
          get: (k) => (k === 'fileInfo' ? { format: 'dyld-cache' } : null),
          subscribe: () => () => {},
        },
      };

      const handle = installDyldRuntimeNavigation(app);
      assert.equal(handle.button.textContent, '実行時アドレス');
      assert.equal(typeof handle.button.hidden, 'boolean');

      setLang('en');
      globalThis.document.dispatchEvent({ type: 'hex:language-changed' });
      assert.equal(handle.button.textContent, 'Runtime address');
      assert.match(handle.button.title, /dyld shared cache/);

      // While disabled (mapping in progress), language change must not overwrite "Mapping…"
      handle.button.disabled = true;
      handle.button.textContent = 'Mapping…';
      setLang('ja');
      globalThis.document.dispatchEvent({ type: 'hex:language-changed' });
      assert.equal(handle.button.textContent, 'Mapping…');

      const docBefore = globalThis.document.listenerCount('hex:language-changed');
      assert.ok(docBefore >= 1);
      handle.dispose();
      assert.equal(globalThis.document.listenerCount('hex:language-changed'), docBefore - 1);
      assert.equal(handle.button.listenerCount('click'), 0);
      assert.equal(handle.button.isConnected, false);
    } finally {
      setLang(prevLang);
    }
  });
});

// ============================================================================
// 11-12. [W1-T9] js/ui/product-base.js & product-hardened.js
// ============================================================================
test('[W1-T9-7][product-base.js & product-hardened.js] external entities cache key, region restore, diff VirtualList disposal, and hardened EN copy', () => {
  const productSrc = fs.readFileSync(path.join(REPO_ROOT, 'js/ui/product-base.js'), 'utf8');
  assert.match(productSrc, /cachedExternalDescriptor\.program === program/);
  assert.match(productSrc, /cachedExternalDescriptor\.isJapanese === isJapanese/);
  assert.match(productSrc, /if \(state\.regionId && app\.store\?\.get\?\.\('currentRegion'\)\?\.id !== state\.regionId\)/);
  assert.match(productSrc, /const disposeVirtual = \(\) => \{ virtual\?\.dispose\(\); virtual = null; \};|const disposeVirtual=\(\)=>\{virtual\?\.dispose\(\);virtual=null;\};/);
  assert.match(productSrc, /dispose:\(\)=>\{disposeVirtual\(\);compareScope\.abort\('diff-route-disposed'\)/);

  const hardenedSrc = fs.readFileSync(path.join(REPO_ROOT, 'js/ui/product-hardened.js'), 'utf8');
  assert.match(hardenedSrc, /Automatic analysis findings appear here\. Run automatic analysis to scan the binary for goals such as HP and attack\./);
});
