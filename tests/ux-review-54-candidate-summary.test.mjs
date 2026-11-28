import test from 'node:test';
import assert from 'node:assert/strict';
import { setLang } from '../js/i18n.js';
import {
  buildGoalCandidateSummary,
  findGoalHighlightLines,
} from '../js/ui/function-analysis-presentation.js';

function installMinimalDom() {
  class FakeElement {
    constructor(tagName) {
      this.tagName = String(tagName || 'div').toUpperCase();
      this.className = '';
      this.children = [];
      this.parentNode = null;
      this.attributes = new Map();
      this.listeners = new Map();
      this.style = { setProperty() {}, removeProperty() {} };
      this.dataset = {};
      this.disabled = false;
      this.title = '';
      this.scrollIntoViewCalls = 0;
      this._textContent = '';
    }
    get childNodes() { return this.children; }
    get isConnected() {
      let cur = this;
      while (cur) {
        if (cur === body) return true;
        cur = cur.parentNode;
      }
      return false;
    }
    get classList() {
      const self = this;
      return {
        add(...cls) {
          const set = new Set(self.className.split(/\s+/).filter(Boolean));
          for (const c of cls) set.add(c);
          self.className = [...set].join(' ');
        },
        remove(...cls) {
          const set = new Set(self.className.split(/\s+/).filter(Boolean));
          for (const c of cls) set.delete(c);
          self.className = [...set].join(' ');
        },
        contains(c) {
          return self.className.split(/\s+/).filter(Boolean).includes(c);
        },
        toggle(c, force) {
          const has = this.contains(c);
          const next = force !== undefined ? !!force : !has;
          if (next) this.add(c); else this.remove(c);
          return next;
        },
      };
    }
    get textContent() {
      if (this.children.length === 0) return this._textContent;
      return this.children.map((c) => c.textContent).join('');
    }
    set textContent(val) {
      this._textContent = String(val ?? '');
      this.children = [];
    }
    append(...nodes) {
      for (const node of nodes) {
        if (node == null) continue;
        if (typeof node === 'string') {
          this._textContent += node;
          continue;
        }
        if (node.parentNode) node.remove();
        node.parentNode = this;
        this.children.push(node);
      }
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
    setAttribute(k, v) { this.attributes.set(k, String(v)); }
    getAttribute(k) { return this.attributes.get(k) ?? null; }
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
    click() {
      for (const fn of this.listeners.get('click') || []) fn({ target: this, preventDefault() {}, stopPropagation() {} });
    }
    focus() {}
    scrollIntoView() { this.scrollIntoViewCalls++; }
    querySelectorAll(selector) {
      const matches = [];
      const cls = selector.startsWith('.') ? selector.slice(1) : null;
      const tag = !cls ? selector.toUpperCase() : null;
      const walk = (node) => {
        for (const child of node.children) {
          if ((cls && child.classList.contains(cls)) || (tag && child.tagName === tag)) {
            matches.push(child);
          }
          walk(child);
        }
      };
      walk(this);
      return matches;
    }
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] ?? null;
    }
  }

  const body = new FakeElement('body');
  const sheetHost = new FakeElement('div');
  sheetHost.setAttribute('id', 'sheets');
  body.append(sheetHost);
  const doc = {
    body,
    documentElement: new FakeElement('html'),
    createElement: (tag) => new FakeElement(tag),
    createDocumentFragment: () => new FakeElement('fragment'),
    getElementById: (id) => (id === 'overlays' || id === 'sheets' ? sheetHost : null),
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  globalThis.document = doc;
  globalThis.window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    innerWidth: 1024,
    innerHeight: 768,
  };
  globalThis.requestAnimationFrame = (cb) => { cb(); return 1; };
  globalThis.cancelAnimationFrame = () => {};
  return { body, doc, sheetHost };
}

function flushMicrotasks(n = 8) {
  let p = Promise.resolve();
  for (let i = 0; i < n; i++) p = p.then(() => {});
  return p;
}

test('buildGoalCandidateSummary: summarizes field read/sub/store in plain Japanese and EN fallback', () => {
  const disasm = [
    'ldr x8, [x19, #0x48]',
    'sub x8, x8, x0',
    'str x8, [x19, #0x48]',
    'ret',
  ];

  setLang('ja');
  const jaSummary = buildGoalCandidateSummary({
    goal: { id: 'hp', ja: '体力 (HP)', en: 'Health (HP)' },
    disasm,
  });
  assert.ok(jaSummary, 'summary should be generated');
  assert.equal(jaSummary.hasContext, true);
  assert.equal(jaSummary.fieldOperations.length, 1);
  assert.equal(jaSummary.fieldOperations[0].base, 'x19');
  assert.equal(jaSummary.fieldOperations[0].offset, 0x48);
  assert.equal(jaSummary.fieldOperations[0].size, 8);
  assert.equal(jaSummary.fieldOperations[0].access, 'modify');
  assert.equal(jaSummary.fieldOperations[0].op, 'sub');
  assert.match(jaSummary.fieldOperations[0].text, /\[x19\+0x48\] から 8 バイト読み、減算して書き戻す/);
  assert.match(jaSummary.headline, /\[x19\+0x48\] から 8 バイト読み、減算して書き戻す/);

  setLang('en');
  const enSummary = buildGoalCandidateSummary({
    goal: { id: 'hp', ja: '体力 (HP)', en: 'Health (HP)' },
    disasm,
  });
  assert.ok(enSummary);
  assert.match(enSummary.fieldOperations[0].text, /Reads 8 bytes from \[x19\+0x48\], subtracts, and writes back/);
  assert.match(enSummary.headline, /Health \(HP\)/);
  setLang('ja');
});

test('buildGoalCandidateSummary: summarizes string refs, symbols, and pinpoint verdict', () => {
  setLang('ja');
  const summary = buildGoalCandidateSummary({
    goal: { text: 'ダメージ計算', free: true },
    candidate: {
      addr: 0x10040n,
      name: 'Player::applyDamage',
      strings: ['damage_multiplier', 'player_hurt_sfx'],
      reasons: [{ code: 'string-ref', detail: { text: 'damage_multiplier' } }],
    },
    pinpoint: {
      verdict: 'confirmed',
      top: {
        name: 'Player::applyDamage',
        className: 'Player',
        field: { name: '_hp', offset: 0x20, size: 4 },
        base: 'x0',
      },
    },
    pseudocode: [
      'void Player::applyDamage(Player *x0, int32_t dmg) {',
      '  int32_t cur = *(int32_t *)(x0 + 0x20);',
      '  *(int32_t *)(x0 + 0x20) = cur - dmg;',
      '  log_event("damage_multiplier");',
      '}',
    ].join('\n'),
  });

  assert.ok(summary);
  assert.equal(summary.verdict, 'confirmed');
  assert.equal(summary.verdictLabel, '確認済み');
  assert.ok(summary.matchedStrings.includes('damage_multiplier'));
  assert.ok(summary.matchedStrings.includes('player_hurt_sfx'));
  assert.ok(summary.matchedSymbols.some((s) => s.includes('applyDamage')));
  assert.ok(summary.bullets.some((b) => b.includes('関連文字列を参照') && b.includes('damage_multiplier')));
  assert.ok(summary.bullets.some((b) => b.includes('特定判定: 確認済み')));
  assert.ok(summary.fieldOperations.length >= 1);
  assert.equal(summary.fieldOperations[0].offset, 0x20);
  assert.equal(summary.fieldOperations[0].access, 'modify');
  assert.equal(summary.fieldOperations[0].op, 'sub');
});

test('buildGoalCandidateSummary: returns null when no context is provided', () => {
  assert.equal(buildGoalCandidateSummary(), null);
  assert.equal(buildGoalCandidateSummary({}), null);
});

test('findGoalHighlightLines: detects offset, dataflow arithmetic/store, string ref, and symbol call lines while ignoring unrelated lines', () => {
  const pseudocode = [
    'void sub_1000(int64_t x19, int64_t arg1) {',       // 0: signature (ignore)
    '  int32_t flags = *(int32_t *)(x19 + 0x10);',      // 1: unrelated offset 0x10 (ignore)
    '  if (flags == 0) {',                              // 2: unrelated branch (ignore)
    '    log_debug("startup_ok");',                     // 3: unrelated string (ignore)
    '  }',                                              // 4: brace (ignore)
    '  int64_t v3 = *(int64_t *)(x19 + 0x48);',         // 5: HIT (target offset 0x48 load -> taints v3)
    '  int64_t v4 = v3 - arg1;',                        // 6: HIT (arithmetic touching tainted v3 -> taints v4)
    '  *(int64_t *)(x19 + 0x48) = v4;',                 // 7: HIT (target offset 0x48 store)
    '  notify_hud("hp_updated");',                      // 8: HIT (goal string "hp_updated")
    '  Player::onHealthChanged(x19, v4);',              // 9: HIT (goal symbol call)
    '  other_helper(flags);',                           // 10: unrelated call (ignore)
    '  return;',                                        // 11: unrelated return (ignore)
    '}',                                                // 12: brace (ignore)
  ].join('\n');

  const lines = findGoalHighlightLines(pseudocode, {
    goal: { id: 'hp', ja: '体力 (HP)', en: 'health hp' },
    pinpoint: {
      verdict: 'likely',
      top: { base: 'x19', offset: 0x48, size: 8 },
    },
    candidate: {
      strings: ['hp_updated'],
      callees: ['Player::onHealthChanged'],
    },
  });

  assert.deepEqual(lines, [5, 6, 7, 8, 9]);
  assert.equal(lines.includes(0), false, 'signature line should not be highlighted');
  assert.equal(lines.includes(1), false, 'unrelated offset 0x10 should not be highlighted');
  assert.equal(lines.includes(3), false, 'unrelated string literal should not be highlighted');
  assert.equal(lines.includes(10), false, 'unrelated helper call should not be highlighted');
});

test('findGoalHighlightLines: detects pinpoint site addresses in structured lines and comments', () => {
  const structured = [
    { text: 'void sub_2000(int64_t x0) {', addr: 0x2000n },
    { text: '  int32_t a = 1;', addr: 0x2004n },
    { text: '  int32_t b = a + 2;', addr: 0x2018n },
    { text: '  return;', addr: 0x2020n },
    { text: '}', addr: 0x2024n },
  ];

  const hits = findGoalHighlightLines(structured, {
    pinpoint: {
      sites: [{ addr: 0x2018n }],
    },
  });
  assert.deepEqual(hits, [2]);
});

test('showFunctionSummary renders goal summary banner, highlights matching lines, and wires jump-to-match button', async () => {
  setLang('ja');
  const { body } = installMinimalDom();
  const { showFunctionSummary } = await import('../js/ui/panels/function-analysis.js');

  const pseudocode = [
    'void sub_4000(int64_t x19, int64_t dmg) {',
    '  int32_t a = *(int32_t *)(x19 + 0x08);',
    '  int32_t b = a + 1;',
    '  if (b < 0) return;',
    '  log_trace("unrelated");',
    '  int64_t cur = *(int64_t *)(x19 + 0x48);',
    '  int64_t next = cur - dmg;',
    '  *(int64_t *)(x19 + 0x48) = next;',
    '  return;',
    '}',
  ].join('\n');

  const fileInfo = { name: 'game.bin' };
  const app = {
    backend: { gen: 1 },
    store: {
      get: (k) => {
        if (k === 'currentRegion') return { id: 'text', vmAddr: 0x4000n, size: 0x100n };
        if (k === 'fileInfo') return fileInfo;
        if (k === 'architecture') return 'arm64';
        return null;
      },
    },
    viewer: { rowAddress: () => 0x4000n },
    lastGoalContext: {
      targetAddr: 0x4000n,
      goal: { id: 'hp', ja: '体力 (HP)', en: 'Health' },
      pinpoint: {
        verdict: 'confirmed',
        top: { base: 'x19', offset: 0x48, size: 8 },
      },
      disasm: [
        'ldr x8, [x19, #0x48]',
        'sub x8, x8, x1',
        'str x8, [x19, #0x48]',
      ],
    },
    analysisQueries: {
      snapshot: async () => ({ id: 'snap-1' }),
      function: async () => ({
        completeness: 'complete',
        status: null,
        value: {
          name: 'sub_4000',
          startAddress: 0x4000n,
          endAddress: 0x4040n,
          architectureId: 'arm64',
          decompiler: {
            signature: 'void sub_4000(int64_t x19, int64_t dmg)',
            pseudocode,
          },
        },
      }),
    },
  };

  showFunctionSummary(app, 0);
  await flushMicrotasks();

  const banner = body.querySelector('.goal-candidate-summary');
  assert.ok(banner, 'goal summary banner should be rendered');
  assert.match(banner.textContent, /\[x19\+0x48\] から 8 バイト読み、減算して書き戻す/);
  assert.match(banner.textContent, /確認済み/);

  const highlighted = body.querySelectorAll('.hex-goal-highlight');
  assert.equal(highlighted.length, 3, 'lines 5, 6, 7 should be highlighted');
  assert.deepEqual(
    highlighted.map((node) => Number(node.getAttribute('data-line-index'))),
    [5, 6, 7],
  );
  assert.ok(highlighted[0].style.borderLeft, 'highlighted line should have left accent border style');

  const jumpBtn = body.querySelector('.goal-jump-btn');
  assert.ok(jumpBtn, 'jump button should be rendered when highlight is further down');
  assert.equal(jumpBtn.textContent, '該当箇所へ移動');
  assert.equal(highlighted[0].scrollIntoViewCalls, 0);
  jumpBtn.click();
  assert.equal(highlighted[0].scrollIntoViewCalls, 1, 'clicking jump button should scroll to first highlighted line');
});

test('showFunctionSummary omits goal banner and highlights when no goal context is active', async () => {
  setLang('ja');
  const { body } = installMinimalDom();
  const { showFunctionSummary } = await import('../js/ui/panels/function-analysis.js');

  const fileInfo = { name: 'game.bin' };
  const app = {
    backend: { gen: 1 },
    store: {
      get: (k) => {
        if (k === 'currentRegion') return { id: 'text', vmAddr: 0x5000n, size: 0x40n };
        if (k === 'fileInfo') return fileInfo;
        if (k === 'architecture') return 'arm64';
        return null;
      },
    },
    viewer: { rowAddress: () => 0x5000n },
    analysisQueries: {
      snapshot: async () => ({ id: 'snap-2' }),
      function: async () => ({
        completeness: 'complete',
        status: null,
        value: {
          name: 'sub_5000',
          startAddress: 0x5000n,
          endAddress: 0x5020n,
          architectureId: 'arm64',
          decompiler: {
            signature: 'int sub_5000(void)',
            pseudocode: 'int sub_5000(void) {\n  return 0;\n}',
          },
        },
      }),
    },
  };

  showFunctionSummary(app, 0);
  await flushMicrotasks();

  assert.equal(body.querySelector('.goal-candidate-summary'), null);
  assert.equal(body.querySelectorAll('.hex-goal-highlight').length, 0);
});

test('showFunctionSummary renders highlighted line past line 240 and jump-to-match scrolls to it', async () => {
  setLang('ja');
  const { body } = installMinimalDom();
  const { showFunctionSummary } = await import('../js/ui/panels/function-analysis.js');

  const lines = ['void sub_6000(int64_t x19, int64_t dmg) {'];
  for (let i = 1; i < 260; i++) {
    lines.push(`  int32_t pad_${i} = ${i};`);
  }
  lines.push('  int64_t cur = *(int64_t *)(x19 + 0x48);'); // line 260
  lines.push('  int64_t next = cur - dmg;');              // line 261
  lines.push('  *(int64_t *)(x19 + 0x48) = next;');       // line 262
  for (let i = 263; i < 299; i++) {
    lines.push(`  int32_t tail_${i} = ${i};`);
  }
  lines.push('}');
  const pseudocode = lines.join('\n');

  const fileInfo = { name: 'game.bin' };
  const app = {
    backend: { gen: 1 },
    store: {
      get: (k) => {
        if (k === 'currentRegion') return { id: 'text', vmAddr: 0x6000n, size: 0x400n };
        if (k === 'fileInfo') return fileInfo;
        if (k === 'architecture') return 'arm64';
        return null;
      },
    },
    viewer: { rowAddress: () => 0x6000n },
    lastGoalContext: {
      targetAddr: 0x6000n,
      goal: { id: 'hp', ja: '体力 (HP)', en: 'Health' },
      pinpoint: {
        verdict: 'confirmed',
        top: { base: 'x19', offset: 0x48, size: 8 },
      },
    },
    analysisQueries: {
      snapshot: async () => ({ id: 'snap-260' }),
      function: async () => ({
        completeness: 'complete',
        status: null,
        value: {
          name: 'sub_6000',
          startAddress: 0x6000n,
          endAddress: 0x6400n,
          architectureId: 'arm64',
          decompiler: {
            signature: 'void sub_6000(int64_t x19, int64_t dmg)',
            pseudocode,
          },
        },
      }),
    },
  };

  showFunctionSummary(app, 0);
  await flushMicrotasks();

  const highlighted = body.querySelectorAll('.hex-goal-highlight');
  assert.ok(highlighted.length >= 3, 'lines past 240 should still be rendered and highlighted');
  assert.equal(Number(highlighted[0].getAttribute('data-line-index')), 260);

  const jumpBtn = body.querySelector('.goal-jump-btn');
  assert.ok(jumpBtn, 'jump button should be rendered when highlight at line 260 is rendered');
  assert.equal(highlighted[0].scrollIntoViewCalls, 0);
  jumpBtn.click();
  assert.equal(highlighted[0].scrollIntoViewCalls, 1, 'clicking jump button must scroll to the rendered line 260');
});

test('end-to-end: clicking a candidate in showCandidates sets app.lastGoalContext and renders banner + highlights in function summary & product pseudocode', async () => {
  setLang('ja');
  const { body, doc } = installMinimalDom();
  // Add minimal product shell elements and DOM helpers needed by installProductUI
  const appRoot = doc.createElement('div');
  appRoot.setAttribute('id', 'app');
  const titlebar = doc.createElement('div');
  titlebar.className = 'titlebar';
  const btnOpen = doc.createElement('button');
  btnOpen.setAttribute('id', 'btn-open');
  titlebar.append(btnOpen);
  const fileInput = doc.createElement('input');
  fileInput.setAttribute('id', 'file-input');
  const viewerEl = doc.createElement('div');
  viewerEl.setAttribute('id', 'viewer');
  const overlays = doc.getElementById('overlays');
  overlays.setAttribute('id', 'overlays');
  appRoot.append(titlebar, fileInput, viewerEl, overlays);
  body.append(appRoot);

  // Enhance FakeElement prototype slightly for product-base.js DOM operations
  const ElProto = Object.getPrototypeOf(appRoot);
  if (!ElProto.prepend) {
    ElProto.prepend = function prepend(...nodes) {
      for (let i = nodes.length - 1; i >= 0; i--) {
        const node = nodes[i];
        if (node == null) continue;
        if (typeof node === 'string') {
          this._textContent = node + this._textContent;
          continue;
        }
        if (node.parentNode) node.remove();
        node.parentNode = this;
        this.children.unshift(node);
      }
    };
  }
  if (!ElProto.before) {
    ElProto.before = function before(...nodes) {
      if (!this.parentNode) return;
      const idx = this.parentNode.children.indexOf(this);
      if (idx < 0) return;
      for (const node of nodes) {
        if (node == null || typeof node === 'string') continue;
        if (node.parentNode) node.remove();
        node.parentNode = this.parentNode;
        this.parentNode.children.splice(idx, 0, node);
      }
    };
  }
  if (!ElProto.after) {
    ElProto.after = function after(...nodes) {
      if (!this.parentNode) return;
      let idx = this.parentNode.children.indexOf(this) + 1;
      for (const node of nodes) {
        if (node == null || typeof node === 'string') continue;
        if (node.parentNode) node.remove();
        node.parentNode = this.parentNode;
        this.parentNode.children.splice(idx++, 0, node);
      }
    };
  }
  if (!ElProto.removeAttribute) {
    ElProto.removeAttribute = function removeAttribute(k) { this.attributes.delete(k); };
  }
  if (!ElProto.hasAttribute) {
    ElProto.hasAttribute = function hasAttribute(k) { return this.attributes.has(k); };
  }
  if (!ElProto.contains) {
    ElProto.contains = function contains(other) {
      if (other === this) return true;
      for (const c of this.children) if (c.contains?.(other)) return true;
      return false;
    };
  }
  if (!Object.getOwnPropertyDescriptor(ElProto, 'id')) {
    Object.defineProperty(ElProto, 'id', {
      get() { return this.attributes.get('id') || ''; },
      set(v) { this.attributes.set('id', String(v)); },
    });
  }
  doc.getElementById = (id) => {
    const walk = (n) => {
      if (n.attributes?.get('id') === id) return n;
      for (const c of n.children || []) {
        const hit = walk(c);
        if (hit) return hit;
      }
      return null;
    };
    return walk(body);
  };
  doc.querySelector = (sel) => body.querySelector(sel);
  doc.querySelectorAll = (sel) => body.querySelectorAll(sel);
  doc.createTextNode = (t) => String(t ?? '');
  doc.createElementNS = (_ns, tag) => doc.createElement(tag);
  globalThis.window.location = { href: 'https://hex.test/', pathname: '/', search: '', hash: '#/investigate' };
  globalThis.window.history = {
    state: null,
    pushState(s, _t, u) { this.state = s; globalThis.window.location.hash = String(u).includes('#') ? String(u).slice(String(u).indexOf('#')) : ''; },
    replaceState(s, _t, u) { this.state = s; globalThis.window.location.hash = String(u).includes('#') ? String(u).slice(String(u).indexOf('#')) : ''; },
  };
  globalThis.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.location = globalThis.window.location;
  globalThis.history = globalThis.window.history;

  const { showCandidates } = await import('../js/ui/panels/investigation.js');
  const { showFunctionSummary } = await import('../js/ui/panels/function-analysis.js');
  const { investigationServiceFor } = await import('../js/analysis/investigation-service.js');
  const { installProductUI } = await import('../js/ui/product-base.js');
  const { Store } = await import('../js/state.js');

  const pseudocode = [
    'void Player::takeDamage(int64_t x19, int64_t dmg) {',
    '  int32_t a = *(int32_t *)(x19 + 0x08);',
    '  int32_t b = a + 1;',
    '  if (b < 0) return;',
    '  log_trace("unrelated");',
    '  int64_t cur = *(int64_t *)(x19 + 0x48);',
    '  int64_t next = cur - dmg;',
    '  *(int64_t *)(x19 + 0x48) = next;',
    '  return;',
    '}',
  ].join('\n');

  const store = new Store();
  const region = { id: '__text', section: '__text', vmAddr: 0x4000n, size: 0x400n, exec: true };
  store.set({
    fileInfo: { name: 'game.bin', size: 4096, format: 'Mach-O', slices: [] },
    currentRegion: region,
    regions: [region],
    architecture: 'arm64',
    canDisassemble: true,
    symbolsReady: true,
  });

  const app = {
    backend: { gen: 1 },
    store,
    symbols: {
      nameAt: (a) => (BigInt(a) === 0x4000n ? 'Player::takeDamage' : null),
      functionAt: (a) => (BigInt(a) === 0x4000n ? { addr: 0x4000n, size: 0x40n, name: 'Player::takeDamage' } : null),
    },
    viewer: {
      rowAddress: () => 0x4000n,
      rowOfAddress: () => 0,
      isVariableAsm: () => false,
    },
    goToAddress: () => true,
    goToFunction: () => true,
    analysisQueries: {
      snapshot: async () => ({ id: 'snap-e2e' }),
      function: async () => ({
        completeness: 'complete',
        status: null,
        value: {
          name: 'Player::takeDamage',
          startAddress: 0x4000n,
          endAddress: 0x4040n,
          architectureId: 'arm64',
          decompiler: {
            signature: 'void Player::takeDamage(int64_t x19, int64_t dmg)',
            pseudocode,
          },
        },
      }),
      decompile: async () => ({
        completeness: 'complete',
        status: null,
        value: {
          signature: 'void Player::takeDamage(int64_t x19, int64_t dmg)',
          pseudocode,
          lines: pseudocode.split('\n').map((l, idx) => ({
            kind: idx === 0 ? 'sig' : 'stmt',
            indent: 0,
            text: l,
          })),
        },
      }),
    },
  };

  // Mount product UI so window.__hexUi.router is active
  installProductUI(app);

  // Stub investigationServiceFor(app).investigate to return a ranked candidate + pinpoint
  const svc = investigationServiceFor(app);
  const goal = { id: 'hp', ja: 'HP・体力', en: 'Health (HP)' };
  const candidate = {
    addr: 0x4000n,
    name: 'Player::takeDamage',
    reasons: [{ code: 'string-ref', detail: { text: 'hp_max' } }],
  };
  const pin = {
    verdict: 'confirmed',
    top: { addr: 0x4000n, base: 'x19', offset: 0x48, size: 8 },
  };
  svc.investigate = async () => ({
    completeness: { complete: true, reasons: [] },
    ranked: { candidates: [candidate] },
    pin,
    context: { fields: null },
  });

  // No manual app.lastGoalContext injection!
  assert.equal(app.lastGoalContext, undefined);

  showCandidates(app, goal);
  await flushMicrotasks(12);

  // Click the ranked candidate row in showCandidates
  const candidateRows = body.querySelectorAll('.tappable');
  assert.ok(candidateRows.length >= 1, 'showCandidates should render ranked candidate row');
  candidateRows[0].click();
  await flushMicrotasks(16);

  // 1. Clicking candidate must set app.lastGoalContext automatically
  assert.ok(app.lastGoalContext, 'clicking candidate in showCandidates must set app.lastGoalContext');
  assert.equal(app.lastGoalContext.targetAddr, 0x4000n);
  assert.equal(app.lastGoalContext.goal, goal);
  assert.equal(app.lastGoalContext.candidate, candidate);
  assert.equal(app.lastGoalContext.pinpoint, pin);
  assert.equal(typeof app.lastGoalContext.setAt, 'number');

  // 2. Product pseudocode view (navigated to /function/16384/pseudocode) must render banner + highlights + jump button
  const routeHost = doc.getElementById('ui-route-host');
  const productBanner = routeHost.querySelector('.goal-candidate-summary');
  assert.ok(productBanner, 'product pseudocode view should render 5.4 goal summary banner');
  assert.match(productBanner.textContent, /HP・体力/);
  const productHighlights = routeHost.querySelectorAll('.hex-goal-highlight');
  assert.ok(productHighlights.length >= 3, 'product pseudocode view should highlight matching lines');
  const productJump = routeHost.querySelector('.goal-jump-btn');
  assert.ok(productJump, 'product pseudocode view should render 該当箇所へ移動 jump button');
  assert.equal(productJump.textContent, '該当箇所へ移動');
  productJump.click();
  assert.equal(productHighlights[0].scrollIntoViewCalls, 1, 'clicking product jump button should scroll to first highlighted line');

  // 3. showFunctionSummary also picks up app.lastGoalContext without manual injection
  showFunctionSummary(app, 0);
  await flushMicrotasks(12);
  const summaryBanners = body.querySelectorAll('.goal-candidate-summary');
  assert.ok(summaryBanners.length >= 2, 'showFunctionSummary should also render goal summary banner from app.lastGoalContext');
});
