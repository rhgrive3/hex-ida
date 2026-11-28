import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { V6Workbench } from '../js/ui/v6-workbench-bridge.js';
import { narrateV6Enrichment } from '../js/ui/beginner/enrichment-narrator.js';
import { unifiedSearch, showSearch } from '../js/ui/panels/search.js';
import * as panelIndex from '../js/ui/panels/index.js';
import { showClassTree } from '../js/ui/panels/class-tree.js';
import * as panelFacade from '../js/panels.js';
import { GLOSSARY_KEY_SET } from '../js/analysis/common/v6-auto-contracts.js';
import { lang, setLang } from '../js/i18n.js';

const INITIAL_LANG = lang();

afterEach(() => {
  setLang(INITIAL_LANG);
});

function createFakeDom() {
  const listeners = new Map();
  class FakeEl {
    constructor(tag) {
      this.tagName = String(tag || 'div').toUpperCase();
      this.className = '';
      this.children = [];
      this.parentNode = null;
      this.dataset = {};
      this.style = {};
      this.attributes = new Map();
      this._textContent = '';
      this._innerHTMLWrites = 0;
      this.value = '';
      this.type = '';
      this.disabled = false;
      this.classList = {
        _set: new Set(),
        add: (...cls) => { for (const c of cls) this.classList._set.add(c); },
        remove: (...cls) => { for (const c of cls) this.classList._set.delete(c); },
        contains: (c) => this.classList._set.has(c),
      };
    }
    get childNodes() { return this.children; }
    get textContent() { return this._textContent; }
    set textContent(v) { this._textContent = String(v ?? ''); }
    get innerHTML() { return ''; }
    set innerHTML(_v) { this._innerHTMLWrites += 1; }
    get isConnected() { return this.parentNode != null || this === doc.body; }
    setAttribute(k, v) { this.attributes.set(k, String(v)); }
    getAttribute(k) { return this.attributes.get(k) ?? null; }
    append(...nodes) {
      for (const n of nodes) {
        if (n == null) continue;
        if (typeof n === 'string') {
          this._textContent += n;
        } else if (n.isFragment) {
          for (const c of n.children) {
            c.parentNode = this;
            this.children.push(c);
          }
          n.children = [];
        } else {
          n.parentNode = this;
          this.children.push(n);
        }
      }
    }
    appendChild(n) { this.append(n); return n; }
    replaceChildren(...nodes) {
      this.children = [];
      this.append(...nodes);
    }
    remove() {
      if (this.parentNode) {
        this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
        this.parentNode = null;
      }
    }
    addEventListener(type, fn) {
      if (!listeners.has(this)) listeners.set(this, new Map());
      const m = listeners.get(this);
      if (!m.has(type)) m.set(type, []);
      m.get(type).push(fn);
    }
    removeEventListener(type, fn) {
      const arr = listeners.get(this)?.get(type);
      if (!arr) return;
      const idx = arr.indexOf(fn);
      if (idx >= 0) arr.splice(idx, 1);
    }
    click() {
      const arr = listeners.get(this)?.get('click') || [];
      for (const fn of arr.slice()) fn({ target: this, preventDefault() {}, stopPropagation() {} });
    }
    focus() {}
    querySelector() { return null; }
    querySelectorAll(pred) {
      const out = [];
      const walk = (node) => {
        if (pred(node)) out.push(node);
        for (const c of node.children || []) walk(c);
      };
      walk(this);
      return out;
    }
  }

  const overlaysEl = new FakeEl('div');
  overlaysEl.id = 'overlays';
  const bodyEl = new FakeEl('body');
  bodyEl.append(overlaysEl);

  const doc = {
    body: bodyEl,
    activeElement: null,
    getElementById(id) { return id === 'overlays' ? overlaysEl : null; },
    createElement(tag) { return new FakeEl(tag); },
    createDocumentFragment() {
      return {
        isFragment: true,
        children: [],
        append(...nodes) {
          for (const n of nodes) if (n) this.children.push(n);
        },
      };
    },
    addEventListener() {},
    removeEventListener() {},
  };
  return doc;
}

function buildSampleWasmAnalysis() {
  const fnVa = 0x1001a5384n;
  const lowFnVa = 0x100200000n;
  const className = 'Game::System::Coin::Abstruct';

  const cxxClassLink = {
    fnVa,
    primaryOwner: className,
    primaryRttiVa: 0x102000100n,
    slotIndex: 9,
    isShared: false,
    sharedOwners: [],
    allOwners: [{ className, rttiVa: 0x102000100n, vtableVa: 0x102001000n, slotIndex: 9 }],
  };

  const cxxRtti = {
    classes: [
      {
        className,
        mangledName: 'N4Game6System4Coin8AbstructE',
        namespacePath: ['Game', 'System', 'Coin'],
        shortClassName: 'Abstruct',
        rttiVa: 0x102000100n,
        vtableVas: [{ va: 0x102001000n, offsetToTop: 0 }],
        baseRttiVas: [],
        baseClassNames: [],
        methods: [{ fnVa, slotIndex: 9, vtableVa: 0x102001000n, isPrimaryOwner: true }],
      },
      {
        className: 'Game::Template<int & void>',
        mangledName: 'N4Game8TemplateIivEE',
        namespacePath: ['Game'],
        shortClassName: 'Template<int & void>',
        rttiVa: 0x102000200n,
        vtableVas: [{ va: 0x102002000n, offsetToTop: 0 }],
        baseRttiVas: [],
        baseClassNames: [],
        methods: [],
      },
    ],
    byFunction: new Map([[fnVa, cxxClassLink]]),
    byRttiVa: new Map(),
    completeness: 'complete',
    truncated: false,
    stats: { uniqueClasses: 2, linkedFunctions: 1 },
  };

  const folderNode = {
    id: 'folder:Game/System/Coin/Abstruct',
    parentId: 'root',
    kind: 'class',
    label: 'Abstruct',
    fullPath: 'Game/System/Coin/Abstruct',
    source: 'cxx-rtti',
    confidence: 'high',
    functionCount: 1,
    childFolderIds: [],
    functionAddrs: [fnVa],
  };
  const rootNode = {
    id: 'root',
    parentId: null,
    kind: 'root',
    label: 'Root',
    fullPath: '',
    source: 'cxx-rtti',
    confidence: 'high',
    functionCount: 1,
    childFolderIds: [folderNode.id],
    functionAddrs: [],
  };

  const virtualTree = {
    rootId: 'root',
    nodes: new Map([
      ['root', rootNode],
      [folderNode.id, folderNode],
    ]),
    functionToFolderId: new Map([[fnVa, folderNode.id]]),
    completeness: 'complete',
    truncated: false,
    stats: { totalFolders: 2, totalFunctions: 1 },
    getChildren(folderId) {
      if (folderId === 'root') {
        return { folders: [folderNode], functions: [], totalFolders: 1, totalFunctions: 0, hasMore: false };
      }
      return { folders: [], functions: [fnVa], totalFolders: 0, totalFunctions: 1, hasMore: false };
    },
    search() {
      return { matches: [] };
    },
  };

  const highCard = {
    addr: fnVa,
    ownerClass: className,
    folderPath: 'Game/System/Coin/Abstruct',
    slotIndex: 9,
    evidence: {
      ownStrings: ['coin_add'],
      siblingStrings: [],
      apiCalls: [],
      cryptoTypes: ['Crypto::Value'],
      writesGlobalSingleton: true,
      callerOwners: [],
    },
    naming: {
      labelJa: 'コイン残高を加算・更新する',
      nameEn: 'addAndUpdateCoinBalance',
      confidence: 'high',
      reasons: ['Game::System::Coin::Abstruct の仮想メソッド', '文字列 "coin_add" を参照'],
    },
  };

  const lowCard = {
    addr: lowFnVa,
    ownerClass: null,
    folderPath: 'Unclassified',
    slotIndex: null,
    evidence: { ownStrings: [], siblingStrings: [], apiCalls: [], cryptoTypes: [], writesGlobalSingleton: false, callerOwners: [] },
    naming: {
      labelJa: '役割未確定の処理',
      nameEn: null,
      confidence: 'low',
      reasons: [],
    },
  };

  const semanticNames = {
    byFunction: new Map([
      [fnVa, highCard],
      [lowFnVa, lowCard],
    ]),
    stats: { totalScored: 2, highCount: 1, mediumCount: 0, lowCount: 1, elapsedMs: 1 },
  };

  const classFields = {
    layouts: new Map([
      [className, {
        className,
        methodCount: 1,
        fields: [{ offset: 0x18, width: 4, reads: 1, writes: 1, typeHint: null, confidence: 'high', sampleFunctions: [fnVa] }],
      }],
    ]),
    stats: { classesProcessed: 1, classesWithFields: 1, totalFields: 1 },
  };

  return {
    fnVa,
    lowFnVa,
    className,
    highCard,
    lowCard,
    wasmAnalysis: {
      cxxRtti,
      unifiedMetadata: { classes: [], methodsByFn: new Map(), completeness: 'complete', partialReasons: [], stats: {} },
      virtualTree,
      semanticNames,
      classFields,
    },
  };
}

describe('Track T6: V6Workbench, Search, Enrichment Narrator & Panels Index Integration', () => {
  it('stores and exposes cxxRtti, virtualTree, semanticNames, classFields and clears on null / binary switch', () => {
    const wb = new V6Workbench({});
    const { fnVa, className, highCard, wasmAnalysis } = buildSampleWasmAnalysis();

    const res = wb.ingestWasmAnalysis(wasmAnalysis);
    assert.equal(res.ok, true);
    assert.equal(res.counts.cxxClasses, 2);
    assert.equal(res.counts.virtualTreeFolders, 2);
    assert.equal(res.counts.semanticNames, 2);
    assert.equal(res.counts.classFieldLayouts, 1);

    assert.strictEqual(wb.getCxxRtti(), wasmAnalysis.cxxRtti);
    assert.strictEqual(wb.getVirtualTree(), wasmAnalysis.virtualTree);
    assert.strictEqual(wb.getSemanticName(fnVa), highCard);
    assert.strictEqual(wb.getSemanticName('0x1001a5384'), highCard);
    assert.strictEqual(wb.getSemanticName('0X1001A5384'), highCard);
    assert.equal(wb.getSemanticName(0x9999n), null);

    const layout = wb.getClassFields(className);
    assert.ok(layout);
    assert.equal(layout.className, className);
    assert.equal(layout.fields.length, 1);
    assert.equal(wb.getClassFields('NonExistent::Class'), null);

    // Non-destructive enrichment fields
    const enriched = wb.getFunctionEnrichment(fnVa);
    assert.equal(enriched.funcVa, '0x1001a5384');
    assert.equal(enriched.cxxClass?.primaryOwner, className);
    assert.equal(enriched.cxxClass?.slotIndex, 9);
    assert.strictEqual(enriched.semanticName, highCard);
    assert.equal(enriched.virtualFolderPath, 'Game/System/Coin/Abstruct');
    assert.equal(enriched.wasmHints.available, true);

    // Clear on ingestWasmAnalysis(null)
    const cleared = wb.ingestWasmAnalysis(null);
    assert.equal(cleared.ok, false);
    assert.equal(wb.getCxxRtti(), null);
    assert.equal(wb.getVirtualTree(), null);
    assert.equal(wb.getSemanticName(fnVa), null);
    assert.equal(wb.getClassFields(className), null);

    // Re-ingest and verify binary switch clears immediately
    wb.ingestWasmAnalysis(wasmAnalysis);
    assert.ok(wb.getVirtualTree());
    wb.onBinaryReady({ sha256: 'binary-fingerprint-A' });
    wb.ingestWasmAnalysis(wasmAnalysis);
    assert.ok(wb.getCxxRtti());
    wb.onBinaryReady({ sha256: 'binary-fingerprint-B' });
    assert.equal(wb.getCxxRtti(), null);
    assert.equal(wb.getVirtualTree(), null);
    assert.equal(wb.getSemanticName(fnVa), null);
    assert.equal(wb.getClassFields(className), null);
  });

  it('narrateV6Enrichment reflects cxxClass, semanticName, virtualFolderPath while strictly obeying 24-key glossary contract', () => {
    const wb = new V6Workbench({});
    const { fnVa, lowFnVa, className, wasmAnalysis } = buildSampleWasmAnalysis();
    wb.ingestWasmAnalysis(wasmAnalysis);

    setLang('ja');
    const highEnrichment = wb.getFunctionEnrichment(fnVa, { rawName: 'sub_1001a5384' });
    const highNar = narrateV6Enrichment(highEnrichment, { rawName: 'sub_1001a5384' });
    assert.equal(highNar.displayName, 'コイン残高を加算・更新する');
    assert.ok(highNar.badges.some((b) => b.id === 'cxx-class' && b.label === className));
    assert.ok(highNar.badges.some((b) => b.id === 'semantic-name'));
    assert.ok(highNar.summaryLines.some((s) => s.includes(className) && s.includes('slot 9')));
    assert.ok(highNar.summaryLines.some((s) => s.includes('Game/System/Coin/Abstruct')));
    for (const k of highNar.glossaryKeys) {
      assert.equal(GLOSSARY_KEY_SET.has(k), true, `glossary key "${k}" must remain in canonical 24-key GLOSSARY_KEY_SET`);
    }

    setLang('en');
    const highNarEn = narrateV6Enrichment(highEnrichment, { rawName: 'sub_1001a5384' });
    assert.equal(highNarEn.displayName, 'addAndUpdateCoinBalance');

    // Low confidence must NOT override displayName
    setLang('ja');
    const lowEnrichment = wb.getFunctionEnrichment(lowFnVa, { rawName: 'sub_100200000' });
    const lowNar = narrateV6Enrichment(lowEnrichment, { rawName: 'sub_100200000' });
    assert.equal(lowNar.displayName, 'sub_100200000');
    assert.equal(lowNar.badges.some((b) => b.id === 'semantic-name'), false);
    for (const k of lowNar.glossaryKeys) {
      assert.equal(GLOSSARY_KEY_SET.has(k), true);
    }
  });

  it('unifiedSearch surfaces restored C++ RTTI classes and showSearch conditionally shows Class Tree launcher without innerHTML', () => {
    const wb = new V6Workbench({});
    const { className, wasmAnalysis } = buildSampleWasmAnalysis();
    wb.ingestWasmAnalysis(wasmAnalysis);

    const appWithTree = {
      v6Workbench: wb,
      store: { get: () => null, set: () => {} },
    };

    const res = unifiedSearch(appWithTree, 'Coin');
    assert.ok(
      res.items.some((it) => it.category === 'class' && it.name === className),
      'unifiedSearch must include restored C++ RTTI class candidates',
    );

    const prevDoc = globalThis.document;
    const prevWin = globalThis.window;
    const prevRaf = globalThis.requestAnimationFrame;
    const fakeDoc = createFakeDom();
    globalThis.document = fakeDoc;
    globalThis.window = { innerWidth: 1024, addEventListener() {}, removeEventListener() {} };
    globalThis.requestAnimationFrame = (fn) => { fn(); return 0; };

    try {
      // With virtualTree -> button is rendered and opens Class Tree without innerHTML
      showSearch(appWithTree);
      const openBtns = fakeDoc.body.querySelectorAll((n) => n.dataset?.action === 'open-class-tree');
      assert.equal(openBtns.length, 1, 'Class Tree button must appear when virtualTree is available');
      openBtns[0].click();
      const allNodes = fakeDoc.body.querySelectorAll(() => true);
      for (const n of allNodes) {
        assert.equal(n._innerHTMLWrites, 0, 'must never assign innerHTML (XSS prevention)');
      }

      // Without virtualTree -> button must NOT appear
      fakeDoc.getElementById('overlays').replaceChildren();
      const appWithoutTree = {
        symbols: { functionList: () => [] },
        store: { get: () => null, set: () => {} },
      };
      showSearch(appWithoutTree);
      const missingBtns = fakeDoc.body.querySelectorAll((n) => n.dataset?.action === 'open-class-tree');
      assert.equal(missingBtns.length, 0, 'Class Tree button must not appear when virtualTree is unavailable');
    } finally {
      globalThis.document = prevDoc;
      globalThis.window = prevWin;
      if (prevRaf === undefined) delete globalThis.requestAnimationFrame;
      else globalThis.requestAnimationFrame = prevRaf;
    }
  });

  it('exports showClassTree from js/ui/panels/index.js without mutating js/panels.js facade', () => {
    assert.strictEqual(panelIndex.showClassTree, showClassTree);
    assert.equal('showClassTree' in panelFacade, false, 'js/panels.js must not re-export showClassTree');
  });
});
