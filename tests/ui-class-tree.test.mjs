import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLASS_TREE_SRC_PATH = path.resolve(__dirname, '../js/ui/panels/class-tree.js');

/**
 * Lightweight Mock DOM for Node testing (tracks innerHTML mutations to assert XSS safety).
 */
function installMockDom() {
  let innerHtmlAssignments = 0;

  class MockClassList {
    constructor(node) {
      this._node = node;
      this._set = new Set();
    }
    add(...names) {
      for (const n of names) if (n) this._set.add(n);
      this._sync();
    }
    remove(...names) {
      for (const n of names) this._set.delete(n);
      this._sync();
    }
    contains(name) {
      return this._set.has(name);
    }
    _sync() {
      this._node._className = [...this._set].join(' ');
    }
    _fromString(str) {
      this._set = new Set(String(str || '').split(/\s+/).filter(Boolean));
    }
  }

  class MockElement {
    constructor(tagName) {
      this.tagName = String(tagName || 'div').toUpperCase();
      this.childNodes = [];
      this.parentNode = null;
      this.attributes = new Map();
      this.listeners = new Map();
      this.style = {};
      this.dataset = {};
      this.value = '';
      this.disabled = false;
      this.tabIndex = 0;
      this.id = '';
      this._textContent = '';
      this._className = '';
      this.classList = new MockClassList(this);
      this.isConnected = false;
    }

    get className() { return this._className; }
    set className(val) {
      this._className = String(val || '');
      this.classList._fromString(this._className);
    }

    get textContent() {
      if (this.childNodes.length === 0) return this._textContent;
      return this._textContent + this.childNodes.map((c) => c.textContent).join('');
    }
    set textContent(val) {
      this._textContent = val == null ? '' : String(val);
      this.childNodes = [];
    }

    get innerHTML() { return ''; }
    set innerHTML(_val) {
      innerHtmlAssignments++;
      throw new Error('XSS violation: innerHTML must never be assigned in class-tree.js');
    }

    get children() { return this.childNodes; }

    append(...nodes) {
      for (const n of nodes) {
        if (n == null) continue;
        if (typeof n === 'string') {
          const span = new MockElement('#text');
          span._textContent = n;
          span.parentNode = this;
          span.isConnected = this.isConnected;
          this.childNodes.push(span);
        } else {
          if (n.parentNode) n.remove();
          n.parentNode = this;
          this._propagateConnected(n, this.isConnected);
          this.childNodes.push(n);
        }
      }
    }

    appendChild(n) {
      this.append(n);
      return n;
    }

    replaceChildren(...nodes) {
      for (const c of this.childNodes) {
        c.parentNode = null;
        this._propagateConnected(c, false);
      }
      this.childNodes = [];
      this.append(...nodes);
    }

    remove() {
      if (!this.parentNode) return;
      const idx = this.parentNode.childNodes.indexOf(this);
      if (idx >= 0) this.parentNode.childNodes.splice(idx, 1);
      this.parentNode = null;
      this._propagateConnected(this, false);
    }

    _propagateConnected(node, connected) {
      node.isConnected = connected;
      for (const c of node.childNodes) this._propagateConnected(c, connected);
    }

    setAttribute(name, value) {
      this.attributes.set(name, String(value));
      if (name === 'id') this.id = String(value);
      if (name === 'class') this.className = String(value);
    }
    getAttribute(name) {
      return this.attributes.has(name) ? this.attributes.get(name) : null;
    }
    removeAttribute(name) {
      this.attributes.delete(name);
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
      const list = this.listeners.get(event.type) || [];
      for (const fn of [...list]) fn(event);
      return true;
    }
    click() {
      this.dispatchEvent({ type: 'click', target: this, preventDefault() {}, stopPropagation() {} });
    }
    focus() {}

    _matches(selector) {
      if (selector.startsWith('.')) {
        return this.classList.contains(selector.slice(1));
      }
      const attrEq = /^\[([^=\]]+)="([^"]*)"\]$/.exec(selector);
      if (attrEq) {
        return this.getAttribute(attrEq[1]) === attrEq[2];
      }
      const attrExists = /^\[([^=\]]+)\]$/.exec(selector);
      if (attrExists) {
        return this.attributes.has(attrExists[1]);
      }
      return this.tagName === selector.toUpperCase();
    }

    querySelectorAll(selector) {
      const out = [];
      const walk = (node) => {
        for (const c of node.childNodes) {
          if (c._matches(selector)) out.push(c);
          walk(c);
        }
      };
      walk(this);
      return out;
    }

    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    }
  }

  const overlays = new MockElement('div');
  overlays.id = 'overlays';
  overlays.isConnected = true;

  const docEl = new MockElement('html');
  docEl.lang = 'ja';
  docEl.isConnected = true;

  const mockDocument = {
    documentElement: docEl,
    body: overlays,
    activeElement: null,
    createElement: (tag) => new MockElement(tag),
    getElementById: (id) => (id === 'overlays' ? overlays : null),
    addEventListener() {},
    removeEventListener() {},
  };

  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const prevRaf = globalThis.requestAnimationFrame;

  globalThis.document = mockDocument;
  globalThis.window = {
    addEventListener() {},
    removeEventListener() {},
    __hexUi: null,
  };
  globalThis.requestAnimationFrame = () => 0;

  return {
    overlays,
    getInnerHtmlAssignments: () => innerHtmlAssignments,
    restore() {
      globalThis.document = prevDoc;
      globalThis.window = prevWin;
      globalThis.requestAnimationFrame = prevRaf;
    },
  };
}

function createSampleTree() {
  const getChildrenCalls = [];
  const searchCalls = [];

  const nodes = new Map([
    ['root', {
      id: 'root', parentId: null, kind: 'root', label: 'Root', fullPath: '',
      source: 'cxx-rtti', confidence: 'high', functionCount: 105,
      childFolderIds: ['ns:Game', 'ns:XSS'], functionAddrs: [],
    }],
    ['ns:Game', {
      id: 'ns:Game', parentId: 'root', kind: 'namespace', label: 'Game', fullPath: 'Game',
      source: 'cxx-rtti', confidence: 'high', functionCount: 103,
      childFolderIds: ['cls:Game::Coin'], functionAddrs: [],
    }],
    ['cls:Game::Coin', {
      id: 'cls:Game::Coin', parentId: 'ns:Game', kind: 'class', label: 'Coin', fullPath: 'Game::Coin',
      source: 'cxx-rtti', confidence: 'high', functionCount: 103,
      childFolderIds: [],
      functionAddrs: Array.from({ length: 103 }, (_, i) => 0x1001A5000n + BigInt(i * 4)),
    }],
    ['ns:XSS', {
      id: 'ns:XSS', parentId: 'root', kind: 'class',
      label: 'std::vector<img src=x onerror=alert(1)><script>alert(1)</script>',
      fullPath: 'std::vector<img src=x onerror=alert(1)><script>alert(1)</script>',
      source: 'cxx-rtti', confidence: 'high', functionCount: 2,
      childFolderIds: [],
      functionAddrs: [0x100200000n, 0x100200010n],
    }],
  ]);

  return {
    rootId: 'root',
    nodes,
    completeness: 'complete',
    truncated: false,
    stats: { totalFolders: 4, totalFunctions: 105 },
    getChildrenCalls,
    searchCalls,
    getChildren(folderId, { offset = 0, limit = 100 } = {}) {
      getChildrenCalls.push({ folderId, offset, limit });
      const node = nodes.get(folderId);
      if (!node) return { folders: [], functions: [], totalFolders: 0, totalFunctions: 0, hasMore: false };
      const allFolders = node.childFolderIds.map((id) => nodes.get(id)).filter(Boolean);
      const allFuncs = node.functionAddrs;
      const total = allFolders.length + allFuncs.length;
      const combined = [
        ...allFolders.map((f) => ({ type: 'folder', value: f })),
        ...allFuncs.map((a) => ({ type: 'func', value: a })),
      ];
      const slice = combined.slice(offset, offset + limit);
      return {
        folders: slice.filter((x) => x.type === 'folder').map((x) => x.value),
        functions: slice.filter((x) => x.type === 'func').map((x) => x.value),
        totalFolders: allFolders.length,
        totalFunctions: allFuncs.length,
        hasMore: offset + slice.length < total,
      };
    },
    search(query, { limit = 50 } = {}) {
      searchCalls.push({ query, limit });
      const q = String(query || '').toLowerCase();
      const matches = [];
      for (const n of nodes.values()) {
        if (n.id === 'root') continue;
        if (n.fullPath.toLowerCase().includes(q) || n.label.toLowerCase().includes(q)) {
          matches.push({
            kind: 'folder',
            nodeId: n.id,
            label: n.label,
            fullPath: n.fullPath,
            confidence: n.confidence,
          });
        }
      }
      if (q.includes('coin')) {
        matches.push({
          kind: 'function',
          nodeId: 'cls:Game::Coin',
          label: 'sub_1001a5000',
          fullPath: 'Game::Coin',
          addr: 0x1001A5000n,
          confidence: 'high',
        });
      }
      return { matches: matches.slice(0, limit) };
    },
  };
}

const { showClassTree } = await import('../js/ui/panels/class-tree.js');

describe('ui/panels/class-tree (Track T5)', () => {
  let dom;

  beforeEach(() => {
    dom = installMockDom();
  });

  afterEach(async () => {
    // Allow Sheet's parked-sheet cleanup timer to settle before restoring globals.
    await new Promise((resolve) => setTimeout(resolve, 25));
    dom.restore();
  });

  it('static safety check: no innerHTML and no direct hex-engine-wasm import', () => {
    const src = fs.readFileSync(CLASS_TREE_SRC_PATH, 'utf8');
    assert.equal(/\.innerHTML\b/.test(src), false, 'class-tree.js must never use innerHTML');
    assert.equal(/hex-engine-wasm/.test(src), false, 'UI panel must not import hex-engine-wasm.js directly');
    assert.equal(/\.goto\s*\(/.test(src), false, 'must use app.goToAddress, never app.goto');
  });

  it('shows graceful fallback when tree is null or unavailable', () => {
    const app = { v6Workbench: { getVirtualTree: () => null } };
    const handle = showClassTree(app);
    assert.equal(handle.isEmpty, true);
    assert.match(handle.rootEl.textContent, /クラスツリーはまだ利用できません|Class tree is not available/);
    handle.close();
  });

  it('lazily expands folders and supports pagination ("Load more")', () => {
    const tree = createSampleTree();
    const semanticCards = new Map([
      [0x1001A5000n, {
        addr: 0x1001A5000n,
        slotIndex: 9,
        naming: { labelJa: '所持コインを更新する処理', nameEn: 'updateOwnedCoins', confidence: 'high', reasons: [] },
      }],
    ]);
    const app = {
      v6Workbench: {
        getVirtualTree: () => tree,
        getSemanticName: (va) => semanticCards.get(va) ?? null,
      },
      goToAddress: () => true,
    };

    const handle = showClassTree(app, { pageSize: 50 });
    assert.equal(handle.isEmpty, false);

    // Initially ONLY root children should be queried (strictly lazy)
    assert.equal(tree.getChildrenCalls.length, 1);
    assert.equal(tree.getChildrenCalls[0].folderId, 'root');
    assert.equal(handle.treeContainer.querySelectorAll('.class-tree-func-item').length, 0);

    // Expand Game -> reveals Game::Coin folder (still not Game::Coin's 103 functions)
    const gameLi = handle.treeContainer.querySelector('[data-folder-id="ns:Game"]');
    assert.ok(gameLi);
    gameLi.querySelector('.class-tree-folder-btn').click();
    assert.equal(gameLi.getAttribute('aria-expanded'), 'true');
    assert.equal(tree.getChildrenCalls.length, 2);
    assert.equal(tree.getChildrenCalls[1].folderId, 'ns:Game');

    // Expand Game::Coin -> loads first 50 functions + Load more button
    const coinLi = handle.treeContainer.querySelector('[data-folder-id="cls:Game::Coin"]');
    assert.ok(coinLi);
    coinLi.querySelector('.class-tree-folder-btn').click();
    assert.equal(coinLi.querySelectorAll('.class-tree-func-item').length, 50);
    assert.ok(coinLi.querySelector('[data-load-more="true"]'), 'Load more button must appear');

    // Verify semantic label rendered for 0x1001A5000n
    const firstFn = coinLi.querySelector('.class-tree-func-item');
    assert.match(firstFn.textContent, /所持コインを更新する処理/);
    assert.match(firstFn.textContent, /slot 9/);

    // Click Load more -> loads next 50 (total 100)
    coinLi.querySelector('.class-tree-load-more-btn').click();
    assert.equal(coinLi.querySelectorAll('.class-tree-func-item').length, 100);
    assert.ok(coinLi.querySelector('[data-load-more="true"]'));

    // Click Load more again -> loads final 3 (total 103), Load more disappears
    coinLi.querySelector('.class-tree-load-more-btn').click();
    assert.equal(coinLi.querySelectorAll('.class-tree-func-item').length, 103);
    assert.equal(coinLi.querySelector('[data-load-more="true"]'), null);

    // Collapse Game::Coin -> clears DOM children
    coinLi.querySelector('.class-tree-folder-btn').click();
    assert.equal(coinLi.getAttribute('aria-expanded'), 'false');
    assert.equal(coinLi.querySelectorAll('.class-tree-func-item').length, 0);

    handle.close();
  });

  it('jumps to function address via app.goToAddress(addr, { announce: true })', () => {
    const tree = createSampleTree();
    const jumped = [];
    const app = {
      v6Workbench: { getVirtualTree: () => tree },
      goToAddress(addr, options) {
        jumped.push({ addr, options });
        return true;
      },
    };

    const handle = showClassTree(app);
    const gameLi = handle.treeContainer.querySelector('[data-folder-id="ns:Game"]');
    gameLi.querySelector('.class-tree-folder-btn').click();
    const coinLi = handle.treeContainer.querySelector('[data-folder-id="cls:Game::Coin"]');
    coinLi.querySelector('.class-tree-folder-btn').click();

    const firstFnBtn = coinLi.querySelector('.class-tree-func-btn');
    assert.ok(firstFnBtn);
    firstFnBtn.click();

    assert.equal(jumped.length, 1);
    assert.equal(jumped[0].addr, 0x1001A5000n);
    assert.deepEqual(jumped[0].options, { announce: true });
  });

  it('searches folders and functions via tree.search and jumps on click', () => {
    const tree = createSampleTree();
    const jumped = [];
    const app = {
      v6Workbench: { getVirtualTree: () => tree },
      goToAddress(addr, options) {
        jumped.push({ addr, options });
        return true;
      },
    };

    const handle = showClassTree(app);
    handle.searchInput.value = 'coin';
    handle.searchInput.dispatchEvent({ type: 'keydown', key: 'Enter' });

    assert.equal(tree.searchCalls.length, 1);
    assert.equal(tree.searchCalls[0].query, 'coin');
    assert.equal(tree.searchCalls[0].limit, 50);

    const hits = handle.rootEl.querySelectorAll('.class-tree-search-hit');
    assert.equal(hits.length, 2); // 1 folder + 1 function
    hits[1].click();

    assert.equal(jumped.length, 1);
    assert.equal(jumped[0].addr, 0x1001A5000n);
    assert.deepEqual(jumped[0].options, { announce: true });
  });

  it('safely renders XSS payloads and C++ template angle brackets via textContent only', () => {
    const tree = createSampleTree();
    const app = { v6Workbench: { getVirtualTree: () => tree } };

    const handle = showClassTree(app);
    const xssLi = handle.treeContainer.querySelector('[data-folder-id="ns:XSS"]');
    assert.ok(xssLi);
    const labelEl = xssLi.querySelector('.class-tree-folder-label');
    assert.equal(
      labelEl.textContent,
      'std::vector<img src=x onerror=alert(1)><script>alert(1)</script>',
    );
    // Verify no <script> or <img> elements were created in the DOM
    assert.equal(handle.rootEl.querySelectorAll('script').length, 0);
    assert.equal(handle.rootEl.querySelectorAll('img').length, 0);
    assert.equal(dom.getInnerHtmlAssignments(), 0);
    handle.close();
  });

  it('cleans up descendant expanded state on parent collapse and restores root via Back to Root button', () => {
    const tree = createSampleTree();
    const app = { v6Workbench: { getVirtualTree: () => tree } };
    const handle = showClassTree(app);

    // Expand Game -> Coin
    const gameLi = handle.treeContainer.querySelector('[data-folder-id="ns:Game"]');
    gameLi.querySelector('.class-tree-folder-btn').click();
    const coinLi = handle.treeContainer.querySelector('[data-folder-id="cls:Game::Coin"]');
    coinLi.querySelector('.class-tree-folder-btn').click();
    assert.ok(coinLi.querySelector('.class-tree-load-more-btn'), 'Coin should have a Load more button for 103 functions');

    // Click Load more inside Coin -> should remove Coin's Load more button cleanly
    coinLi.querySelector('.class-tree-load-more-btn').click();
    assert.equal(coinLi.querySelector('.class-tree-load-more-btn'), null);

    // Collapse Game -> descendant Coin should be collapsed on re-expand
    gameLi.querySelector('.class-tree-folder-btn').click();
    assert.equal(gameLi.querySelector('[data-folder-id="cls:Game::Coin"]'), null);
    gameLi.querySelector('.class-tree-folder-btn').click();
    const coinLiAfter = gameLi.querySelector('[data-folder-id="cls:Game::Coin"]');
    assert.ok(coinLiAfter);
    assert.equal(coinLiAfter.querySelector('.class-tree-func-btn'), null, 're-expanding parent must not leave descendant expanded');

    // Search folder and focus it -> Back to Root button appears and restores full root
    handle.searchInput.value = 'coin';
    handle.searchInput.dispatchEvent({ type: 'keydown', key: 'Enter' });
    const hits = handle.rootEl.querySelectorAll('.class-tree-search-hit');
    hits[0].click(); // folder hit: cls:Game::Coin
    const backBtn = handle.rootEl.querySelector('.class-tree-back-root-btn');
    assert.ok(backBtn, 'Back to Root button must appear when focusing a search folder');
    backBtn.click();
    assert.equal(handle.rootEl.querySelector('.class-tree-back-root-btn'), null);
    assert.ok(handle.treeContainer.querySelector('[data-folder-id="ns:Game"]'));
    handle.close();
  });
});
