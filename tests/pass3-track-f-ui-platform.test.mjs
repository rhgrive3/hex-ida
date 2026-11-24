import test from 'node:test';
import assert from 'node:assert/strict';

function createFakeDom() {
  class FakeClassList {
    constructor(el) {
      this._el = el;
      this._set = new Set();
    }
    _syncFromString(str) {
      this._set = new Set(String(str || '').split(/\s+/).filter(Boolean));
    }
    _toString() {
      return [...this._set].join(' ');
    }
    add(...names) {
      for (const n of names) if (n) this._set.add(n);
    }
    remove(...names) {
      for (const n of names) this._set.delete(n);
    }
    toggle(name, force) {
      if (force === undefined) {
        if (this._set.has(name)) { this._set.delete(name); return false; }
        this._set.add(name); return true;
      }
      if (force) { this._set.add(name); return true; }
      this._set.delete(name); return false;
    }
    contains(name) {
      return this._set.has(name);
    }
  }

  class FakeElement {
    constructor(tagName) {
      this.tagName = String(tagName || 'div').toUpperCase();
      this.children = [];
      this.parentNode = null;
      this.attributes = new Map();
      this.dataset = {};
      this.style = {};
      this.listeners = new Map();
      this.classList = new FakeClassList(this);
      this._textContent = '';
      this.value = '';
      this.disabled = false;
      this.hidden = false;
      this.tabIndex = 0;
      this.type = '';
      this.placeholder = '';
      this.id = '';
    }
    get childNodes() {
      return this.children;
    }
    get className() {
      return this.classList._toString();
    }
    set className(v) {
      this.classList._syncFromString(v);
    }
    get isConnected() {
      let cur = this;
      while (cur) {
        if (cur === doc.body) return true;
        cur = cur.parentNode;
      }
      return false;
    }
    get textContent() {
      if (!this.children.length) return this._textContent;
      return this._textContent + this.children.map((c) => c.textContent).join('');
    }
    set textContent(v) {
      this.children.forEach((c) => { c.parentNode = null; });
      this.children = [];
      this._textContent = v == null ? '' : String(v);
    }
    get innerHTML() {
      return this.textContent;
    }
    set innerHTML(v) {
      this.textContent = v;
    }
    append(...nodes) {
      for (const node of nodes) {
        if (node == null) continue;
        if (typeof node === 'string') {
          const t = new FakeElement('#text');
          t._textContent = node;
          t.parentNode = this;
          this.children.push(t);
        } else {
          if (node.parentNode) node.remove();
          node.parentNode = this;
          this.children.push(node);
        }
      }
    }
    appendChild(node) {
      this.append(node);
      return node;
    }
    replaceChildren(...nodes) {
      for (const c of this.children) c.parentNode = null;
      this.children = [];
      this._textContent = '';
      this.append(...nodes);
    }
    remove() {
      if (!this.parentNode) return;
      const idx = this.parentNode.children.indexOf(this);
      if (idx >= 0) this.parentNode.children.splice(idx, 1);
      this.parentNode = null;
    }
    setAttribute(k, v) {
      this.attributes.set(k, String(v));
      if (k === 'id') this.id = String(v);
      if (k === 'class') this.className = String(v);
    }
    getAttribute(k) {
      return this.attributes.has(k) ? this.attributes.get(k) : null;
    }
    removeAttribute(k) {
      this.attributes.delete(k);
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }
    removeEventListener(type, fn) {
      const list = this.listeners.get(type);
      if (!list) return;
      const idx = list.indexOf(fn);
      if (idx >= 0) list.splice(idx, 1);
    }
    dispatchEvent(event) {
      const list = [...(this.listeners.get(event.type) || [])];
      for (const fn of list) fn(event);
      return true;
    }
    click() {
      if (this.disabled) return;
      this.dispatchEvent({ type: 'click', target: this, preventDefault() {}, stopPropagation() {} });
    }
    focus() {}
    scrollIntoView() {}
    querySelectorAll(selector) {
      const out = [];
      const visit = (node) => {
        for (const child of node.children) {
          if (matchesSelector(child, selector)) out.push(child);
          visit(child);
        }
      };
      visit(this);
      return out;
    }
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    }
  }

  function matchesSelector(el, selector) {
    if (selector.startsWith('#')) return el.id === selector.slice(1);
    if (selector.startsWith('.')) {
      const classes = selector.split('.').filter(Boolean);
      return classes.every((c) => el.classList.contains(c));
    }
    return el.tagName.toLowerCase() === selector.toLowerCase();
  }

  const overlays = new FakeElement('div');
  overlays.id = 'overlays';
  const body = new FakeElement('body');
  body.append(overlays);
  const doc = {
    body,
    documentElement: new FakeElement('html'),
    createElement: (tag) => new FakeElement(tag),
    getElementById: (id) => (id === 'overlays' ? overlays : body.querySelector('#' + id)),
    querySelector: (sel) => body.querySelector(sel),
    querySelectorAll: (sel) => body.querySelectorAll(sel),
    addEventListener() {},
    removeEventListener() {},
  };

  return { doc, overlays, body };
}

test('P3-S06-007: showClass renders unresolved ivar (offset === null) safely without BigInt TypeError', async () => {
  const { doc, overlays } = createFakeDom();
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const prevRaf = globalThis.requestAnimationFrame;
  globalThis.document = doc;
  globalThis.window = { addEventListener() {}, removeEventListener() {}, location: { search: '' } };
  globalThis.requestAnimationFrame = (fn) => { fn(); return 1; };

  try {
    const { showClass } = await import('../js/panels-base.js');
    const info = {
      name: 'Player',
      superName: 'NSObject',
      instanceSize: 32,
      ivars: [
        { name: '_hp', type: 'i', offset: 16, size: 4 },
        { name: '_externalBinding', type: '@', offset: null, size: 8 },
      ],
      methods: [
        { kind: '-', sel: 'takeDamage:', addr: 0x100004000n },
      ],
      classMethods: [],
    };
    const app = {
      fields: {
        classInfo: (name) => (name === 'Player' ? info : null),
      },
    };

    assert.doesNotThrow(() => showClass(app, 'Player'));

    const sheet = overlays.querySelector('.sheet');
    assert.ok(sheet, 'class sheet should be rendered');
    const rows = sheet.querySelectorAll('li');
    assert.equal(rows.length, 3, 'should render both ivars and the method row');

    const resolvedRow = rows[0];
    assert.ok(resolvedRow.classList.contains('tappable'));
    assert.match(resolvedRow.textContent, /0x10/);

    const unresolvedRow = rows[1];
    assert.ok(unresolvedRow.classList.contains('disabled'), 'unresolved ivar row should be disabled');
    assert.match(unresolvedRow.textContent, /オフセット不明|offset unknown/);
    assert.equal(unresolvedRow.listeners.get('click') || undefined, undefined, 'disabled unresolved ivar should not bind click');

    const methodRow = rows[2];
    assert.match(methodRow.textContent, /takeDamage:/);
  } finally {
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
    globalThis.requestAnimationFrame = prevRaf;
  }
});

test('P3-S09-004: renaming struct member in showStructDetail pops only rename dialog, clears forward history, redraws detail, and keeps parent showStructs alive', async () => {
  const { doc, overlays } = createFakeDom();
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const prevRaf = globalThis.requestAnimationFrame;
  globalThis.document = doc;
  globalThis.window = { addEventListener() {}, removeEventListener() {}, location: { search: '' } };
  globalThis.requestAnimationFrame = (fn) => { fn(); return 1; };

  try {
    const { TypeStore } = await import('../js/types-legacy.js');
    const { showStructs } = await import('../js/tools-base.js');

    const notes = {
      structs: [{
        name: 'Player',
        size: 0x18,
        members: [
          { offset: 0x10, size: 4, type: 'int32', name: 'field_10' },
          { offset: 0x14, size: 4, type: 'int32', name: 'field_14' },
        ],
      }],
      save() { return true; },
    };
    const app = { notes };
    showStructs(app);

    const listSheets = overlays.querySelectorAll('.sheet');
    assert.equal(listSheets.length, 1, 'showStructs sheet should open');
    const structsSheetEl = listSheets[0];

    // Open struct detail by tapping Player row
    const playerRow = structsSheetEl.querySelectorAll('li').find((li) => li.textContent.includes('Player'));
    assert.ok(playerRow, 'Player row should exist in showStructs');
    playerRow.click();

    const afterDetail = overlays.querySelectorAll('.sheet');
    assert.equal(afterDetail.length, 2, 'showStructDetail sheet should open on top of showStructs');
    const detailSheetEl = afterDetail[1];
    assert.ok(structsSheetEl.classList.contains('parked'), 'parent showStructs should be parked');
    assert.ok(!detailSheetEl.classList.contains('parked'), 'detail sheet should be active');

    // Tap first member row to open rename dialog
    const memberRow = detailSheetEl.querySelectorAll('li').find((li) => li.textContent.includes('field_10'));
    assert.ok(memberRow, 'field_10 row should exist');
    memberRow.click();

    const afterRenameOpen = overlays.querySelectorAll('.sheet');
    assert.equal(afterRenameOpen.length, 3, 'rename dialog sheet should open');
    const renameSheetEl = afterRenameOpen[2];
    assert.ok(detailSheetEl.classList.contains('parked'), 'detail sheet should be parked while renaming');

    // Enter new name and click "決定"
    const nameInput = renameSheetEl.querySelector('input');
    assert.ok(nameInput, 'rename input should exist');
    nameInput.value = 'hp';
    const commitBtn = renameSheetEl.querySelectorAll('button').find((b) => b.textContent === '決定');
    assert.ok(commitBtn, '決定 button should exist');
    commitBtn.click();

    // Wait past Sheet.close()'s setTimeout(0) to ensure no delayed destroyChain() fires
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(renameSheetEl.isConnected, false, 'rename dialog should be destroyed and disconnected');
    assert.equal(detailSheetEl.isConnected, true, 'detail sheet must stay connected');
    assert.equal(detailSheetEl.classList.contains('parked'), false, 'detail sheet must be unparked and active');
    assert.equal(structsSheetEl.isConnected, true, 'parent showStructs sheet must remain alive');

    // Forward button on detail sheet must be disabled (stale rename dialog cleared from forward history)
    const fwdBtn = detailSheetEl.querySelector('.forward');
    assert.ok(fwdBtn, 'forward button should exist');
    assert.equal(fwdBtn.disabled, true, 'forward history must be cleared so committed dialog cannot be reopened');

    // Detail sheet must be redrawn with updated member name in both C block and member list
    assert.match(detailSheetEl.textContent, /\bhp\b/, 'detail sheet should show updated member name hp');
    assert.doesNotMatch(detailSheetEl.textContent, /field_10/, 'detail sheet should no longer show stale field_10');

    // Clicking back from detail sheet returns cleanly to showStructs
    const backBtn = detailSheetEl.querySelector('.back');
    assert.ok(backBtn && !backBtn.disabled, 'back button should remain enabled to return to showStructs');
    backBtn.click();
    assert.equal(structsSheetEl.classList.contains('parked'), false, 'showStructs should unpark on back');
  } finally {
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
    globalThis.requestAnimationFrame = prevRaf;
  }
});

test('P3-S07-001: PlatformPluginRegistry.invoke() releases child ResourceBudget scopes through guardBudget Proxy without leaking', async () => {
  const { PlatformPluginRegistry } = await import('../js/platform/plugin-api.js');
  const { ResourceBudget } = await import('../js/core/budgets/index.js');

  const registry = new PlatformPluginRegistry();
  registry.registerAnalyzer('track-f-analyzer', {
    analyze: async (ctx) => {
      ctx.resourceBudget.consume('operations', 1);
      return { ok: true };
    },
  });
  registry.registerAnalyzer('track-f-failing-analyzer', {
    analyze: async () => {
      throw new Error('intentional failure');
    },
  });

  const parentBudget = new ResourceBudget({ operations: 100 });
  const unrelatedChild = parentBudget.scope('unrelated-existing-scope');

  for (let i = 0; i < 5; i++) {
    const res = await registry.invoke('analyzer', 'track-f-analyzer', 'analyze', {
      resourceBudget: parentBudget,
    });
    assert.equal(res.ok, true);
  }

  const failed = await registry.invoke('analyzer', 'track-f-failing-analyzer', 'analyze', {
    resourceBudget: parentBudget,
  });
  assert.equal(failed.ok, false);

  assert.equal(parentBudget.children.size, 1, 'all plugin invocation child scopes must be deleted, leaving only unrelated child');
  assert.equal(parentBudget.children.get('unrelated-existing-scope'), unrelatedChild);
  const snap = parentBudget.snapshot({ recursive: true });
  assert.deepEqual(snap.children.map((c) => c.name), ['unrelated-existing-scope']);

  // Also verify CorePlatformPluginRegistry directly cleans up custom mock child scopes without `.name`
  const { PlatformPluginRegistry: CoreRegistry } = await import('../js/platform/plugin-api-core.js');
  const core = new CoreRegistry();
  core.registerAnalyzer('core-mock-analyzer', {
    analyze: async () => ({ done: true }),
  });
  const coreChildren = new Map();
  const coreMockBudget = {
    children: coreChildren,
    scope(name) {
      const child = { consume() {} };
      coreChildren.set(name, child);
      return child;
    },
  };
  const coreRes = await core.invoke('analyzer', 'core-mock-analyzer', 'analyze', {
    resourceBudget: coreMockBudget,
  });
  assert.equal(coreRes.ok, true);
  assert.equal(coreChildren.size, 0, 'custom mock child scope matched by reference identity must be deleted');
});
