import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { markMission, missionSteps, missionFunction, notifyMission } from '../js/ui/mission.js';
import { buildMissionSection, editBookmarkNote } from '../js/ui/product-base.js';

function fakeApp() {
  let info = { name: 'a.bin', size: 1024, arch: 'arm64' };
  const names = [];
  const comments = new Map();
  const bookmarks = [];
  const subs = new Set();
  return {
    store: { get: (k) => (k === 'fileInfo' ? info : null) },
    notes: {
      nameEntries: () => names.slice(),
      comments,
      subscribe: (fn) => { subs.add(fn); return () => subs.delete(fn); },
      _subs: subs,
    },
    bookmarks: {
      list: () => bookmarks.slice(),
      has: (addr) => bookmarks.some((b) => BigInt(b.addr) === BigInt(addr)),
      get: (addr) => bookmarks.find((b) => BigInt(b.addr) === BigInt(addr)) || null,
      toggle: (addr, { name } = {}) => { bookmarks.push({ addr: BigInt(addr), name, note: '' }); },
      setNote: (addr, { note, name } = {}) => {
        const entry = bookmarks.find((b) => BigInt(b.addr) === BigInt(addr));
        if (entry) { entry.note = note; if (name) entry.name = name; }
      },
    },
    setFile(next) { info = next; },
    names, comments,
  };
}
const done = (app) => missionSteps(app).filter((s) => s.done).map((s) => s.id);

function makeDomEnv() {
  const docListeners = new Map();
  const winListeners = new Map();
  const add = (map, type, fn) => {
    let set = map.get(type);
    if (!set) { set = new Set(); map.set(type, set); }
    set.add(fn);
  };
  const remove = (map, type, fn) => { map.get(type)?.delete(fn); };
  const dispatch = (map, type, event) => {
    for (const fn of [...(map.get(type) || [])]) fn(event);
  };
  class MockEl {
    constructor(tag) {
      this.tagName = tag.toUpperCase();
      this.children = [];
      this.attributes = {};
      this.dataset = {};
      this.events = {};
      this.isConnected = false;
      this.className = '';
      this.value = '';
      this.style = {};
      const classes = new Set();
      this.classList = {
        add: (...ns) => { for (const n of ns) classes.add(n); },
        remove: (...ns) => { for (const n of ns) classes.delete(n); },
        toggle: (n, on) => { if (on) classes.add(n); else classes.delete(n); },
        contains: (n) => classes.has(n),
      };
    }
    get childNodes() { return this.children; }
    set textContent(v) { this._text = String(v); this.children = []; }
    get textContent() { return (this._text ?? '') + this.children.map((c) => c.textContent).join(''); }
    append(...nodes) {
      for (const n of nodes) {
        if (typeof n === 'string') { this._text = (this._text ?? '') + n; continue; }
        n.parentNode = this;
        this.children.push(n);
      }
    }
    replaceChildren(...nodes) { this._text = ''; this.children = []; this.append(...nodes); }
    setAttribute(k, v) { this.attributes[k] = String(v); }
    getAttribute(k) { return this.attributes[k] ?? null; }
    removeAttribute(k) { delete this.attributes[k]; }
    addEventListener(type, fn) { (this.events[type] ??= []).push(fn); }
    removeEventListener(type, fn) { if (this.events[type]) this.events[type] = this.events[type].filter((f) => f !== fn); }
    click() { for (const fn of this.events.click || []) fn({ preventDefault() {}, stopPropagation() {} }); }
    focus() {}
    remove() { this.isConnected = false; }
    querySelectorAll(sel) {
      const out = [];
      const walk = (node) => {
        for (const ch of node.children || []) {
          if (sel === 'button' && ch.tagName === 'BUTTON') out.push(ch);
          if (sel === 'input' && ch.tagName === 'INPUT') out.push(ch);
          walk(ch);
        }
      };
      walk(this);
      return out;
    }
  }
  const body = new MockEl('body');
  body.isConnected = true;
  const overlays = new MockEl('div');
  overlays.id = 'overlays';
  overlays.isConnected = true;
  const toastEl = new MockEl('div');
  toastEl.id = 'toast';
  toastEl.isConnected = true;
  const doc = {
    body,
    documentElement: new MockEl('html'),
    createElement: (tag) => new MockEl(tag),
    addEventListener: (t, fn) => add(docListeners, t, fn),
    removeEventListener: (t, fn) => remove(docListeners, t, fn),
    dispatchEvent: (ev) => dispatch(docListeners, ev.type, ev),
    querySelector: () => null,
    getElementById: (id) => (id === 'overlays' ? overlays : id === 'toast' ? toastEl : null),
  };
  const win = {
    addEventListener: (t, fn) => add(winListeners, t, fn),
    removeEventListener: (t, fn) => remove(winListeners, t, fn),
    dispatchEvent: (ev) => dispatch(winListeners, ev.type, ev),
    location: { hash: '' },
  };
  return { doc, win, overlays, docListeners, winListeners };
}

test('steps are checked from real state in order', () => {
  const app = fakeApp();
  assert.deepEqual(done(app), []);
  app.lastGoal = { id: 'money' };
  app.lastGoalContext = { targetAddr: 0x2000n };
  assert.equal(missionFunction(app), 0x2000n);
  markMission(app, 'open-function', 0x1000n);
  assert.equal(missionFunction(app), 0x1000n, 'the opened function wins');
  markMission(app, 'read-pseudo');
  app.names.push({ addr: 0x1000n, name: 'addCoins' });
  app.comments.set('4096', 'memo');
  markMission(app, 'report');
  assert.deepEqual(done(app), ['goal', 'open', 'pseudo', 'name', 'note', 'report']);
});

test('session marks reset when another file is opened', () => {
  const app = fakeApp();
  markMission(app, 'open-function', 0x10n);
  markMission(app, 'read-pseudo');
  app.setFile({ name: 'b.bin', size: 1024, arch: 'arm64' });
  assert.deepEqual(done(app), []);
  assert.equal(missionFunction(app), null);
});

test('recreating fileInfo with identical value key preserves session mission progress', () => {
  const app = fakeApp();
  markMission(app, 'open-function', 0x1234n);
  markMission(app, 'read-pseudo');
  markMission(app, 'report');
  app.setFile({ name: 'a.bin', size: 1024, arch: 'arm64' });
  assert.deepEqual(done(app), ['open', 'pseudo', 'report']);
  assert.equal(missionFunction(app), 0x1234n);

  app.setFile({ name: 'a.bin', size: 2048, arch: 'arm64' });
  assert.deepEqual(done(app), [], 'changing size resets progress');
  markMission(app, 'open-function', 0x5678n);
  app.setFile({ name: 'a.bin', size: 2048, arch: 'x86_64' });
  assert.deepEqual(done(app), [], 'changing arch resets progress');
});

test('buildMissionSection cleans up all listeners even when unmounted without any refresh', async () => {
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const env = makeDomEnv();
  globalThis.document = env.doc;
  globalThis.window = env.win;
  try {
    const app = fakeApp();
    const wrap = buildMissionSection(app, {});
    wrap.isConnected = true;
    await Promise.resolve();
    assert.equal(wrap.dataset.mounted, '1', 'marked mounted on microtask immediately after mount');
    assert.equal(env.docListeners.get('hex:mission')?.size, 1);
    assert.equal(env.winListeners.get('hashchange')?.size, 1);
    assert.equal(app.notes._subs.size, 1);

    wrap.isConnected = false;
    env.win.dispatchEvent(new Event('hashchange'));
    assert.equal(env.docListeners.get('hex:mission')?.size, 0, 'document hex:mission listener removed');
    assert.equal(env.winListeners.get('hashchange')?.size, 0, 'window hashchange listener removed');
    assert.equal(app.notes._subs.size, 0, 'notes subscriber removed');

    const ctrl = new AbortController();
    const wrap2 = buildMissionSection(app, {}, { signal: ctrl.signal });
    assert.equal(env.docListeners.get('hex:mission')?.size, 1);
    ctrl.abort();
    assert.equal(env.docListeners.get('hex:mission')?.size, 0, 'route signal abort cleans up immediately');
    assert.equal(env.winListeners.get('hashchange')?.size, 0);
    assert.equal(app.notes._subs.size, 0);
    assert.equal(typeof wrap2._cleanupMission, 'function');
  } finally {
    if (prevDoc === undefined) delete globalThis.document; else globalThis.document = prevDoc;
    if (prevWin === undefined) delete globalThis.window; else globalThis.window = prevWin;
  }
});

test('mission section updates immediately on hex:mission (goal confirmation & editBookmarkNote)', async () => {
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const prevRaf = globalThis.requestAnimationFrame;
  const env = makeDomEnv();
  globalThis.document = env.doc;
  globalThis.window = env.win;
  globalThis.requestAnimationFrame = () => 0;
  try {
    const app = fakeApp();
    const wrap = buildMissionSection(app, {});
    wrap.isConnected = true;
    await Promise.resolve();
    assert.match(wrap.textContent, /0 \/ 6/);

    app.lastGoal = { id: 'money' };
    notifyMission();
    assert.match(wrap.textContent, /1 \/ 6/, 'goal confirmation updates progress immediately');

    editBookmarkNote(app, 0x1000n, 'addCoins');
    const sheetRoot = env.overlays.children[env.overlays.children.length - 1];
    const inputs = sheetRoot.querySelectorAll('input');
    const buttons = sheetRoot.querySelectorAll('button');
    assert.ok(inputs.length >= 1, 'bookmark note input rendered');
    inputs[0].value = 'coins updated here';
    const saveBtn = buttons.find((b) => /Save|保存/.test(b.textContent));
    assert.ok(saveBtn, 'save button rendered');
    saveBtn.click();
    assert.match(wrap.textContent, /2 \/ 6/, 'saving bookmark note dispatches hex:mission and updates progress');

    wrap._cleanupMission();
  } finally {
    if (prevDoc === undefined) delete globalThis.document; else globalThis.document = prevDoc;
    if (prevWin === undefined) delete globalThis.window; else globalThis.window = prevWin;
    if (prevRaf === undefined) delete globalThis.requestAnimationFrame; else globalThis.requestAnimationFrame = prevRaf;
  }

  const productBaseSrc = fs.readFileSync(new URL('../js/ui/product-base.js', import.meta.url), 'utf8');
  assert.match(productBaseSrc, /showCandidates\(app,\s*\{\s*\.\.\.goal,\s*query:\s*compiled\s*\}\);\s*\n\s*notifyMission\(\);/);
});
