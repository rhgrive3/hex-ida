import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { PRIMARY_NAV } from '../js/ui/registry.js';
import {
  DELTA_SESSION_FORMAT,
  DELTA_SESSION_VERSION,
  MAX_DELTA_ENTRY_BYTES,
  DeltaSessionStore,
  countDeltaItems,
  serializeDeltaJson,
  parseDeltaJson,
} from '../js/cache/delta-session.js';
import {
  validateCTypeSyntax,
  buildNotesTypeSlots,
  createTypeEditPopoverController,
  renderTypeEditPopover,
} from '../js/ui/type-edit-popover.js';
import {
  createSlicePanelController,
  renderSlicePanel,
} from '../js/ui/slice-panel.js';
import {
  INTEROP_SCHEMA_ID,
  DWARF_SUMMARY_SCHEMA_ID,
  HEXDB_DELTA_FORMAT,
  HEXDB_DELTA_VERSION,
  exportCHeader,
  exportInteropJson,
  importInteropJson,
  exportDwarfSummaryJson,
  validateDwarfSummaryJson,
  exportHexDbDeltaBundle,
  importHexDbDeltaBundle,
  exportFridaSnippet,
  createExportInteropController,
  renderExportInteropModal,
} from '../js/ui/export-interop.js';
import {
  MANUAL_SEG_KINDS,
  validateManualSegment,
  validateFuncChunk,
  validateCustomAbi,
  validateStackSlotOverride,
  validateShiftedPtr,
  createManualRecoveryPopoverController,
  renderManualRecoveryPopover,
} from '../js/ui/manual-recovery-popover.js';
import {
  GATE_E_SCHEMA_ID,
  GATE_E_AXES,
  UNSAFE_HTML_SINK_RE,
  collectLocalMetrics,
  evaluateGateEScorecard,
  formatGateEJson,
  formatGateETable,
} from '../tools/validation/public-benchmark/gate-e-scorecard.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Lightweight Node mock DOM that:
 * - Strictly enforces XSS safety (throws on innerHTML / outerHTML assignment)
 * - Supports AbortSignal on addEventListener for leak verification
 * - Supports parentNode, remove(), closest() for event delegation & teardown
 */
function createStrictMockDocument() {
  function createElement(tag) {
    const attrs = new Map();
    const listeners = new Map();
    const children = [];
    const node = {
      tagName: String(tag).toUpperCase(),
      className: '',
      textContent: '',
      value: '',
      checked: false,
      disabled: false,
      type: '',
      parentNode: null,
      children,
      get firstChild() {
        return children.length > 0 ? children[0] : null;
      },
      appendChild(child) {
        child.parentNode = this;
        children.push(child);
        return child;
      },
      removeChild(child) {
        const idx = children.indexOf(child);
        if (idx >= 0) {
          children.splice(idx, 1);
          child.parentNode = null;
        }
        return child;
      },
      remove() {
        if (this.parentNode) this.parentNode.removeChild(this);
      },
      setAttribute(k, v) {
        attrs.set(String(k), String(v));
      },
      getAttribute(k) {
        return attrs.has(String(k)) ? attrs.get(String(k)) : null;
      },
      closest(selector) {
        const attrMatch = selector.match(/^\[([A-Za-z0-9_-]+)\]$/);
        let cur = this;
        while (cur) {
          if (attrMatch && cur.getAttribute(attrMatch[1]) != null) return cur;
          cur = cur.parentNode;
        }
        return null;
      },
      addEventListener(ev, fn, opts) {
        const signal = opts && typeof opts === 'object' ? opts.signal : null;
        if (signal?.aborted) return;
        if (!listeners.has(ev)) listeners.set(ev, new Set());
        listeners.get(ev).add(fn);
        if (signal) {
          signal.addEventListener('abort', () => {
            listeners.get(ev)?.delete(fn);
          }, { once: true });
        }
      },
      dispatchEvent(evName, payload = {}) {
        const event = { target: this, ...payload };
        let cur = this;
        while (cur) {
          for (const fn of [...(cur._getListeners(evName) ?? [])]) fn(event);
          cur = cur.parentNode;
        }
      },
      _getListeners(evName) {
        return listeners.get(evName);
      },
      click() {
        this.dispatchEvent('click', { target: this });
      },
      findAll(predicate, out = []) {
        if (predicate(this)) out.push(this);
        for (const c of children) c.findAll(predicate, out);
        return out;
      },
      collectText() {
        return [this.textContent, ...children.map((c) => c.collectText())].filter(Boolean).join('\n');
      },
    };
    Object.defineProperty(node, 'innerHTML', {
      set() { throw new Error('XSS VIOLATION: innerHTML assignment is strictly forbidden'); },
      get() { return ''; },
    });
    Object.defineProperty(node, 'outerHTML', {
      set() { throw new Error('XSS VIOLATION: outerHTML assignment is strictly forbidden'); },
      get() { return ''; },
    });
    return node;
  }
  return { createElement };
}

function buildFullPassingGateEMetrics() {
  return {
    'type-sig-propagation': {
      humanEvalExecPassRate: 1.0,
      compilerTruthMismatches: 0,
      dirtyConeSyncMs: 9.4,
      pathA2ReDecompileMs: 11.2,
      r2iPathB: 1.21,
      r2iPathA1: 1.32,
    },
    'til-sdk-resolution': {
      tilHubTop1Accuracy: 0.97,
      il2cppPartialParseRecovery: 0.995,
      headerParsePeakMb: 3.1,
      sdkBatchRecovery: 0.99,
      zipBombTraversalRejectRate: 1.0,
    },
    'struct-bitfield-union': {
      idaMacroF1: 0.86,
      idaBitfieldF1: 0.74,
      idaStructF1: 0.85,
      macroF1: 0.89,
      bitfieldF1: 0.84,
      structF1: 0.88,
      falseCertaintyRate: 0.008,
    },
    'manual-recovery': {
      deltaV2RoundTripRate: 1.0,
      undoRedoRestoreRate: 1.0,
      containerOfC11CompileFailures: 0,
    },
    'region-stackweb-asm-island': {
      hugeFuncSilentFallbacks: 0,
      stackWebSplitF1: 0.93,
      nonEscapeMisSplits: 0,
      asmIslandSsaCorruptions: 0,
    },
    'hexsig-delta-porting': {
      idaFlirtSameOptF1: 0.92,
      idaFlirtCrossOptF1: 0.52,
      sameOptF1: 0.94,
      crossOptF1: 0.76,
      crossOptFpr: 0.002,
      deltaPortAccuracy: 0.97,
    },
    'cross-func-slicing-cxx-stl': {
      sliceBudgetViolations: 0,
      stackXorStringRecall: 0.94,
      stackXorStringFpr: 0.0,
      copyFindBarZeroDiffRate: 1.0,
      stlMultiInheritF1: 0.85,
    },
    'deobfuscation-cff-mba-emu': {
      cffRecoveryRate: 0.93,
      naturalFsmFalsePositiveRate: 0.0,
      mbaSimplificationRate: 0.95,
      mbaEquivProofErrors: 0,
      miniEmuDecodeRecall: 0.89,
      miniEmuOutOfBoundsWrites: 0,
    },
    'hexdb-memory-budgets': {
      hexdbXrefMissingRate: 0.0,
      hexdbQueryMedianMs: 28.5,
      mobilePeakHeapMb: 198,
      desktopPeakHeapMb: 640,
      ioTransferRatio: 0.08,
      wasmSizeRawMib: 0.82,
      wasmSizeGzipKib: 320,
    },
    'export-ui-interop-rollback-parity': {
      primaryNavLength: 4,
      missingUiFiles: 0,
      uiXssSinkCount: 0,
      exportInteropRoundTripRate: 1.0,
      wasmJsParityRate: 1.0,
      wasmExternalImports: 0,
    },
  };
}

/* ── 1. Architecture & Security Invariants ───────────────────── */

test('Invariant: PRIMARY_NAV.length === 4 untouched & zero unsafe HTML sinks in Track 10 UI', () => {
  assert.equal(PRIMARY_NAV.length, 4);
  const uiFiles = [
    'js/ui/type-edit-popover.js',
    'js/ui/slice-panel.js',
    'js/ui/export-interop.js',
    'js/ui/manual-recovery-popover.js',
  ];
  for (const rel of uiFiles) {
    const src = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    UNSAFE_HTML_SINK_RE.lastIndex = 0;
    assert.equal(UNSAFE_HTML_SINK_RE.test(src), false, `Unsafe HTML sink detected in ${rel}`);
  }
});

/* ── 2. Type-Edit Popover (js/ui/type-edit-popover.js) ───────── */

test('Type-Edit Popover: C-type syntax validation, debounce, undo/redo, XSS safety & destroy() cleanup', async () => {
  assert.equal(validateCTypeSyntax('int64_t process(void *ctx, uint32_t count)', 'function').valid, true);
  assert.equal(
    validateCTypeSyntax('int64_t __usercall f@<x0>(void *ctx@<x20>, uint64_t key@<0x10[sp]>)', 'function').valid,
    true,
  );
  assert.equal(validateCTypeSyntax('uint32_t flags : 4', 'field').valid, true);
  assert.equal(validateCTypeSyntax('Player *__shifted(Player, 0x18)', 'local').valid, true);
  assert.equal(validateCTypeSyntax('<img onerror=alert(1)>', 'local').valid, false);
  assert.equal(validateCTypeSyntax('int __usercall bad@<x0>(int a@<sp>)', 'function').valid, false);

  const fnRes = validateCTypeSyntax('int64_t my_fn(void *ctx, uint32_t n)', 'function');
  const slots = buildNotesTypeSlots('0x100004000', fnRes);
  assert.equal(slots['fn:0x100004000:ret'], 'int64_t');
  assert.equal(slots['fn:0x100004000:arg0'], 'void *ctx');

  let abortedReason = null;
  const commits = [];
  const ctrl = createTypeEditPopoverController({ onCommit: (tx) => commits.push(tx) });
  const doc = createStrictMockDocument();
  const view = renderTypeEditPopover(ctrl, { document: doc, debounceMs: 25 });

  const maliciousName = '<img src=x onerror=alert(1)>';
  assert.equal(
    ctrl.handleKeyDown(
      { key: 'Y', ctrlKey: false, metaKey: false, altKey: false },
      { kind: 'local', ref: 'loc_1', name: maliciousName, va: '0x100004120', currentType: 'uint64_t', pinned: false },
    ),
    true,
  );
  assert.equal(view.element.findAll((n) => n.tagName === 'IMG').length, 0);
  assert.ok(view.element.collectText().includes(maliciousName));

  // Debounced input test
  const inputEl = view.element.findAll((n) => n.getAttribute('data-field') === 'type-input')[0];
  inputEl.value = 'const char *';
  inputEl.dispatchEvent('input', { target: inputEl });
  assert.equal(ctrl.getState().draftText, 'uint64_t', 'Draft should be debounced initially');
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(ctrl.getState().draftText, 'const char *', 'Draft should update after debounce');

  ctrl.togglePinned(true);
  assert.equal(ctrl.commit().ok, true);
  assert.equal(commits.length, 1);

  ctrl.setActiveAbortController({ abort: (r) => { abortedReason = r; } });
  assert.equal(ctrl.undo().ok, true);
  assert.equal(abortedReason, 'undo-redo');
  assert.equal(ctrl.redo().ok, true);

  // Destroy should abort all listeners & cancel pending debounce timer
  inputEl.value = 'int32_t';
  inputEl.dispatchEvent('input', { target: inputEl });
  view.destroy();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(ctrl.getState().draftText, 'const char *', 'Debounced timer must be cleared on destroy()');

  const closeBtn = view.element.findAll((n) => n.className === 'hex-popover-close')[0];
  closeBtn.click();
  assert.equal(ctrl.getState().open, true, 'Listeners must not fire after destroy()');
});

/* ── 3. Value-Slice Panel (js/ui/slice-panel.js) ─────────────── */

test('Slice Panel: event delegation, VA jump link, deobf badges, XSS safety & destroy() cleanup', () => {
  const jumped = [];
  const ctrl = createSlicePanelController({ onJumpToVa: (payload) => jumped.push(payload) });
  const doc = createStrictMockDocument();
  const view = renderSlicePanel(ctrl, { document: doc });

  const xssFunc = '"><script>alert(1)</script>';
  ctrl.openSlice({
    direction: 'backward',
    rootTarget: { va: '0x100004200', funcVa: '0x100004100', funcName: xssFunc, varName: 'x0' },
    steps: [
      {
        va: '0x100004140',
        funcVa: '0x100004100',
        funcName: xssFunc,
        expr: 'x0 = dec_str("https://api.example")',
        role: 'source',
        depth: 0,
        deobfBadges: [{ kind: 'emu-str', detail: 'MiniArm64Emu' }, { kind: 'mba', detail: '(x^y)+2*(x&y) -> x+y' }],
      },
    ],
    budgetStatus: { visitedNodes: 256, maxNodes: 256, depth: 4, maxDepth: 4, truncated: true },
  });

  assert.equal(view.element.findAll((n) => n.tagName === 'SCRIPT').length, 0);
  const vaBtn = view.element.findAll((n) => n.getAttribute('data-va') === '0x100004140')[0];
  // Event delegation: vaBtn itself has zero direct listeners; click bubbles to listEl
  assert.equal((vaBtn._getListeners('click')?.size ?? 0), 0);
  vaBtn.click();
  assert.equal(jumped.length, 1);
  assert.equal(jumped[0].va, '0x100004140');

  // After destroy(), clicking VA button or direction toggle must NOT fire
  view.destroy();
  vaBtn.click();
  assert.equal(jumped.length, 1, 'Delegated listener must not fire after destroy()');
});

/* ── 4. Export / Import Interop & Injection Hardening ────────── */

test('Export Interop: C header & Frida injection defense, 64-bit BigInt VAs, deep validation & destroy() cleanup', () => {
  const highVa1 = '0xffff000010000004';
  const highVa2 = '0xffff000010000020';
  const model = {
    binarySha256: 'deadbeef1234',
    binaryName: 'game_arm64',
    arch: 'arm64',
    imageBase: '0xffff000010000000',
    enums: [{ name: 'ItemKind', values: [{ name: 'ITEM_NONE', value: 0 }, { name: 'ITEM_SWORD', value: 1 }] }],
    structs: [
      {
        name: 'Outer',
        size: 32,
        align: 8,
        members: [
          { offset: 0, name: 'inner', type: 'Inner', size: 8 },
          // C header injection payload in member type
          { offset: 8, name: 'evil_field', type: 'int; #include <evil.h> //', size: 4 },
          { offset: 12, name: 'flags', type: 'uint32_t', size: 4, bfLsb: 0, bfWidth: 4 },
        ],
      },
      {
        name: 'Inner',
        size: 8,
        align: 8,
        members: [{ offset: 0, name: 'id', type: 'uint64_t', size: 8 }],
      },
    ],
    globals: [{ va: highVa2, name: 'g_evil', type: 'int; system("id");' }],
    functions: [
      {
        va: highVa1,
        name: 'foo"); alert(1); //\u2028evil_line()',
        sig: 'void evil(void) { system("id"); }',
        comment: 'tick */ injection',
        pinned: true,
        params: [{ name: 'p"); pwn(); //', type: 'char *' }],
      },
    ],
    shiftedPtrs: [{ varKey: 'arg:0', parentType: 'Outer', shiftOffset: 12 }],
  };

  // C header injection must be Fail-Closed sanitized
  const header = exportCHeader(model);
  assert.equal(header.includes('#include <evil.h>'), false);
  assert.equal(header.includes('system("id")'), false);
  assert.ok(header.includes('uint32_t evil_field;'));
  assert.ok(header.includes('extern uintptr_t g_evil;'));
  assert.ok(header.indexOf('struct Inner {') < header.indexOf('struct Outer {'));

  // Frida snippet must serialize fn name and param name with JSON.stringify and strip U+2028/newlines from comments
  const frida = exportFridaSnippet(model.functions[0], model);
  assert.ok(frida.includes('base.add(0x4)'), '64-bit BigInt RVA must be exact (0x4)');
  assert.equal(frida.includes('\u2028'), false);
  assert.ok(frida.includes('console.log("[enter]", "foo\\"); alert(1); //\\u2028evil_line()")')
    || frida.includes(JSON.stringify(model.functions[0].name)));

  // Deep validation & deep clone in importInteropJson
  const badEnum = importInteropJson({
    schema: INTEROP_SCHEMA_ID,
    functions: [],
    structs: [],
    globals: [],
    enums: [{ name: 'E', values: [{ name: 'A', value: 'not-an-int' }] }],
  });
  assert.equal(badEnum.ok, false);

  const validInterop = exportInteropJson(model);
  const imp = importInteropJson(validInterop);
  assert.equal(imp.ok, true);
  // Deep clone check: mutating source does not mutate imported model
  validInterop.enums[0].values[0].name = 'MUTATED';
  assert.equal(imp.model.enums[0].values[0].name, 'ITEM_NONE');

  // Modal destroy() aborts listeners
  const modalCtrl = createExportInteropController({ model });
  const doc = createStrictMockDocument();
  const modalView = renderExportInteropModal(modalCtrl, { document: doc });
  modalCtrl.open({ format: 'c-header' });
  modalView.destroy();
  const tabBtn = modalView.element.findAll((n) => n.getAttribute('data-format') === 'interop-json')[0];
  tabBtn.click();
  assert.equal(modalCtrl.getState().format, 'c-header', 'Modal listeners must not fire after destroy()');
});

/* ── 5. delta-session.js v1->v2, 512 KiB, Proto Pollution & Mutual Round-Trip */

test('delta-session.js: v1->v2 migration, 512 KiB cap, prototype pollution, pinnedMasks & export-interop round-trip', () => {
  // 1. Mutual round-trip: exportHexDbDeltaBundle -> parseDeltaJson -> serializeDeltaJson -> importHexDbDeltaBundle
  const exported = exportHexDbDeltaBundle({
    binarySha256: 'abcdef0123456789',
    binaryName: 'sample.bin',
    names: { '0x100004000': 'main_entry' },
    displayHints: { '0x100004010': { radix: 'hex' } },
    manualSegments: [{ startVa: '0x100004000', byteLen: 16, kind: MANUAL_SEG_KINDS.CODE }],
    funcChunks: [{ funcVa: '0x100004000', startVa: '0x100009000', endVa: '0x100009040' }],
    customAbis: [{ funcVa: '0x100004000', cc: '__usercall', spPurgeBytes: 16, args: [{ decl: 'void *ctx', loc: 'x20' }] }],
    stackSlotOverrides: [{ funcVa: '0x100004000', spOffset: 32, byteSize: 8, type: 'uint64_t' }],
    shiftedPtrs: [{ funcVa: '0x100004000', varKey: 'arg:0', parentType: 'Node', shiftOffset: 16 }],
    pinnedMasks: { '0x100004000': 0x7ffff },
  });

  const parsedByDelta = parseDeltaJson(exported.json);
  assert.equal(parsedByDelta.ok, true, `parseDeltaJson failed: ${parsedByDelta.error}`);
  assert.equal(parsedByDelta.record.version, DELTA_SESSION_VERSION);
  assert.equal(parsedByDelta.record.delta.manualSegments.length, 1);
  assert.equal(parsedByDelta.record.delta.customAbis.length, 1);
  assert.equal(parsedByDelta.record.delta.stackSlotOverrides.length, 1);
  assert.equal(parsedByDelta.record.delta.shiftedPtrs.length, 1);
  assert.equal(parsedByDelta.record.delta.pinnedMasks['0x100004000'], 0x7ffff);
  assert.ok(countDeltaItems(parsedByDelta.record.delta) >= 7);

  const reserialized = serializeDeltaJson(parsedByDelta.record);
  const backToInterop = importHexDbDeltaBundle(reserialized);
  assert.equal(backToInterop.ok, true);
  assert.equal(backToInterop.state.pinnedMasks['0x100004000'], 0x7ffff);

  // 2. Lossless v1->v2 migration of structOverrides (both array and object forms)
  const v1ArrayJson = JSON.stringify({
    format: DELTA_SESSION_FORMAT,
    version: 1,
    fingerprint: { sha256: 'aabbcc' },
    delta: {
      structOverrides: [{ va: '0x100005000', size: 24, structName: 'LegacyArr' }],
    },
  });
  const m1 = parseDeltaJson(v1ArrayJson);
  assert.equal(m1.ok, true);
  assert.equal(m1.record.delta.manualSegments.length, 1);
  assert.equal(m1.record.delta.manualSegments[0].startVa, '0x100005000');
  assert.equal(m1.record.delta.manualSegments[0].structName, 'LegacyArr');

  const v1ObjJson = JSON.stringify({
    format: DELTA_SESSION_FORMAT,
    version: 1,
    fingerprint: { sha256: 'aabbcc' },
    delta: {
      structOverrides: { '0x100006000': { size: 16, structName: 'LegacyObj' } },
    },
  });
  const m2 = parseDeltaJson(v1ObjJson);
  assert.equal(m2.ok, true);
  assert.equal(m2.record.delta.manualSegments.length, 1);
  assert.equal(m2.record.delta.manualSegments[0].startVa, '0x100006000');

  // 3. serializeDeltaJson > 512 KiB throws
  const hugeAnnotations = Array.from({ length: 700 }, (_, i) => ({ id: i, text: 'A'.repeat(1000) }));
  assert.throws(
    () => serializeDeltaJson({ delta: { projectAnnotations: hugeAnnotations } }),
    (err) => err && err.code === 'DELTA_JSON_TOO_LARGE',
  );

  // 4. parseDeltaJson & _readLsRecents reject prototype pollution
  const pollutedDelta = '{"format":"hex-delta-session","version":2,"delta":{"__proto__":{"pwn":1}}}';
  const polRes = parseDeltaJson(pollutedDelta);
  assert.equal(polRes.ok, false);
  assert.equal(polRes.error, 'delta-json-forbidden-key');

  const fakeLs = new Map([
    ['hex.delta.v1.recents', '[{"deltaKey":"k1","__proto__":{"polluted":true}}]'],
  ]);
  const store = new DeltaSessionStore({
    indexedDB: null,
    localStorage: {
      getItem: (k) => fakeLs.get(k) ?? null,
      setItem: (k, v) => fakeLs.set(k, v),
      removeItem: (k) => fakeLs.delete(k),
      get length() { return fakeLs.size; },
      key: (i) => [...fakeLs.keys()][i] ?? null,
    },
  });
  assert.deepEqual(store._readLsRecents(), []);
});

/* ── 6. Manual Recovery Popover (BigInt 64-bit VA & destroy()) ─ */

test('Manual Recovery Popover: 64-bit BigInt VAs, validators, undo/redo, XSS safety & destroy() cleanup', () => {
  assert.equal(validateManualSegment({ startVa: '0xffff000010000002', byteLen: 4, kind: MANUAL_SEG_KINDS.CODE }, { arch: 'arm64' }).valid, false);
  assert.equal(validateManualSegment({ startVa: '0xffff000010000004', byteLen: 4, kind: MANUAL_SEG_KINDS.CODE }, { arch: 'arm64' }).valid, true);
  assert.equal(validateFuncChunk({ funcVa: '0xffff000010000000', startVa: '0xffff000010000004', endVa: '0xffff000010000008' }).valid, true);
  assert.equal(
    validateCustomAbi({
      funcVa: '0x1000',
      signature: 'int64_t __userpurge f@<x0>(void *a@<x20>, uint64_t b@<0x10[sp]>) __purge(0x10)',
    }).valid,
    true,
  );
  assert.equal(
    validateStackSlotOverride({ funcVa: '0x1000', spOffset: 16, byteSize: 8, type: 'uint64_t', forceSplit: true, forceMerge: true }).valid,
    false,
  );
  const shifted = validateShiftedPtr({ funcVa: '0x1000', varKey: 'arg:0', parentType: 'Node', shiftOffset: 24 });
  assert.equal(shifted.valid, true);
  assert.equal(shifted.normalized.pathB, 'HEX_CONTAINER_OF(arg:0, Node, 0x18)');

  const ctrl = createManualRecoveryPopoverController({ arch: 'arm64' });
  const doc = createStrictMockDocument();
  const view = renderManualRecoveryPopover(ctrl, { document: doc });

  ctrl.open('stack');
  assert.equal(ctrl.setStackSlotOverride({
    funcVa: '0xffff000010000004',
    spOffset: 32,
    byteSize: 8,
    type: 'uint64_t',
    name: '<img onerror=alert(1)>',
    forceSplit: true,
  }).ok, true);
  assert.equal(view.element.findAll((n) => n.tagName === 'IMG').length, 0);
  assert.ok(view.element.collectText().includes('<img onerror=alert(1)>'));

  view.destroy();
  const segTabBtn = view.element.findAll((n) => n.getAttribute('data-tab') === 'segment')[0];
  segTabBtn.click();
  assert.equal(ctrl.getState().activeTab, 'stack', 'Manual recovery listeners must not fire after destroy()');
});

/* ── 7. Gate E 10-Axis Scorecard (Fail-Closed UNMEASURED vs PASS) */

test('Gate E Scorecard: default local probe reports UNMEASURED (exit 1), NaN/missing UI FAIL, and full --input PASS (exit 0)', () => {
  assert.equal(GATE_E_AXES.length, 10);

  // 1. Default local probe (no --input): probes real wasm + UI files, unmeasured external axes -> UNMEASURED (exit 1)
  const localMetrics = collectLocalMetrics(REPO_ROOT);
  assert.equal(localMetrics['export-ui-interop-rollback-parity'].primaryNavLength, 4);
  assert.equal(localMetrics['export-ui-interop-rollback-parity'].missingUiFiles, 0);
  assert.equal(localMetrics['export-ui-interop-rollback-parity'].uiXssSinkCount, 0);
  assert.equal(localMetrics['export-ui-interop-rollback-parity'].exportInteropRoundTripRate, 1.0);
  assert.equal(localMetrics['export-ui-interop-rollback-parity'].wasmExternalImports, 0);
  assert.ok(localMetrics['hexdb-memory-budgets'].wasmSizeRawMib > 0 && localMetrics['hexdb-memory-budgets'].wasmSizeRawMib <= 1.40);
  assert.ok(localMetrics['hexdb-memory-budgets'].wasmSizeGzipKib > 0 && localMetrics['hexdb-memory-budgets'].wasmSizeGzipKib <= 520);

  const defaultResult = evaluateGateEScorecard(localMetrics);
  assert.equal(defaultResult.schema, GATE_E_SCHEMA_ID);
  assert.equal(defaultResult.verdict, 'UNMEASURED');
  assert.equal(defaultResult.passed, false);
  assert.equal(defaultResult.exitCode, 1);
  assert.ok(defaultResult.summary.axesUnmeasured > 0);
  assert.equal(defaultResult.summary.disqualifiers, 0);

  // 2. NaN / non-numeric metric and missing UI file -> immediate disqualifier FAIL
  const badMetrics = buildFullPassingGateEMetrics();
  badMetrics['struct-bitfield-union'].falseCertaintyRate = Number.NaN;
  badMetrics['export-ui-interop-rollback-parity'].missingUiFiles = 1;
  const nanFail = evaluateGateEScorecard(badMetrics);
  assert.equal(nanFail.verdict, 'FAIL');
  assert.equal(nanFail.exitCode, 1);
  assert.ok(nanFail.summary.disqualifiers >= 2);

  // 3. Complete passing --input -> BEYOND_IDA_TOTAL_PASS (exit 0)
  const fullPassMetrics = buildFullPassingGateEMetrics();
  const passResult = evaluateGateEScorecard(fullPassMetrics);
  assert.equal(passResult.verdict, 'BEYOND_IDA_TOTAL_PASS');
  assert.equal(passResult.exitCode, 0);
  assert.equal(passResult.summary.axesPassed, 10);
  assert.equal(formatGateEJson(passResult), formatGateEJson(evaluateGateEScorecard(fullPassMetrics)));
  assert.ok(formatGateETable(passResult).includes('BEYOND_IDA_TOTAL_PASS'));

  // 4. CLI checks: default run -> exit 1 (UNMEASURED), --input passing -> exit 0 (BEYOND_IDA_TOTAL_PASS)
  const scriptPath = path.join(REPO_ROOT, 'tools/validation/public-benchmark/gate-e-scorecard.mjs');
  const cliDefault = spawnSync(process.execPath, [scriptPath, '--format', 'json'], { encoding: 'utf8' });
  assert.equal(cliDefault.status, 1, 'Default CLI without --input must exit 1 (UNMEASURED)');
  assert.equal(JSON.parse(cliDefault.stdout).verdict, 'UNMEASURED');

  const tmpPass = path.join(os.tmpdir(), `gate-e-pass-${Date.now()}.json`);
  fs.writeFileSync(tmpPass, JSON.stringify(fullPassMetrics), 'utf8');
  try {
    const cliPass = spawnSync(process.execPath, [scriptPath, '--input', tmpPass, '--format', 'json'], { encoding: 'utf8' });
    assert.equal(cliPass.status, 0, cliPass.stderr);
    assert.equal(JSON.parse(cliPass.stdout).verdict, 'BEYOND_IDA_TOTAL_PASS');
  } finally {
    fs.unlinkSync(tmpPass);
  }
});
