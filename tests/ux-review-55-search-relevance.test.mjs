import test from 'node:test';
import assert from 'node:assert/strict';
import {
  scoreSearchMatch,
  compareSearchResults,
  rankSearchResults,
  matchGoalForQuery,
  buildOmniboxSearchItems,
  SEARCH_CATEGORIES,
} from '../js/ai/interaction/omnibox.js';
import {
  scoreSearchMatch as panelScoreSearchMatch,
  unifiedSearch,
  showSearch,
} from '../js/ui/panels/search.js';
import { FieldIndex } from '../js/fields.js';

function installFakeDom() {
  class FakeClassList {
    constructor(el) { this._el = el; this._set = new Set(); }
    add(...names) { for (const n of names) if (n) this._set.add(n); this._sync(); }
    remove(...names) { for (const n of names) this._set.delete(n); this._sync(); }
    toggle(name, force) {
      if (force === undefined) { if (this._set.has(name)) this._set.delete(name); else this._set.add(name); }
      else if (force) this._set.add(name);
      else this._set.delete(name);
      this._sync();
    }
    contains(name) { return this._set.has(name); }
    _sync() { this._el._className = [...this._set].join(' '); }
    _setFromString(str) {
      this._set = new Set(String(str || '').split(/\s+/).filter(Boolean));
      this._sync();
    }
  }

  class FakeNode {
    constructor(tag) {
      this.tagName = String(tag || 'DIV').toUpperCase();
      this.id = '';
      this.children = [];
      this.parentNode = null;
      this.attributes = new Map();
      this.listeners = new Map();
      this.style = { setProperty() {} };
      this.dataset = {};
      this._className = '';
      this.classList = new FakeClassList(this);
      this._textContent = '';
      this.value = '';
      this.disabled = false;
      this.hidden = false;
      this.tabIndex = 0;
    }
    get childNodes() { return this.children; }
    get className() { return this._className; }
    set className(v) { this.classList._setFromString(v); }
    get isConnected() {
      let cur = this;
      while (cur) {
        if (cur === doc.body) return true;
        cur = cur.parentNode;
      }
      return false;
    }
    get textContent() {
      if (this.children.length === 0) return this._textContent;
      return this._textContent + this.children.map((c) => c.textContent).join('');
    }
    set textContent(v) {
      this._textContent = String(v ?? '');
      this.children = [];
    }
    append(...nodes) {
      for (const n of nodes) {
        if (n == null) continue;
        if (typeof n === 'string') {
          this._textContent += n;
        } else if (n.tagName === '#FRAGMENT') {
          for (const child of [...n.children]) this.append(child);
        } else {
          if (n.parentNode) n.remove();
          n.parentNode = this;
          this.children.push(n);
        }
      }
    }
    appendChild(n) { this.append(n); return n; }
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
    }
    getAttribute(k) { return this.attributes.get(k) ?? null; }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }
    removeEventListener(type, fn) {
      const list = this.listeners.get(type);
      if (!list) return;
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    }
    dispatchEvent(event) {
      const list = this.listeners.get(event.type) || [];
      for (const fn of [...list]) fn(event);
    }
    click() { this.dispatchEvent({ type: 'click', target: this, preventDefault() {}, stopPropagation() {} }); }
    focus() { doc.activeElement = this; }
    blur() { if (doc.activeElement === this) doc.activeElement = null; }
    contains(node) {
      if (node === this) return true;
      for (const c of this.children) if (c.contains(node)) return true;
      return false;
    }
    querySelectorAll(selector) {
      const out = [];
      const match = (node) => {
        if (selector.startsWith('.')) return node.classList.contains(selector.slice(1));
        if (selector.startsWith('#')) return node.id === selector.slice(1);
        return node.tagName.toLowerCase() === selector.toLowerCase();
      };
      const walk = (node) => {
        for (const c of node.children) {
          if (match(c)) out.push(c);
          walk(c);
        }
      };
      walk(this);
      return out;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  }

  const body = new FakeNode('BODY');
  const overlays = new FakeNode('DIV');
  overlays.id = 'overlays';
  body.append(overlays);
  const doc = {
    body,
    documentElement: body,
    activeElement: null,
    createElement: (tag) => new FakeNode(tag),
    createDocumentFragment: () => new FakeNode('#FRAGMENT'),
    getElementById: (id) => body.querySelector('#' + id),
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelector: (s) => body.querySelector(s),
    querySelectorAll: (s) => body.querySelectorAll(s),
  };
  globalThis.document = doc;
  globalThis.requestAnimationFrame = (fn) => fn();
  globalThis.window = {
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    innerWidth: 1280,
    innerHeight: 800,
  };
  return { doc, body };
}

test('scoreSearchMatch ranks exact > word-boundary > prefix > substring (word-boundary first)', () => {
  assert.equal(scoreSearchMatch, panelScoreSearchMatch, 'search.js re-exports scoreSearchMatch');

  // Required explicit comparisons against mid-word cross-boundary match "flushPlayer"
  assert.ok(scoreSearchMatch('getHP', 'HP') > scoreSearchMatch('flushPlayer', 'HP'));
  assert.ok(scoreSearchMatch('hp_max', 'HP') > scoreSearchMatch('flushPlayer', 'HP'));
  assert.ok(scoreSearchMatch('kHP', 'HP') > scoreSearchMatch('flushPlayer', 'HP'));
  assert.ok(scoreSearchMatch('playerHP', 'HP') > scoreSearchMatch('flushPlayer', 'HP'));
  assert.ok(scoreSearchMatch('maxHp', 'HP') > scoreSearchMatch('flushPlayer', 'HP'));

  // Full tier ordering
  const exact = scoreSearchMatch('HP', 'HP');
  const exactCi = scoreSearchMatch('Hp', 'HP');
  const boundaryStart = scoreSearchMatch('hp_max', 'HP');
  const boundaryCamel = scoreSearchMatch('getHP', 'HP');
  const boundarySep = scoreSearchMatch('-[Player hp]', 'HP');
  const boundaryColon = scoreSearchMatch('Player::hp', 'HP');
  const boundaryDot = scoreSearchMatch('player.hp', 'HP');
  const boundarySlash = scoreSearchMatch('stats/hp', 'HP');
  const boundaryDash = scoreSearchMatch('hp-bar', 'HP');
  const prefix = scoreSearchMatch('hplayer', 'HP');
  const substring = scoreSearchMatch('flushPlayer', 'HP');
  const none = scoreSearchMatch('renderFrame', 'HP');

  assert.equal(exact, exactCi);
  assert.ok(exact > boundaryStart, 'exact > word-boundary start');
  assert.ok(boundaryStart >= boundaryCamel, 'word-boundary start >= word-boundary mid');
  assert.ok(boundaryCamel > prefix, 'word-boundary > prefix');
  assert.ok(boundarySep > prefix, 'ObjC bracket/space word-boundary > prefix');
  assert.ok(boundaryColon > prefix, 'C++ :: word-boundary > prefix');
  assert.ok(boundaryDot > prefix, 'dot word-boundary > prefix');
  assert.ok(boundarySlash > prefix, 'slash word-boundary > prefix');
  assert.ok(boundaryDash > prefix, 'dash word-boundary > prefix');
  assert.ok(prefix > substring, 'prefix > substring');
  assert.ok(substring > 0, 'substring still matches with lowest positive score');
  assert.equal(none, 0, 'non-matching name scores 0');
});

test('rankSearchResults sorts by score desc, shorter name asc, then address asc', () => {
  const candidates = [
    { name: 'flushPlayer', addr: 0x1000n },
    { name: 'playerCurrentHP', addr: 0x1004n },
    { name: 'getHP', addr: 0x2000n },
    { name: 'getHP', addr: 0x1500n },
    { name: 'kHP', addr: 0x3000n },
    { name: 'HP', addr: 0x4000n },
    { name: 'hplayer', addr: 0x1100n },
  ];
  const ranked = rankSearchResults(candidates, 'HP');
  assert.deepEqual(
    ranked.map((r) => `${r.name}@0x${r.addr.toString(16)}`),
    [
      'HP@0x4000',
      'kHP@0x3000',
      'getHP@0x1500',
      'getHP@0x2000',
      'playerCurrentHP@0x1004',
      'hplayer@0x1100',
      'flushPlayer@0x1000',
    ],
  );
  assert.equal(compareSearchResults({ score: 300, name: 'kHP', addr: 0x20n }, { score: 300, name: 'kHP', addr: 0x10n }) > 0, true);
});

test('matchGoalForQuery bridges search terms to preset goals in js/goals.js', () => {
  const cases = [
    ['HP', 'hp', 'HP・体力'],
    ['hp', 'hp', 'HP・体力'],
    ['体力', 'hp', 'HP・体力'],
    ['攻撃', 'attack', '攻撃力'],
    ['課金', 'purchase', '購入・課金'],
    ['コイン', 'money', '所持金・コイン'],
  ];
  for (const [q, expectedId, expectedLabel] of cases) {
    const match = matchGoalForQuery(q);
    assert.ok(match, `expected goal match for ${q}`);
    assert.equal(match.id, expectedId);
    assert.equal(match.label, expectedLabel);
    assert.equal(match.actionLabel, `目的として調べる: ${expectedLabel}`);
  }
  assert.equal(matchGoalForQuery('flushPlayer'), null);
  assert.equal(matchGoalForQuery(''), null);
});

test('unifiedSearch searches functions, strings, classes, and fields with category badges and top goal bridge', () => {
  const fields = new FieldIndex({
    classes: [
      {
        name: 'HPBarController',
        instanceSize: 64,
        ivars: [
          { name: '_hp', offset: 0x20, size: 4, offsetVar: 0x5000n },
          { name: '_maxHp', offset: 0x24, size: 4, offsetVar: 0x5008n },
        ],
      },
      {
        name: 'AudioMixer',
        instanceSize: 32,
        ivars: [
          { name: '_volume', offset: 0x10, size: 4 },
        ],
      },
    ],
  });

  const app = {
    symbols: {
      functionList: () => [
        { name: 'flushPlayer', addr: 0x1000n },
        { name: 'getHP', addr: 0x2000n },
        { name: 'Player::setHP', addr: 0x2100n },
      ],
    },
    stringIndex: [
      { text: 'HP is low', addr: 0x3000n },
      { text: 'Loading textures...', addr: 0x3100n },
    ],
    fields,
  };

  const res = unifiedSearch(app, 'HP');

  // Top action row bridges to HP・体力 goal
  assert.ok(res.goalAction, 'goalAction should be present for "HP"');
  assert.equal(res.goalAction.label, '目的として調べる: HP・体力');
  assert.equal(res.results[0], res.goalAction, 'goalAction must be prepended at index 0');

  // All 4 entity categories are present with exact badges
  const categories = new Set(res.items.map((it) => it.category));
  assert.deepEqual([...categories].sort(), ['class', 'field', 'function', 'string']);
  for (const it of res.items) {
    assert.equal(it.badge, SEARCH_CATEGORIES[it.category]);
  }
  assert.ok(res.items.some((it) => it.badge === '関数' && it.name === 'getHP'));
  assert.ok(res.items.some((it) => it.badge === '文字列' && it.name === 'HP is low'));
  assert.ok(res.items.some((it) => it.badge === 'クラス' && it.name === 'HPBarController'));
  assert.ok(res.items.some((it) => it.badge === 'フィールド' && it.name === 'HPBarController._hp'));

  // Relevance ordering: word-boundary hits rank strictly above substring "flushPlayer"
  const getHpIdx = res.items.findIndex((it) => it.name === 'getHP');
  const fieldHpIdx = res.items.findIndex((it) => it.name === 'HPBarController._hp');
  const flushIdx = res.items.findIndex((it) => it.name === 'flushPlayer');
  assert.ok(getHpIdx >= 0 && fieldHpIdx >= 0 && flushIdx >= 0);
  assert.ok(getHpIdx < flushIdx, 'getHP must rank above flushPlayer');
  assert.ok(fieldHpIdx < flushIdx, '_hp field must rank above flushPlayer');

  // Graceful handling when stores are absent
  const emptyRes = unifiedSearch({}, 'HP');
  assert.equal(emptyRes.items.length, 0);
  assert.equal(emptyRes.goalAction?.label, '目的として調べる: HP・体力');

  // Pure omnibox builder also prepends goal bridge
  const omniboxItems = buildOmniboxSearchItems('HP', [
    { category: 'function', name: 'flushPlayer', addr: 0x1000n },
    { category: 'function', name: 'kHP', addr: 0x2000n },
  ]);
  assert.equal(omniboxItems[0].kind, 'goal');
  assert.equal(omniboxItems[0].label, '目的として調べる: HP・体力');
  assert.equal(omniboxItems[1].name, 'kHP');
  assert.equal(omniboxItems[2].name, 'flushPlayer');
});

test('showSearch renders top goal-bridge row and invokes showCandidates when clicked', () => {
  const { body } = installFakeDom();
  const state = new Map([
    ['currentRegion', { id: 'text', name: '__text', vmAddr: 0x1000n, size: 0x2000n }],
    ['searchKind', 'unified'],
    ['searchQuery', ''],
  ]);
  const triggeredGoals = [];
  const app = {
    store: {
      get: (k) => state.get(k),
      set: (obj) => { for (const [k, v] of Object.entries(obj)) state.set(k, v); },
    },
    symbols: {
      functionList: () => [
        { name: 'flushPlayer', addr: 0x1000n },
        { name: 'getHP', addr: 0x2000n },
      ],
    },
    stringIndex: [{ text: 'HP回復', addr: 0x3000n }],
    fields: new FieldIndex({
      classes: [{ name: 'HPManager', instanceSize: 32, ivars: [{ name: '_hp', offset: 0x10, size: 4 }] }],
    }),
    showCandidates(goal) {
      triggeredGoals.push(goal);
    },
    goToAddress() { return true; },
  };

  showSearch(app);
  const input = body.querySelector('input');
  input.value = 'HP';
  input.dispatchEvent({ type: 'keydown', key: 'Enter' });

  const rows = body.querySelectorAll('.tappable');
  assert.ok(rows.length >= 5, 'expected goal bridge row + 4 entity hits');
  assert.ok(rows[0].classList.contains('search-goal-bridge'), 'first row must be the goal bridge');
  assert.ok(rows[0].textContent.includes('目的として調べる: HP・体力'));

  // Clicking the top goal-bridge row triggers goal investigation
  rows[0].click();
  assert.equal(triggeredGoals.length, 1);
  assert.equal(triggeredGoals[0].id, 'hp');
});

test('showSearch clicking class navigates to /explorer/types and clicking unaddressed field opens showField instead of null navigateToAddress', () => {
  const { body } = installFakeDom();
  const navigated = [];
  globalThis.window.__hexUi = {
    router: {
      current: { route: { id: 'investigate' } },
      navigate(url) { navigated.push(url); },
    },
  };

  const state = new Map([
    ['currentRegion', { id: 'text', name: '__text', vmAddr: 0x1000n, size: 0x2000n }],
    ['searchKind', 'unified'],
    ['searchQuery', ''],
  ]);
  const goToAddressCalls = [];
  const showFieldCalls = [];
  const app = {
    store: {
      get: (k) => state.get(k),
      set: (obj) => { for (const [k, v] of Object.entries(obj)) state.set(k, v); },
    },
    symbols: {
      functionList: () => [{ name: 'getHP', addr: 0x2000n }],
    },
    fields: new FieldIndex({
      classes: [{ name: 'HPManager', instanceSize: 32, ivars: [{ name: '_hp', offset: 0x10, size: 4 }] }],
    }),
    showField(className, field) {
      showFieldCalls.push({ className, field });
    },
    goToAddress(addr) {
      goToAddressCalls.push(addr);
      return true;
    },
  };

  // Click class item -> should navigate to /explorer/types?q=HPManager
  showSearch(app);
  let input = body.querySelector('input');
  input.value = 'HPManager';
  input.dispatchEvent({ type: 'keydown', key: 'Enter' });
  let rows = body.querySelectorAll('.tappable');
  const classRow = rows.find((r) => r.textContent.includes('HPManager') && r.textContent.includes('クラス'));
  assert.ok(classRow, 'class row should be rendered in unified search');
  classRow.click();
  assert.deepEqual(navigated, ['/explorer/types?q=HPManager']);
  assert.equal(goToAddressCalls.length, 0, 'clicking class must not call goToAddress');

  // Click unaddressed field item (addr == null) -> should call showField instead of goToAddress(null)
  showSearch(app);
  input = body.querySelector('input');
  input.value = '_hp';
  input.dispatchEvent({ type: 'keydown', key: 'Enter' });
  rows = body.querySelectorAll('.tappable');
  const fieldRow = rows.find((r) => r.textContent.includes('HPManager._hp') && r.textContent.includes('フィールド'));
  assert.ok(fieldRow, 'unaddressed field row should be rendered in unified search');
  fieldRow.click();
  assert.equal(showFieldCalls.length, 1, 'clicking unaddressed field should invoke showField');
  assert.equal(showFieldCalls[0].className, 'HPManager');
  assert.equal(showFieldCalls[0].field.name, '_hp');
  assert.equal(goToAddressCalls.length, 0, 'clicking unaddressed field must not call goToAddress');
});

test('top Omnibox dropdown prepends goal bridge row at top and ranks matched functions by 5.5 relevance scorer', async () => {
  const { doc, body } = installFakeDom();
  const appRoot = doc.createElement('div');
  appRoot.id = 'app';
  const titlebar = doc.createElement('div');
  titlebar.className = 'titlebar';
  const btnOpen = doc.createElement('button');
  btnOpen.id = 'btn-open';
  titlebar.append(btnOpen);
  const fileInput = doc.createElement('input');
  fileInput.id = 'file-input';
  const viewerEl = doc.createElement('div');
  viewerEl.id = 'viewer';
  const overlays = doc.getElementById('overlays');
  appRoot.append(titlebar, fileInput, viewerEl, overlays);
  body.append(appRoot);

  // Add DOM helpers needed by installProductUI
  const NodeProto = Object.getPrototypeOf(appRoot);
  if (!NodeProto.prepend) {
    NodeProto.prepend = function prepend(...nodes) {
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i];
        if (n == null) continue;
        if (typeof n === 'string') { this._textContent = n + this._textContent; continue; }
        if (n.parentNode) n.remove();
        n.parentNode = this;
        this.children.unshift(n);
      }
    };
  }
  if (!NodeProto.after) {
    NodeProto.after = function after(...nodes) {
      if (!this.parentNode) return;
      let idx = this.parentNode.children.indexOf(this) + 1;
      for (const n of nodes) {
        if (n == null || typeof n === 'string') continue;
        if (n.parentNode) n.remove();
        n.parentNode = this.parentNode;
        this.parentNode.children.splice(idx++, 0, n);
      }
    };
  }
  if (!NodeProto.before) {
    NodeProto.before = function before(...nodes) {
      if (!this.parentNode) return;
      const idx = this.parentNode.children.indexOf(this);
      if (idx < 0) return;
      for (const n of nodes) {
        if (n == null || typeof n === 'string') continue;
        if (n.parentNode) n.remove();
        n.parentNode = this.parentNode;
        this.parentNode.children.splice(idx, 0, n);
      }
    };
  }
  if (!NodeProto.removeAttribute) NodeProto.removeAttribute = function (k) { this.attributes.delete(k); };
  if (!NodeProto.hasAttribute) NodeProto.hasAttribute = function (k) { return this.attributes.has(k); };
  doc.createTextNode = (t) => String(t ?? '');
  doc.createElementNS = (_ns, tag) => doc.createElement(tag);
  globalThis.window.location = { href: 'https://hex.test/', pathname: '/', search: '', hash: '#/investigate' };
  globalThis.window.history = {
    state: null,
    pushState(s, _t, u) { this.state = s; globalThis.window.location.hash = String(u).includes('#') ? String(u).slice(String(u).indexOf('#')) : ''; },
    replaceState(s, _t, u) { this.state = s; globalThis.window.location.hash = String(u).includes('#') ? String(u).slice(String(u).indexOf('#')) : ''; },
  };
  globalThis.location = globalThis.window.location;
  globalThis.history = globalThis.window.history;

  const { Store } = await import('../js/state.js');
  const { SymbolIndex } = await import('../js/symbols.js');
  const { installProductUI } = await import('../js/ui/product-base.js');

  const store = new Store();
  const region = { id: '__text', section: '__text', vmAddr: 0x1000n, size: 0x4000n, exec: true };
  store.set({
    fileInfo: { name: 'game.bin', size: 8192, format: 'Mach-O', slices: [] },
    currentRegion: region,
    regions: [region],
    architecture: 'arm64',
    canDisassemble: true,
    symbolsReady: true,
  });

  const triggeredGoals = [];
  const app = {
    store,
    // Deliberately order low-relevance substring match at lower address BEFORE word-boundary / exact matches
    symbols: new SymbolIndex({
      addrs: new BigUint64Array([0x1000n, 0x2000n, 0x3000n]),
      kinds: new Uint8Array([0, 0, 0]),
      flags: new Uint8Array([1, 1, 1]),
      names: ['flushPlayer', 'getHP', 'HP'],
      funcs: new BigUint64Array([0x1000n, 0x2000n, 0x3000n]),
      regions: [region],
    }),
    goToAddress: () => true,
    showCandidates(goal) { triggeredGoals.push(goal); },
  };

  installProductUI(app);

  const dropdownList = doc.getElementById('ui-command-results');
  const omniboxInput = dropdownList?.parentNode?.querySelector('.ui-global-command');
  assert.ok(omniboxInput, 'top omnibox input should be mounted');
  omniboxInput.focus();
  omniboxInput.value = 'HP';
  omniboxInput.dispatchEvent({ type: 'input', target: omniboxInput });

  // Wait past the 80ms debounce timer + async refreshDropdown
  await new Promise((r) => setTimeout(r, 140));

  assert.ok(dropdownList && !dropdownList.hidden, 'omnibox dropdown should be visible');
  const items = dropdownList.querySelectorAll('.ui-command-result');
  assert.ok(items.length >= 4, `expected goal bridge + 3 ranked functions, got ${items.length}`);

  // 1. Goal bridge row must be prepended at index 0
  assert.ok(
    items[0].textContent.includes('目的として調べる: HP・体力'),
    `first dropdown row must be goal bridge, got: ${items[0].textContent}`,
  );

  // 2. Function hits must be ranked by 5.5 relevance: HP (exact) > getHP (word-boundary) > flushPlayer (substring)
  const fnTitles = items.slice(1).map((li) => li.querySelector('.ui-command-result-title')?.textContent);
  assert.deepEqual(fnTitles, ['HP', 'getHP', 'flushPlayer']);

  // 3. Clicking the top goal bridge row opens goal investigation
  items[0].click();
  assert.equal(triggeredGoals.length, 1);
  assert.equal(triggeredGoals[0].id, 'hp');
});
