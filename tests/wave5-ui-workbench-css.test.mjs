import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { V6Workbench } from '../js/ui/v6-workbench-bridge.js';
import { AUTO_ANALYSIS_STATUS } from '../js/analysis/common/v6-auto-contracts.js';
import {
  buildInitialLandingCard,
  findingIdentifier,
} from '../js/ui/product-base.js';
import { encodeHsig1Pack } from '../js/analysis/signature/hex-sig-pack.js';
import { HEXSIG_ARCH_ARM64, fnv1a64 } from '../js/analysis/signature/hex-sig-extractor.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const productBaseSrc = fs.readFileSync(path.join(ROOT, 'js/ui/product-base.js'), 'utf8');
const bridgeSrc = fs.readFileSync(path.join(ROOT, 'js/ui/v6-workbench-bridge.js'), 'utf8');
const componentsCssSrc = fs.readFileSync(path.join(ROOT, 'css/components.css'), 'utf8');

function buildLinearMbaAddDag() {
  const x = { op: 'var', name: 'x', width: 64 };
  const y = { op: 'var', name: 'y', width: 64 };
  const two = { op: 'const', value: 2n, width: 64 };
  return {
    op: 'add',
    width: 64,
    a: { op: 'xor', width: 64, a: x, b: y },
    b: {
      op: 'mul',
      width: 64,
      a: two,
      b: { op: 'and', width: 64, a: x, b: y },
    },
  };
}

function buildSampleHsig1Pack() {
  const pattern = new Uint8Array(32);
  const mask = new Uint8Array(32);
  const raw = [0xfd, 0x7b, 0xbf, 0xa9, 0xfd, 0x03, 0x00, 0x91, 0xc0, 0x03, 0x5f, 0xd6];
  pattern.set(raw, 0);
  mask.fill(0xff, 0, raw.length);
  return encodeHsig1Pack({
    archMask: HEXSIG_ARCH_ARM64,
    entries: [{
      symbolName: 'deflateInit2_',
      arch: HEXSIG_ARCH_ARM64,
      prologueLen: raw.length,
      minFuncLen: raw.length,
      libId: 1,
      baseConfidence: 900,
      pattern,
      wildcardMask: mask,
      tailCrc32: 0,
      anchorHash: fnv1a64(new Uint8Array(raw)),
    }],
  });
}

class MiniElement {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.attributes = new Map();
    this.dataset = {};
    this.style = { setProperty() {} };
    this._text = '';
    this.className = '';
    this.listeners = new Map();
    this.hidden = false;
    this.disabled = false;
    this.type = '';
    this.title = '';
    this.id = '';
    this.lang = '';
  }

  get childNodes() { return this.children; }

  get classList() {
    const self = this;
    const tokens = () => self.className.split(/\s+/).filter(Boolean);
    return {
      add(...cls) {
        const set = new Set(tokens());
        for (const c of cls) if (c) set.add(c);
        self.className = [...set].join(' ');
      },
      remove(...cls) {
        const set = new Set(tokens());
        for (const c of cls) set.delete(c);
        self.className = [...set].join(' ');
      },
      contains(c) { return tokens().includes(c); },
      toggle(c, force) {
        const has = this.contains(c);
        const next = force !== undefined ? !!force : !has;
        if (next) this.add(c); else this.remove(c);
        return next;
      },
    };
  }

  get textContent() {
    if (!this.children.length) return this._text;
    return this._text + this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join('');
  }

  set textContent(val) {
    this._text = String(val ?? '');
    this.children = [];
  }

  setAttribute(k, v) { this.attributes.set(k, String(v)); }
  getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; }

  append(...nodes) {
    for (const n of nodes) {
      if (n == null || n === false) continue;
      if (typeof n === 'string') {
        this._text += n;
      } else {
        n.parentElement = this;
        this.children.push(n);
      }
    }
  }

  replaceChildren(...nodes) {
    this._text = '';
    this.children = [];
    this.append(...nodes);
  }

  remove() {
    if (!this.parentElement) return;
    const idx = this.parentElement.children.indexOf(this);
    if (idx >= 0) this.parentElement.children.splice(idx, 1);
    this.parentElement = null;
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

  click() {
    const list = this.listeners.get('click') || [];
    for (const fn of [...list]) {
      fn({ currentTarget: this, target: this, preventDefault() {}, stopPropagation() {} });
    }
  }

  querySelectorAll(selector) {
    const out = [];
    const cls = selector.startsWith('.') ? selector.slice(1) : null;
    const walk = (node) => {
      for (const child of node.children) {
        if (cls ? child.classList.contains(cls) : child.tagName === selector.toUpperCase()) {
          out.push(child);
        }
        walk(child);
      }
    };
    walk(this);
    return out;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

function withFakeDom(fn) {
  const prevDoc = globalThis.document;
  const docEl = new MiniElement('html');
  docEl.lang = 'en';
  const body = new MiniElement('body');
  globalThis.document = {
    documentElement: docEl,
    body,
    createElement: (tag) => new MiniElement(tag),
    getElementById: () => null,
    querySelector: () => null,
  };
  try {
    return fn();
  } finally {
    globalThis.document = prevDoc;
  }
}

// ============================================================================
// 1. js/ui/v6-workbench-bridge.js
// ============================================================================

test('V6Workbench [P0]: exportV2DeltaFields / importV2DeltaFields full round-trip across all 5 recovery stores', () => {
  const wb1 = new V6Workbench(null);

  wb1.displayHints['0x1000'] = { radix: 'dec', signed: true };
  wb1.pinnedMasks['0x1000'] = 0xff;
  wb1.manualSegments.add({
    startVa: 0x20000n,
    size: 0x4000,
    fileOffset: 0x1000,
    kind: 1,
    flags: 3,
    name: '__custom_text',
  });
  wb1.funcChunks.attachChunk(0x10000n, {
    startVa: 0x12000n,
    endVa: 0x12080n,
    kind: 1,
    flags: 0,
  });
  wb1.customAbis.set(0x10000n, {
    name: 'custom_fast',
    cc: 'custom',
    argRegs: ['x0', 'x1'],
    retRegs: ['x0'],
    clobbers: ['x9'],
  });
  wb1.stackOverrides.setOverride(0x10000n, {
    spOffset: -16,
    byteSize: 8,
    name: 'saved_hp',
    typeName: 'int64_t',
  });
  wb1.shiftedPtrs.register(0x10000n, {
    varKey: 'x19',
    baseTypeName: 'Player',
    offset: 24,
  });

  const exported = wb1.exportV2DeltaFields();
  assert.deepEqual(Object.keys(exported).sort(), [
    'customAbis',
    'displayHints',
    'funcChunks',
    'manualSegments',
    'pinnedMasks',
    'shiftedPtrs',
    'stackSlotOverrides',
  ]);
  assert.equal(exported.manualSegments.length, 1);
  assert.equal(exported.manualSegments[0].size, 0x4000);
  assert.equal(exported.manualSegments[0].startVa, '0x20000');
  assert.equal(exported.funcChunks.length, 1);
  assert.equal(exported.funcChunks[0].ownerVa, '0x10000');
  assert.equal(exported.funcChunks[0].startVa, '0x12000');
  assert.equal(exported.customAbis.length, 1);
  assert.equal(exported.customAbis[0].funcVa, '0x10000');
  assert.equal(exported.stackSlotOverrides.length, 1);
  assert.equal(exported.stackSlotOverrides[0].name, 'saved_hp');
  assert.equal(exported.shiftedPtrs.length, 1);
  assert.equal(exported.shiftedPtrs[0].varKey, 'x19');

  // Round-trip into a fresh V6Workbench + ignore malformed entries
  const wb2 = new V6Workbench(null);
  wb2.importV2DeltaFields({
    ...exported,
    manualSegments: [...exported.manualSegments, null, 'bad'],
    funcChunks: [...exported.funcChunks, null],
  });

  const reexported = wb2.exportV2DeltaFields();
  assert.deepEqual(reexported.displayHints, exported.displayHints);
  assert.deepEqual(reexported.pinnedMasks, exported.pinnedMasks);
  assert.equal(reexported.manualSegments.length, 1);
  assert.equal(reexported.manualSegments[0].size, 0x4000);
  assert.equal(reexported.manualSegments[0].startVa, '0x20000');
  assert.equal(reexported.funcChunks.length, 1);
  assert.equal(reexported.funcChunks[0].ownerVa, '0x10000');
  assert.equal(reexported.customAbis.length, 1);
  assert.equal(reexported.customAbis[0].funcVa, '0x10000');
  assert.equal(reexported.stackSlotOverrides.length, 1);
  assert.equal(reexported.stackSlotOverrides[0].name, 'saved_hp');
  assert.equal(reexported.shiftedPtrs.length, 1);
  assert.equal(reexported.shiftedPtrs[0].varKey, 'x19');
});

test('V6Workbench [P0]: _mountPopover composes user onClose without clobbering bridge cleanup', () => {
  const wb = new V6Workbench(null);
  let capturedOnClose = null;
  let userOnCloseCalled = 0;
  let destroyCalled = 0;

  const fakeDoc = { body: {} };
  const renderFn = (_controller, opts) => {
    capturedOnClose = opts.onClose;
    return {
      destroy() { destroyCalled++; },
    };
  };

  wb._mountPopover('type-edit', renderFn, {}, {
    document: fakeDoc,
    container: fakeDoc.body,
    onClose: () => { userOnCloseCalled++; },
  });

  assert.equal(wb.getActivePopoverKind(), 'type-edit');
  assert.equal(typeof capturedOnClose, 'function');

  capturedOnClose();
  assert.equal(wb.getActivePopoverKind(), null, 'bridge cleanup must clear _activePopoverKind');
  assert.equal(userOnCloseCalled, 1, 'user onClose callback must also be invoked');
  assert.equal(destroyCalled, 0);
});

test('V6Workbench [P1]: binary switch resets binary-scoped stores in-place, purges TIL slots, preserves injected loader, and detach clears loader', () => {
  const injectedLoader = { loadForBinary: async () => ({ packs: [] }) };
  const wb = new V6Workbench(null, { hexsigHubLoader: injectedLoader });

  // Capture jevOverlay reference to globalTypeMap before reset
  const originalGlobalTypeMap = wb.globalTypeMap;
  assert.equal(wb.jevOverlay.globalTypeMap, originalGlobalTypeMap);

  wb.globalTypeMap.set(0x1000n, { name: 'Player', kind: 'struct' });
  wb.manualSegments.add({ startVa: 0x2000n, size: 0x100, fileOffset: 0, kind: 1, flags: 1, name: 'segA' });
  wb.funcChunks.attachChunk(0x1000n, { startVa: 0x1500n, endVa: 0x1540n, kind: 1, flags: 0 });
  wb.customAbis.set(0x1000n, { cc: 'custom', argRegs: ['x0'], retRegs: ['x0'], clobbers: [] });
  wb.stackOverrides.setOverride(0x1000n, { spOffset: -8, byteSize: 8, name: 'v', typeName: 'int64_t' });
  wb.shiftedPtrs.register(0x1000n, { varKey: 'x0', baseTypeName: 'Foo', offset: 8 });
  wb.displayHints['0x1000'] = { radix: 'hex' };
  wb.pinnedMasks['0x1000'] = 0x1;

  let purgeCalled = null;
  wb.tilPackManager.purgeAllSlots = (opts) => { purgeCalled = opts; };

  // Binary switch reset
  wb.cancelAutoAnalysis({ resetState: true });

  assert.equal(wb.globalTypeMap, originalGlobalTypeMap, 'globalTypeMap reference must be preserved in-place');
  assert.equal(wb.jevOverlay.globalTypeMap, originalGlobalTypeMap, 'jevOverlay must still reference the same globalTypeMap');
  assert.equal(wb.globalTypeMap.size, 0, 'globalTypeMap entries must be cleared');
  assert.deepEqual(wb.globalTypeMap._sortedVas, []);
  assert.equal(wb.globalTypeMap._sortedDirty, false);

  const exported = wb.exportV2DeltaFields();
  assert.equal(exported.manualSegments.length, 0);
  assert.equal(exported.funcChunks.length, 0);
  assert.equal(exported.customAbis.length, 0);
  assert.equal(exported.stackSlotOverrides.length, 0);
  assert.equal(exported.shiftedPtrs.length, 0);
  assert.deepEqual(exported.displayHints, {});
  assert.deepEqual(exported.pinnedMasks, {});
  assert.deepEqual(purgeCalled, { releaseTidBases: true });
  assert.equal(wb._hexsigHubLoader, injectedLoader, 'injected hexsigHubLoader must be preserved across binary switch');

  // detach() must release _hexsigHubLoader
  wb.detach();
  assert.equal(wb._hexsigHubLoader, null, 'detach() must clear _hexsigHubLoader');
});

test('V6Workbench [P1]: cancelStagedAutoAnalysis transitions til/hexsig/deobf from IDLE/RUNNING to ABORTED', () => {
  const wb = new V6Workbench(null);
  wb._autoAnalysisState.til.status = AUTO_ANALYSIS_STATUS.RUNNING;
  wb._autoAnalysisState.hexsig.status = AUTO_ANALYSIS_STATUS.IDLE;
  wb._autoAnalysisState.deobf.status = AUTO_ANALYSIS_STATUS.DONE;

  let emitted = null;
  wb.subscribeAutoAnalysis((s) => { emitted = s; });
  wb.cancelStagedAutoAnalysis();

  assert.equal(wb._autoAnalysisState.til.status, AUTO_ANALYSIS_STATUS.ABORTED);
  assert.equal(wb._autoAnalysisState.hexsig.status, AUTO_ANALYSIS_STATUS.ABORTED);
  assert.equal(wb._autoAnalysisState.deobf.status, AUTO_ANALYSIS_STATUS.DONE, 'already DONE phase must stay DONE');
  assert.ok(emitted, 'must emit auto-analysis update on cancel');
});

test('V6Workbench [P1]: _runAutoAnalysisPipeline honors providers.isCurrent() === false in Phase 1-3', async () => {
  const wb = new V6Workbench(null, {
    hexdbFactory: () => ({ open: async () => {}, close: async () => {} }),
  });

  let current = true;
  const ctrl = new AbortController();
  wb._autoGen = 1;
  wb._autoAbortController = ctrl;

  await wb._runAutoAnalysisPipeline(1, ctrl.signal, {
    isCurrent: () => current,
    getBinaryMeta: () => ({ platform: 'ios', arch: 'arm64' }),
    tilFetchManifest: async () => {
      current = false; // Simulate slice switch mid-Phase 1
      throw new Error('simulated_late_error');
    },
    getFunctions: () => [],
    getDeobfCandidates: () => [],
  });

  assert.notEqual(
    wb._autoAnalysisState.til.status,
    AUTO_ANALYSIS_STATUS.ERROR,
    'stale error after isCurrent() === false must not overwrite TIL status',
  );
});

test('V6Workbench [P2]: refineDecompiledCode forwards foldCalleeSavedSpills and collapseDuplicateAsm', () => {
  // Keep static import contract for tests/v6-clean-view-ui.test.mjs:42
  assert.ok(
    bridgeSrc.includes("import { formatCleanViewLines, formatCleanViewText } from '../decompiler/clean-view.js';"),
    'v6-workbench-bridge.js must preserve formatCleanViewLines/formatCleanViewText import',
  );

  const wb = new V6Workbench(null);
  wb.displayHints['0x1000'] = {
    cleanView: {
      foldCalleeSavedSpills: false,
      collapseDuplicateAsm: false,
    },
  };
  const sample = 'void f(void) {\n  int x = 1;\n  return;\n}';
  const res = wb.refineDecompiledCode('0x1000', sample);
  assert.equal(typeof res.code, 'string');
  assert.ok(bridgeSrc.includes('foldCalleeSavedSpills: safeOpts.foldCalleeSavedSpills ?? cleanViewHints.foldCalleeSavedSpills'));
  assert.ok(bridgeSrc.includes('collapseDuplicateAsm: safeOpts.collapseDuplicateAsm ?? cleanViewHints.collapseDuplicateAsm'));
});

test('V6Workbench [P2]: mountHexSigPack is idempotent for identical packId', () => {
  const wb = new V6Workbench(null);
  const packBytes = buildSampleHsig1Pack();

  const first = wb.mountHexSigPack(packBytes, { packId: 'test_pack_1', libId: 1, libName: 'zlib' });
  assert.equal(first.ok, true);
  assert.equal(first.alreadyMounted, undefined);
  const countAfterFirst = wb.hexsigIndex.entries.length;
  assert.equal(countAfterFirst, 1);

  const second = wb.mountHexSigPack(packBytes, { packId: 'test_pack_1', libId: 1, libName: 'zlib' });
  assert.equal(second.ok, true);
  assert.equal(second.alreadyMounted, true);
  assert.equal(wb.hexsigIndex.entries.length, countAfterFirst, 'duplicate mount must not double hexsigIndex entries');
});

test('V6Workbench [P2]: runDeobfuscationPass counts unique written insnVa for overlayCount', () => {
  const wb = new V6Workbench(null);
  const res = wb.runDeobfuscationPass({
    funcVa: '0x1000',
    mbaNodes: [
      { insnVa: '0x1000', dag: buildLinearMbaAddDag() },
      { insnVa: '0x1000', dag: buildLinearMbaAddDag() },
      { insnVa: '0x1008', dag: buildLinearMbaAddDag() },
    ],
    commit: true,
  });
  assert.equal(res.overlayCount, 2, 'overlayCount must equal unique written insnVa count (0x1000 and 0x1008)');
});

// ============================================================================
// 2. js/ui/product-base.js
// ============================================================================

test('product-base.js [P0]: y token type-edit shortcut is outside if (event.key === "?") and Ctrl+Z/Ctrl+Y unified under !hasOverlay', () => {
  const yIdx = productBaseSrc.indexOf("if (key === 'y' && !event.shiftKey && target?.closest?.('.tok-fn-link, .tok-addr-link, [data-entity-kind]') && app?.v6)");
  const qIdx = productBaseSrc.indexOf("if (event.key === '?')");
  assert.ok(yIdx > 0, 'token y shortcut must exist');
  assert.ok(qIdx > 0, '? shortcut must exist');
  assert.ok(yIdx < qIdx, 'token y shortcut must appear BEFORE if (event.key === "?") so it is reachable');

  const undoMatches = productBaseSrc.match(/app\.v6\.undoTypeEdit\(\)/g) || [];
  assert.equal(undoMatches.length, 1, 'undoTypeEdit must be wired once inside the unified !hasOverlay block');
  const redoMatches = productBaseSrc.match(/app\.v6\.redoTypeEdit\(\)/g) || [];
  assert.equal(redoMatches.length, 2, 'redoTypeEdit must handle Shift+Z and Ctrl+Y inside the unified !hasOverlay block');
  assert.ok(
    productBaseSrc.includes("if (!hasOverlay && (event.metaKey || event.ctrlKey) && !event.altKey)"),
    'Undo/Redo shortcuts must be guarded by !hasOverlay',
  );
  assert.ok(
    productBaseSrc.includes("else if (event.ctrlKey && !event.metaKey && key === 'y')"),
    'Windows Ctrl+Y redo shortcut must be supported under !hasOverlay',
  );
});

test('product-base.js [P1]: buildInitialLandingCard navigates class clicks to /explorer/classes?q=', () => {
  withFakeDom(() => {
    const navigated = [];
    const router = { navigate: (p) => navigated.push(p) };
    const app = {
      store: { get: (k) => (k === 'fileInfo' ? { name: 'TestBin' } : k === 'regions' ? [] : null) },
      appMap: { classes: [{ name: 'PlayerController', count: 5 }], hotFunctions: [] },
      symbols: { functionCount: 10, nameAt: () => null },
    };
    const cardNode = buildInitialLandingCard(app, router);
    const classRows = cardNode.querySelector('.ui-quickstart-classes').querySelectorAll('.ui-list-row');
    assert.equal(classRows.length, 1);
    classRows[0].click();
    assert.equal(navigated.at(-1), '/explorer/classes?q=PlayerController');
  });
});

test('product-base.js [P1]: isFileLoading returns without event.preventDefault() and safeBigInt protects findingIdentifier', () => {
  assert.match(
    productBaseSrc,
    /const shortcut = \(event\) => \{\s*if \(isFileLoading\(app\)\) return;/,
    'isFileLoading guard must return without calling event.preventDefault()',
  );

  for (const badAddr of ['not-a-hex', 'NaN', '', '   ', {}, Symbol('x'), Number.NaN, Infinity]) {
    const id = findingIdentifier({ title: 'TestFinding', addr: badAddr }, 0);
    assert.ok(typeof id === 'string' && id.startsWith('f-'), `expected valid finding id for ${String(badAddr)}`);
  }
  const validId = findingIdentifier({ title: 'TestFinding', addr: '0x1000' }, 0);
  const validIdBig = findingIdentifier({ title: 'TestFinding', addr: 0x1000n }, 0);
  assert.equal(validId, validIdBig, 'valid hex string and BigInt addr must hash identically');
});

test('product-base.js [P1/P2]: rename cache fingerprint, applyGoalLineHighlight gutter preservation, codeViewState & pickOneFile timer cleanup', () => {
  assert.ok(
    productBaseSrc.includes('renameFingerprint'),
    'getSymbolLookupEntry must include renameFingerprint to invalidate in-place rename overwrites',
  );

  const highlightMatch = productBaseSrc.match(/const applyGoalLineHighlight = [\s\S]*?\n\s*\};/);
  assert.ok(highlightMatch, 'applyGoalLineHighlight must exist');
  assert.ok(!highlightMatch[0].includes('paddingLeft'), 'applyGoalLineHighlight must not set inline paddingLeft');
  assert.ok(!highlightMatch[0].includes('marginLeft'), 'applyGoalLineHighlight must not set inline marginLeft');
  assert.ok(highlightMatch[0].includes("lineEl.classList.add('hex-goal-highlight')"));
  assert.ok(highlightMatch[0].includes("lineEl.setAttribute('data-line-index'"));

  assert.ok(productBaseSrc.includes('const viewer = app?.viewer;'), 'codeViewState must guard app?.viewer');
  assert.ok(productBaseSrc.includes('if(focusTimer){ clearTimeout(focusTimer); focusTimer=0; }'), 'pickOneFile must clear focusTimer in finish');
});

// ============================================================================
// 3. css/components.css
// ============================================================================

test('css/components.css [P1/P2]: gutter highlight, undefined UI classes, aria-checked, and deduplicated provenance toolbar', () => {
  assert.match(
    componentsCssSrc,
    /\.product-ui-ready\s+\.ui-pseudocode-line\.hex-goal-highlight\s*\{[^}]*padding-left:\s*3\.4em;/,
    'hex-goal-highlight must preserve 3.4em gutter padding',
  );
  assert.ok(componentsCssSrc.includes('.ui-quickstart-host[hidden]'), 'must hide hidden quickstart host');
  for (const cls of [
    '.ui-quickstart-host',
    '.ui-quickstart-card',
    '.ui-quickstart-section',
    '.ui-quickstart-heading',
    '.ui-quickstart-dismiss',
    '.ui-row-actions',
    '.ui-row-note-btn',
    '.ui-row-xrefs',
    '.ui-badge',
    '.ui-badge-confirmed',
  ]) {
    assert.ok(componentsCssSrc.includes(cls), `css/components.css must define ${cls}`);
  }
  assert.ok(
    componentsCssSrc.includes('.ui-choice-row.toggle[aria-checked="true"]'),
    'toggle choice row must support aria-checked="true"',
  );

  const provenanceMatches = componentsCssSrc.match(/\.product-ui-ready\s+\.ui-decompiler-provenance\s*>\s*\.ui-code-toolbar:first-child\s*\{/g) || [];
  assert.equal(provenanceMatches.length, 1, 'duplicate provenance toolbar selector must be consolidated into 1 block');
});
