import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderBeginnerWorkflowPanel } from '../js/ui/beginner/beginner-workflow-panel.js';
import { AUTO_ANALYSIS_STATUS, PATCH_RISK_LEVEL } from '../js/analysis/common/v6-auto-contracts.js';
import { lang, setLang } from '../js/i18n.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PANEL_SOURCE_PATH = path.resolve(__dirname, '../js/ui/beginner/beginner-workflow-panel.js');
const INITIAL_LANG = lang();

afterEach(() => {
  setLang(INITIAL_LANG);
});

/**
 * Minimal DOM mock with strict forbidden-HTML traps and listener leak tracking.
 */
function createMockDom({ supportReplaceChildren = true } = {}) {
  const stats = {
    forbiddenAccesses: [],
    addedListeners: 0,
    removedListeners: 0,
    activeListeners: new Set(),
    createdElements: [],
  };

  class MockElement {
    constructor(tagName, ownerDocument) {
      this.tagName = String(tagName).toUpperCase();
      this.ownerDocument = ownerDocument;
      this.className = '';
      this.textContent = '';
      this.parentNode = null;
      this.children = [];
      this.attributes = new Map();
      this._listeners = new Map();

      if (supportReplaceChildren) {
        this.replaceChildren = (...nodes) => {
          for (const child of this.children) {
            child.parentNode = null;
          }
          this.children.length = 0;
          for (const node of nodes) {
            this.appendChild(node);
          }
        };
      }
    }

    get firstChild() {
      return this.children.length > 0 ? this.children[0] : null;
    }

    get childNodes() {
      return this.children;
    }

    setAttribute(name, value) {
      this.attributes.set(String(name), String(value));
    }

    getAttribute(name) {
      return this.attributes.has(name) ? this.attributes.get(name) : null;
    }

    appendChild(child) {
      if (child.parentNode && child.parentNode !== this) {
        child.parentNode.removeChild(child);
      }
      child.parentNode = this;
      this.children.push(child);
      return child;
    }

    removeChild(child) {
      const idx = this.children.indexOf(child);
      if (idx === -1) {
        throw new Error('Child not found');
      }
      this.children.splice(idx, 1);
      child.parentNode = null;
      return child;
    }

    addEventListener(type, handler) {
      let list = this._listeners.get(type);
      if (!list) {
        list = [];
        this._listeners.set(type, list);
      }
      list.push(handler);
      stats.addedListeners++;
      stats.activeListeners.add({ target: this, type, handler });
    }

    removeEventListener(type, handler) {
      const list = this._listeners.get(type);
      if (list) {
        const idx = list.indexOf(handler);
        if (idx !== -1) {
          list.splice(idx, 1);
        }
      }
      stats.removedListeners++;
      for (const entry of stats.activeListeners) {
        if (entry.target === this && entry.type === type && entry.handler === handler) {
          stats.activeListeners.delete(entry);
          break;
        }
      }
    }

    click() {
      const list = this._listeners.get('click') || [];
      for (const fn of [...list]) {
        fn({ type: 'click', target: this, currentTarget: this });
      }
    }

    // Forbidden HTML injection traps
    get innerHTML() {
      stats.forbiddenAccesses.push('get innerHTML');
      throw new Error('Forbidden access: innerHTML');
    }

    set innerHTML(_v) {
      stats.forbiddenAccesses.push('set innerHTML');
      throw new Error('Forbidden assignment: innerHTML');
    }

    get outerHTML() {
      stats.forbiddenAccesses.push('get outerHTML');
      throw new Error('Forbidden access: outerHTML');
    }

    set outerHTML(_v) {
      stats.forbiddenAccesses.push('set outerHTML');
      throw new Error('Forbidden assignment: outerHTML');
    }

    insertAdjacentHTML() {
      stats.forbiddenAccesses.push('insertAdjacentHTML');
      throw new Error('Forbidden call: insertAdjacentHTML');
    }
  }

  const doc = {
    createElement(tag) {
      const el = new MockElement(tag, doc);
      stats.createdElements.push(el);
      return el;
    },
    write() {
      stats.forbiddenAccesses.push('document.write');
      throw new Error('Forbidden call: document.write');
    },
  };

  const container = doc.createElement('div');
  return { doc, container, stats };
}

function collectNodes(root, predicate = () => true) {
  const result = [];
  function walk(node) {
    if (!node) return;
    if (predicate(node)) result.push(node);
    for (const child of node.children || []) {
      walk(child);
    }
  }
  walk(root);
  return result;
}

function collectAllText(root) {
  return collectNodes(root)
    .map((n) => n.textContent || '')
    .filter(Boolean)
    .join('\n');
}

function makeSampleModel(overrides = {}) {
  return {
    progress: {
      overallStatus: AUTO_ANALYSIS_STATUS.RUNNING,
      percent: 67,
      isComplete: false,
      headline: '自動解析を実行中です',
      nextAction: '重要度の高い関数から確認できます',
      phases: [
        { id: 'til', label: '型ライブラリ (TIL)', status: AUTO_ANALYSIS_STATUS.DONE, detail: '2 packs' },
        { id: 'hexsig', label: 'ライブラリ関数照合', status: AUTO_ANALYSIS_STATUS.RUNNING, completed: 10, total: 20, detail: '' },
        { id: 'deobf', label: '難読化解除', status: AUTO_ANALYSIS_STATUS.IDLE, detail: '' },
      ],
    },
    starterFunctions: [
      {
        vaHex: '0x100004000',
        displayName: 'main',
        score: 95,
        reason: 'プログラムの開始地点です',
        category: 'entrypoint',
      },
      {
        vaHex: '0x100008120',
        displayName: 'decrypt_payload',
        score: 82,
        reason: '暗号処理パターンを検出しました',
        category: 'crypto',
      },
    ],
    activeCard: {
      headline: 'main — 初期化とディスパッチ',
      whatItDoes: ['設定を読み込みます', 'メイン処理を呼び出します'],
      patchImpact: 'ここを変更するとアプリ全体の起動に影響します',
      v6Highlights: ['HexSig で標準ライブラリ関数を識別しました'],
      glossaryMatches: ['entrypoint', 'cfg'],
    },
    patchRisk: {
      level: PATCH_RISK_LEVEL.MEDIUM,
      score: 48,
      reasons: ['複数の関数から参照されています'],
      cautions: ['スタックフレームの整合性に注意してください'],
      glossaryKeys: ['stack_frame'],
      isFailSafe: false,
    },
    glossaryEntries: [
      {
        key: 'cff',
        term: '制御フロー平坦化 (CFF)',
        shortLabel: 'CFF',
        explanation: '分岐構造を大きな switch ループに隠す難読化手法です。',
        tip: '状態変数の遷移を追うと元の流れが見えます。',
      },
      {
        key: 'pac',
        term: 'ポインタ認証 (PAC)',
        shortLabel: 'PAC',
        explanation: 'ARM64e でポインタ改ざんを検出する仕組みです。',
        tip: 'paciasp / autiasp 周辺は慎重に扱ってください。',
      },
    ],
    ...overrides,
  };
}

describe('v6-beginner-workflow-panel (Track 8)', () => {
  it('source code contains zero forbidden HTML injection APIs and zero forbidden imports (INV-005)', () => {
    const src = fs.readFileSync(PANEL_SOURCE_PATH, 'utf8');
    const forbiddenTokens = [
      'inner' + 'HTML',
      'outer' + 'HTML',
      'insertAdjacent' + 'HTML',
      'document.' + 'write',
    ];
    for (const token of forbiddenTokens) {
      assert.equal(src.includes(token), false, `Source must not contain ${token}`);
    }
    assert.equal(/js\/targets\/architecture\//.test(src), false, 'Must not import architecture modules');
    assert.equal(/js\/semantics\//.test(src), false, 'Must not import semantics modules');
    assert.equal(/targets\/architecture/.test(src), false, 'Must not reference targets/architecture');
  });

  it('never touches innerHTML/outerHTML/insertAdjacentHTML/document.write at runtime', () => {
    const { doc, container, stats } = createMockDom();
    const handle = renderBeginnerWorkflowPanel(container, makeSampleModel(), { doc });
    handle.update(makeSampleModel({ activeCard: { headline: 'updated', whatItDoes: 'single line', patchImpact: 'low' } }));
    handle.destroy();

    assert.deepEqual(stats.forbiddenAccesses, []);
  });

  it('neutralizes XSS payloads across all model fields as inert textContent', () => {
    const { doc, container, stats } = createMockDom();
    const xss1 = '<script>window.__pwned=1</script>';
    const xss2 = '<img src=x onerror="alert(2)">';
    const xss3 = '"><svg onload=alert(3)>';

    const maliciousModel = makeSampleModel({
      progress: {
        overallStatus: AUTO_ANALYSIS_STATUS.DONE,
        percent: 100,
        isComplete: true,
        headline: xss1,
        nextAction: xss2,
        phases: [{ id: 'til', label: xss3, status: AUTO_ANALYSIS_STATUS.DONE, detail: xss1 }],
      },
      starterFunctions: [
        { vaHex: '0x1000', displayName: xss2, score: 50, reason: xss3, category: 'app_logic' },
      ],
      activeCard: {
        headline: xss1,
        whatItDoes: [xss2, xss3],
        patchImpact: xss1,
        v6Highlights: [xss2],
        glossaryMatches: [xss3],
      },
      patchRisk: {
        level: PATCH_RISK_LEVEL.HIGH,
        score: 90,
        reasons: [xss1],
        cautions: [xss2],
        glossaryKeys: ['pac'],
        isFailSafe: false,
      },
      glossaryEntries: [
        { key: 'cff', term: xss1, shortLabel: xss2, explanation: xss3, tip: xss1 },
      ],
    });

    const handle = renderBeginnerWorkflowPanel(container, maliciousModel, { doc });
    assert.deepEqual(stats.forbiddenAccesses, []);

    const allNodes = collectNodes(handle.root);
    const forbiddenTags = new Set(['SCRIPT', 'IMG', 'SVG', 'IFRAME', 'OBJECT']);
    for (const node of allNodes) {
      assert.equal(forbiddenTags.has(node.tagName), false, `Unexpected tag created: ${node.tagName}`);
      for (const attrName of node.attributes.keys()) {
        assert.equal(/^on/i.test(attrName), false, `Event handler attribute must never be set: ${attrName}`);
      }
    }

    const fullText = collectAllText(handle.root);
    assert.ok(fullText.includes(xss1), 'XSS string 1 should be preserved literally in textContent');
    assert.ok(fullText.includes(xss2), 'XSS string 2 should be preserved literally in textContent');
    assert.ok(fullText.includes(xss3), 'XSS string 3 should be preserved literally in textContent');

    handle.destroy();
  });

  it('renders activeCard.whatItDoes both as string array and as plain string', () => {
    const { doc, container } = createMockDom();
    const handle = renderBeginnerWorkflowPanel(
      container,
      makeSampleModel({
        activeCard: {
          headline: 'Array card',
          whatItDoes: ['First step', 'Second step', 'Third step'],
          patchImpact: 'Moderate',
        },
      }),
      { doc },
    );

    const listEl = collectNodes(handle.root, (n) => n.getAttribute('data-field') === 'what-it-does')[0];
    assert.ok(listEl);
    assert.equal(listEl.tagName, 'UL');
    assert.equal(listEl.children.length, 3);
    assert.equal(listEl.children[0].textContent, 'First step');
    assert.equal(listEl.children[2].textContent, 'Third step');

    handle.update(
      makeSampleModel({
        activeCard: {
          headline: 'String card',
          whatItDoes: 'Single paragraph explanation.',
          patchImpact: 'Low',
        },
      }),
    );

    const paraEl = collectNodes(handle.root, (n) => n.getAttribute('data-field') === 'what-it-does')[0];
    assert.ok(paraEl);
    assert.equal(paraEl.tagName, 'P');
    assert.equal(paraEl.textContent, 'Single paragraph explanation.');

    handle.destroy();
  });

  it('renders empty states cleanly for null, empty, and partially missing models', () => {
    const { doc, container } = createMockDom();
    const handle = renderBeginnerWorkflowPanel(container, null, { doc });

    const emptyNodes = collectNodes(handle.root, (n) => n.getAttribute('data-empty') !== null);
    const emptyKeys = emptyNodes.map((n) => n.getAttribute('data-empty')).sort();
    assert.deepEqual(emptyKeys, ['active-card', 'glossary', 'patch-risk', 'progress', 'starter-functions']);

    handle.update({});
    const emptyNodesAfter = collectNodes(handle.root, (n) => n.getAttribute('data-empty') !== null);
    assert.equal(emptyNodesAfter.length, 5);

    handle.destroy();
  });

  it('handles null/invalid container and minimal mock DOM without replaceChildren safely', () => {
    const noop1 = renderBeginnerWorkflowPanel(null, makeSampleModel());
    assert.equal(noop1.root, null);
    assert.doesNotThrow(() => noop1.update(makeSampleModel()));
    assert.doesNotThrow(() => noop1.destroy());

    const noop2 = renderBeginnerWorkflowPanel(undefined, null);
    assert.equal(noop2.root, null);

    // Minimal mock DOM without replaceChildren
    const { doc, container, stats } = createMockDom({ supportReplaceChildren: false });
    const handle = renderBeginnerWorkflowPanel(container, makeSampleModel(), { doc });
    assert.equal(container.children.length, 1);
    assert.ok(stats.activeListeners.size > 0);

    handle.update(makeSampleModel({ starterFunctions: [] }));
    assert.equal(container.children.length, 1);

    handle.destroy();
    assert.equal(container.children.length, 0);
    assert.equal(stats.activeListeners.size, 0);
  });

  it('invokes onSelectFunction(vaHex) and onSelectGlossary(key) with exact arguments and isolates callback errors', () => {
    const { doc, container } = createMockDom();
    const fnCalls = [];
    const glossaryCalls = [];

    const handle = renderBeginnerWorkflowPanel(container, makeSampleModel(), {
      doc,
      onSelectFunction(...args) {
        fnCalls.push(args);
        throw new Error('simulated callback failure');
      },
      onSelectGlossary(...args) {
        glossaryCalls.push(args);
        throw new Error('simulated glossary failure');
      },
    });

    const fnBtns = collectNodes(handle.root, (n) => n.tagName === 'BUTTON' && n.getAttribute('data-va-hex') !== null);
    assert.equal(fnBtns.length, 2);
    assert.doesNotThrow(() => fnBtns[0].click());
    assert.doesNotThrow(() => fnBtns[1].click());
    assert.deepEqual(fnCalls, [['0x100004000'], ['0x100008120']]);

    const glossaryBtns = collectNodes(handle.root, (n) => n.tagName === 'BUTTON' && n.getAttribute('data-glossary-key') !== null);
    // 2 from activeCard.glossaryMatches + 2 from glossaryEntries
    assert.equal(glossaryBtns.length, 4);
    for (const btn of glossaryBtns) {
      assert.doesNotThrow(() => btn.click());
    }
    assert.deepEqual(glossaryCalls, [['entrypoint'], ['cfg'], ['cff'], ['pac']]);

    handle.destroy();
  });

  it('releases all listeners across multiple update() calls and destroy(), and guards update() as no-op after destroy()', () => {
    const { doc, container, stats } = createMockDom();
    const handle = renderBeginnerWorkflowPanel(container, makeSampleModel(), { doc });

    // Initial: 2 starter buttons + 2 glossary match chips + 2 glossary entry buttons = 6
    assert.equal(stats.activeListeners.size, 6);

    // Update 1: fewer buttons (1 starter + 0 glossaryMatches + 1 glossaryEntry = 2)
    handle.update(
      makeSampleModel({
        starterFunctions: [{ vaHex: '0x2000', displayName: 'fn_a', score: 10, reason: 'r', category: 'app_logic' }],
        activeCard: { headline: 'h', whatItDoes: 'w', patchImpact: 'p' },
        glossaryEntries: [{ key: 'til', term: 'TIL', shortLabel: 'TIL', explanation: 'e', tip: '' }],
      }),
    );
    assert.equal(stats.activeListeners.size, 2);

    // Update 2: zero interactive items
    handle.update({
      progress: null,
      starterFunctions: [],
      activeCard: null,
      patchRisk: null,
      glossaryEntries: [],
    });
    assert.equal(stats.activeListeners.size, 0);

    // Update 3: add items back
    handle.update(makeSampleModel());
    assert.equal(stats.activeListeners.size, 6);

    // Destroy must remove all listeners and clear container
    handle.destroy();
    assert.equal(stats.activeListeners.size, 0);
    assert.equal(stats.addedListeners, stats.removedListeners);
    assert.equal(container.children.length, 0);

    // Idempotent destroy
    assert.doesNotThrow(() => handle.destroy());
    assert.equal(stats.activeListeners.size, 0);

    // Post-destroy update() must be a strict no-op
    handle.update(makeSampleModel());
    assert.equal(stats.activeListeners.size, 0);
    assert.equal(container.children.length, 0);
    assert.equal(handle.root.children.length, 0);
  });

  it('protects against listener leaks when re-mounting on the same container without calling destroy()', () => {
    const { doc, container, stats } = createMockDom();
    const firstCalls = [];
    const secondCalls = [];

    const firstHandle = renderBeginnerWorkflowPanel(container, makeSampleModel(), {
      doc,
      onSelectFunction(va) {
        firstCalls.push(va);
      },
    });
    assert.equal(stats.activeListeners.size, 6);

    // Re-mount directly onto the same container without destroying firstHandle
    const secondHandle = renderBeginnerWorkflowPanel(
      container,
      makeSampleModel({
        starterFunctions: [{ vaHex: '0x9999', displayName: 'new_fn', score: 50, reason: 'new', category: 'entrypoint' }],
        activeCard: null,
        glossaryEntries: [],
      }),
      {
        doc,
        onSelectFunction(va) {
          secondCalls.push(va);
        },
      },
    );

    // Only the new panel's single button listener should remain active
    assert.equal(stats.activeListeners.size, 1);
    assert.equal(container.children.length, 1);
    assert.equal(container.children[0], secondHandle.root);

    // Old handle update() must be no-op because it was auto-destroyed
    firstHandle.update(makeSampleModel());
    assert.equal(stats.activeListeners.size, 1);

    const activeBtns = collectNodes(secondHandle.root, (n) => n.tagName === 'BUTTON' && n.getAttribute('data-va-hex') === '0x9999');
    assert.equal(activeBtns.length, 1);
    activeBtns[0].click();
    assert.deepEqual(firstCalls, []);
    assert.deepEqual(secondCalls, ['0x9999']);

    secondHandle.destroy();
    assert.equal(stats.activeListeners.size, 0);
  });

  it('switches UI labels between Japanese and English via setLang', () => {
    const { doc, container } = createMockDom();

    setLang('ja');
    const handle = renderBeginnerWorkflowPanel(container, makeSampleModel(), { doc });
    const jaText = collectAllText(handle.root);
    assert.ok(jaText.includes('初心者ガイド'));
    assert.ok(jaText.includes('自動解析の進捗'));
    assert.ok(jaText.includes('最初に見るべき関数'));
    assert.ok(jaText.includes('選択中の関数ガイド'));
    assert.ok(jaText.includes('パッチ安全性'));
    assert.ok(jaText.includes('用語ガイド'));
    assert.ok(jaText.includes('中リスク (MEDIUM)'));

    setLang('en');
    handle.update(makeSampleModel());
    const enText = collectAllText(handle.root);
    assert.ok(enText.includes('Beginner Guide'));
    assert.ok(enText.includes('Auto-Analysis Progress'));
    assert.ok(enText.includes('Recommended Starting Functions'));
    assert.ok(enText.includes('Active Function Guide'));
    assert.ok(enText.includes('Patch Risk'));
    assert.ok(enText.includes('Glossary Guide'));
    assert.ok(enText.includes('Medium risk (MEDIUM)'));

    handle.destroy();
  });

  it('falls back to activeCard.patchRisk and renders fail-safe notice when isFailSafe is true', () => {
    const { doc, container } = createMockDom();
    setLang('en');
    const handle = renderBeginnerWorkflowPanel(
      container,
      {
        progress: null,
        starterFunctions: [],
        activeCard: {
          headline: 'Unknown fn',
          whatItDoes: 'Pending',
          patchImpact: 'Unknown',
          patchRisk: {
            level: PATCH_RISK_LEVEL.UNKNOWN,
            score: null,
            reasons: ['No instruction bytes loaded'],
            cautions: [],
            glossaryKeys: [],
            isFailSafe: true,
          },
        },
        patchRisk: null,
        glossaryEntries: [],
      },
      { doc },
    );

    const riskBadge = collectNodes(handle.root, (n) => n.getAttribute('data-risk-level') !== null)[0];
    assert.ok(riskBadge);
    assert.equal(riskBadge.getAttribute('data-risk-level'), 'UNKNOWN');

    const text = collectAllText(handle.root);
    assert.ok(text.includes('fail-safe'));
    assert.ok(text.includes('No instruction bytes loaded'));

    handle.destroy();
  });
});
