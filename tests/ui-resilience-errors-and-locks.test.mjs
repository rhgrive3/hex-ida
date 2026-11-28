import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { t, setLang } from '../js/i18n.js';
import { formatProjectError } from '../js/project/errors.js';
import { App } from '../js/app.js';
import { NoteStore } from '../js/names.js';
import { isTruncatedWithoutFunctions } from '../js/ui/product-base.js';

const appSrc = fs.readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
const productBaseSrc = fs.readFileSync(new URL('../js/ui/product-base.js', import.meta.url), 'utf8');

function makeClassList() {
  const set = new Set();
  return {
    add: (...cls) => { for (const c of cls) set.add(c); },
    remove: (...cls) => { for (const c of cls) set.delete(c); },
    toggle: (c, force) => { if (force === undefined) { if (set.has(c)) set.delete(c); else set.add(c); } else if (force) set.add(c); else set.delete(c); },
    contains: (c) => set.has(c),
  };
}

function makeMockStore(initial = {}) {
  const data = { ...initial };
  return {
    get: (k) => data[k],
    set: (patch) => Object.assign(data, patch),
    _data: data,
  };
}

test('i18n defines all Track 9 resilience keys in ja and en', () => {
  const keys = [
    'status.saveFailed',
    'err.fileLoading',
    'err.truncatedBannerTitle',
    'err.warningBannerTitle',
    'err.truncatedBannerDetail',
    'err.truncatedNoFunctions',
  ];
  for (const locale of ['ja', 'en']) {
    setLang(locale);
    for (const key of keys) {
      const value = t(key);
      assert.equal(typeof value, 'string');
      assert.ok(value.length > 0 && value !== key, `missing ${locale} translation for ${key}`);
    }
  }
  setLang('ja');
});

test('app.js preserves ProductWorkspace regex contracts and wires shared NotesIdbBackend', () => {
  assert.match(appSrc, /import\s*\{\s*isNotesIdbAvailable,\s*NotesIdbBackend\s*\}\s*from\s*'\.\/platform\/notes-idb\.js';/);
  assert.match(appSrc, /import\s*\{\s*formatProjectError\s*\}\s*from\s*'\.\/project\/errors\.js';/);
  assert.match(appSrc, /this\.notesIdb\s*=\s*isNotesIdbAvailable\(\)\s*\?\s*new NotesIdbBackend\(\)\s*:\s*null;/);
  assert.match(appSrc, /new ProductWorkspace\(this\)/);
  assert.match(appSrc, /this\.workspace\.setIdb\?\.\(this\.notesIdb\);/);
  assert.match(appSrc, /this\.workspace\.onAutosaveError\s*=\s*\(err\)\s*=>\s*this\._reportSaveError\(err\);/);
  assert.match(appSrc, /this\.workspace\.onAutosaveSuccess\s*=\s*\(\)\s*=>\s*this\._clearSaveError\(\);/);
  assert.match(appSrc, /workspace\?\.autosave\(\)/);
  assert.match(appSrc, /this\.workspace\?\.autosave\(\{\s*immediate:\s*true\s*\}\);/);
});

test('app.js replaces all 4 rename loops with _applySymbolRenames / renameMany', () => {
  assert.match(appSrc, /_applySymbolRenames\(entries,\s*\{\s*replace\s*=\s*false\s*\}\s*=\s*\{\}\)/);
  assert.match(appSrc, /this\.symbols\.renameMany\(entries,\s*\{\s*replace\s*\}\)/);
  const calls = appSrc.match(/this\._applySymbolRenames\(/g) || [];
  assert.ok(calls.length >= 5, `expected at least 5 _applySymbolRenames calls, got ${calls.length}`);
  assert.doesNotMatch(appSrc, /for\s*\(\s*const\s+\w+\s+of\s+(?:this\.)?notes\.nameEntries\(\)\s*\)\s*this\.symbols\.rename\(/);
});

test('app.js wires integrity banner and MH_OBJECT relocations in applySlice/openFile', () => {
  assert.match(appSrc, /integrityBanner:\s*\$\('integrity-banner'\)/);
  assert.match(appSrc, /this\.viewer\?\.setRelocations\?\.\(slice\?\.info\?\.relocations\s*\|\|\s*\[\],\s*\{\s*isRelocatableObject:\s*slice\?\.info\?\.filetype\s*===\s*1\s*\}\);/);
  const bannerCalls = appSrc.match(/this\._renderIntegrityBanner\(/g) || [];
  assert.ok(bannerCalls.length >= 2, 'expected _renderIntegrityBanner in both openFile and applySlice');
});

test('runtime: openFile openSeq race keeps fileLoading locked until latest open finishes, and onKey blocks shortcuts during fileLoading', async () => {
  const prevDoc = globalThis.document;
  const bodyClassList = makeClassList();
  const dispatched = [];
  globalThis.document = {
    body: { classList: bodyClassList },
    dispatchEvent: (ev) => dispatched.push(ev),
    getElementById: () => null,
  };
  try {
    const app = Object.create(App.prototype);
    app._openSequence = 0;
    app.store = makeMockStore({ fileLoading: false });
    app.dom = {
      app: { classList: makeClassList() },
      loading: { hidden: true },
      loadingText: { textContent: '' },
      integrityBanner: { hidden: true, textContent: '' },
    };
    const autosaveCalls = [];
    app.workspace = {
      autosave: (opts) => autosaveCalls.push(opts),
      invalidate: () => {},
      bind: async () => null,
    };
    app.flushDeltaSave = () => {};
    app.persistAnalysisSession = () => {};
    app.updateChrome = () => {};
    app.forgetSemantics = () => {};
    app.viewer = { setSymbols: () => {}, setRelocations: () => {}, invalidate: () => {} };
    app._resetDeltaReadiness = () => {};
    app._undoStack = [];
    app._redoStack = [];
    let disposedOldNotes = 0;
    app.notes = { dispose: () => { disposedOldNotes++; } };
    app.bookmarks = { clear: () => {} };
    app._createPatchSet = () => ({});
    app.applySlice = () => {};
    app.attachNotes = async () => null;
    app.analysisResume = { saveLastFile: async () => {}, updateLastFileMeta: async () => {} };
    app.restoreAnalysisSession = async () => false;
    app.restoreDeltaSession = async () => {};
    app._startV6AutoAnalysis = () => {};

    let resolveFirst, resolveSecond;
    let callCount = 0;
    app.backend = {
      gen: 0,
      binaryId: 'bin_sha256_' + 'a'.repeat(64),
      open: () => new Promise((resolve, reject) => {
        callCount++;
        if (callCount === 1) resolveFirst = { resolve, reject };
        else resolveSecond = { resolve, reject };
      }),
    };

    const f1 = { name: 'first.bin', size: 100 };
    const f2 = { name: 'second.bin', size: 200 };
    const p1 = app.openFile(f1);
    assert.equal(app.store.get('fileLoading'), true);
    assert.equal(app.dom.app.classList.contains('is-file-loading'), true);
    assert.equal(bodyClassList.contains('is-file-loading'), true);
    assert.deepEqual(autosaveCalls[0], { immediate: true });

    // onKey must block shortcuts while fileLoading is true
    let keyPrevented = false;
    app.onKey({
      defaultPrevented: false,
      key: 'f',
      metaKey: true,
      ctrlKey: false,
      target: null,
      preventDefault: () => { keyPrevented = true; },
    });
    assert.equal(keyPrevented, true, 'onKey must preventDefault and return while fileLoading is true');

    // Start second openFile while first is still pending
    const p2 = app.openFile(f2);
    assert.equal(app._openSequence, 2);

    // First fails as stale; its finally must NOT clear fileLoading because openSeq (1) !== _openSequence (2)
    resolveFirst.reject(Object.assign(new Error('stale'), { stale: true }));
    await p1;
    assert.equal(app.store.get('fileLoading'), true, 'stale first openFile must not unlock active second openFile');
    assert.equal(bodyClassList.contains('is-file-loading'), true);

    // Second succeeds and unlocks cleanly
    app.backend.gen = 2;
    resolveSecond.resolve({ name: 'second.bin', size: 200, slices: [] });
    await p2;
    assert.equal(app.store.get('fileLoading'), false);
    assert.equal(app.dom.app.classList.contains('is-file-loading'), false);
    assert.equal(bodyClassList.contains('is-file-loading'), false);
    assert.equal(disposedOldNotes, 1, 'previous NoteStore must be disposed before replacing with EMPTY_NOTES');
  } finally {
    globalThis.document = prevDoc;
  }
});

test('runtime: _reportSaveError throttles toasts (10s), deduplicates #st-right badge, and _clearSaveError restores clean state', () => {
  setLang('ja');
  const prevDoc = globalThis.document;
  const toasts = [];
  const makeNode = (tag) => ({
    tagName: tag,
    className: '',
    textContent: '',
    classList: makeClassList(),
    setAttribute: () => {},
    append: (...nodes) => { for (const n of nodes) toasts.push(n); },
    remove: () => {},
    querySelector: () => null,
  });
  const overlays = makeNode('div');
  globalThis.document = {
    createElement: (tag) => makeNode(tag),
    getElementById: (id) => (id === 'overlays' ? overlays : null),
    body: overlays,
  };
  const app = Object.create(App.prototype);
  app._lastSaveErrorToastAt = 0;
  app._saveErrorActive = false;
  app._lastSaveErrorMessage = '';
  const stClass = makeClassList();
  app.dom = { stRight: { textContent: '1 / 100', title: '', classList: stClass } };

  const realNow = Date.now;
  let fakeNow = 20_000;
  Date.now = () => fakeNow;
  try {
    app._reportSaveError({ code: 'QUOTA_EXCEEDED' });
    assert.equal(app._saveErrorActive, true);
    assert.equal(stClass.contains('status-save-error'), true);
    assert.equal(app.dom.stRight.textContent, `1 / 100 · ${t('status.saveFailed')}`);
    assert.equal(app._lastSaveErrorToastAt, 20_000);
    assert.equal(toasts.length, 1);
    const firstToastText = toasts[0].textContent;
    assert.equal(firstToastText, formatProjectError({ code: 'QUOTA_EXCEEDED' }, 'ja'));
    assert.doesNotMatch(app.dom.stRight.title, /QUOTA_EXCEEDED/);

    // Calling again within 10s must NOT duplicate badge or update toast
    fakeNow = 25_000;
    app._reportSaveError({ code: 'TOO_LARGE' });
    assert.equal(app.dom.stRight.textContent, `1 / 100 · ${t('status.saveFailed')}`);
    assert.equal(app._lastSaveErrorToastAt, 20_000, 'toast must be throttled within 10s window');
    assert.equal(toasts[0].textContent, firstToastText, 'throttled call must not replace active toast');

    // Calling after 10s updates toast with the new formatted message
    fakeNow = 31_000;
    app._reportSaveError({ code: 'IDB_ERROR' });
    assert.equal(app._lastSaveErrorToastAt, 31_000, 'toast should fire again after 10s window');
    assert.equal(toasts[0].textContent, formatProjectError({ code: 'IDB_ERROR' }, 'ja'));

    // _clearSaveError restores clean status text and removes class
    app._clearSaveError();
    assert.equal(app._saveErrorActive, false);
    assert.equal(stClass.contains('status-save-error'), false);
    assert.equal(app.dom.stRight.textContent, '1 / 100');
    assert.equal(app.dom.stRight.title, '');
  } finally {
    Date.now = realNow;
    globalThis.document = prevDoc;
  }
});

test('runtime: _renderIntegrityBanner differentiates truncated vs warning-only titles, deduplicates warnings, and hides on clean files', () => {
  setLang('ja');
  const app = Object.create(App.prototype);
  const banner = { hidden: true, textContent: '', ownerDocument: null };
  app.dom = { integrityBanner: banner };

  // Truncated file -> truncatedBannerTitle
  app._renderIntegrityBanner({ truncated: true, warnings: ['seg overflow', 'seg overflow'] }, { info: { diagnostics: ['seg overflow', 'bad lc'] } });
  assert.equal(banner.hidden, false);
  assert.ok(banner.textContent.includes(t('err.truncatedBannerTitle')));
  assert.ok(banner.textContent.includes('seg overflow / bad lc'), 'warnings must be deduplicated');

  // Non-truncated file with warnings only -> warningBannerTitle
  app._renderIntegrityBanner({ truncated: false, warnings: ['non-fatal note'] }, null);
  assert.equal(banner.hidden, false);
  assert.ok(banner.textContent.includes(t('err.warningBannerTitle')));
  assert.ok(!banner.textContent.includes(t('err.truncatedBannerTitle')));

  // Clean file -> hidden
  app._renderIntegrityBanner({ truncated: false, warnings: [] }, { info: { diagnostics: [] } });
  assert.equal(banner.hidden, true);
  assert.equal(banner.textContent, '');
});

test('runtime: attachNotes disposes notes when hydrateFromIdb throws and remote-sync skips scheduleDeltaSave/autosave', async () => {
  const prevDoc = globalThis.document;
  globalThis.document = { dispatchEvent: () => {} };
  try {
    const file = new Blob([new Uint8Array([1, 2, 3, 4])]);
    file.name = 'test.bin';
    const info = { name: 'test.bin', size: 4, slices: [{ offset: 0n, size: 4n, info: { uuid: 'U1' } }] };

    // 1. hydrateFromIdb throws -> NoteStore is disposed before returning null
    let disposeCalls = 0;
    const origDispose = NoteStore.prototype.dispose;
    const origHydrate = NoteStore.prototype.hydrateFromIdb;
    NoteStore.prototype.dispose = function (...args) { disposeCalls++; return origDispose.apply(this, args); };
    NoteStore.prototype.hydrateFromIdb = async () => { throw new Error('idb-boom'); };
    try {
    const appFail = Object.create(App.prototype);
    appFail.store = makeMockStore({ file, sliceIndex: 0 });
    appFail.backend = { gen: 1, ensureBinaryId: async () => 'bin_sha256_' + '1'.repeat(64) };
    appFail.notes = null;
    appFail.notesIdb = {
      loadStore: async () => { throw new Error('idb-boom'); },
    };
    appFail._reportSaveError = () => {};
    appFail._clearSaveError = () => {};
    const resFail = await appFail.attachNotes(file, info, 0, 1);
    assert.equal(resFail, null, 'attachNotes must return null when hydrateFromIdb throws');
    assert.equal(appFail.notes, null, 'failed notes must not be assigned to app.notes');
    assert.equal(disposeCalls, 1, 'notes.dispose() must be called in catch when hydrateFromIdb throws');
    } finally {
      NoteStore.prototype.dispose = origDispose;
      NoteStore.prototype.hydrateFromIdb = origHydrate;
    }

    // 2. Successful attachNotes + remote-sync skips scheduleDeltaSave & workspace.autosave
    const appOk = Object.create(App.prototype);
    appOk.store = makeMockStore({ file, sliceIndex: 0 });
    appOk.backend = { gen: 1, ensureBinaryId: async () => 'bin_sha256_' + '2'.repeat(64) };
    appOk.notes = null;
    appOk.notesIdb = null;
    let deltaSaves = 0;
    let autosaves = 0;
    let renameManyCalls = 0;
    let invalidates = 0;
    appOk.scheduleDeltaSave = () => { deltaSaves++; };
    appOk.workspace = { autosave: () => { autosaves++; } };
    appOk.symbols = { renameMany: () => { renameManyCalls++; return 1; } };
    appOk.viewer = { setSymbols: () => {}, invalidate: () => { invalidates++; } };
    appOk.syncSymbolsStore = () => {};
    appOk.updateChrome = () => {};
    appOk._reportSaveError = () => {};
    appOk._clearSaveError = () => {};

    const attached = await appOk.attachNotes(file, info, 0, 1);
    assert.ok(attached, 'attachNotes must return attached NoteStore');
    const initialRenameMany = renameManyCalls;
    attached.onChange({ kind: 'remote-sync', remote: true });
    assert.equal(deltaSaves, 0, 'remote-sync must NOT trigger scheduleDeltaSave');
    assert.equal(autosaves, 0, 'remote-sync must NOT trigger workspace.autosave');
    assert.equal(renameManyCalls, initialRenameMany + 1, 'remote-sync must batch-update symbols via renameMany');
    assert.ok(invalidates >= 1, 'remote-sync must invalidate viewer');

    // Local change triggers both
    attached.onChange({ kind: 'name', remote: false });
    assert.equal(deltaSaves, 1);
    assert.equal(autosaves, 1);
    attached.dispose?.();
  } finally {
    globalThis.document = prevDoc;
  }
});

test('runtime: isTruncatedWithoutFunctions avoids false positive before symbolsReady when canDisassemble is true', () => {
  const truncatedInfo = { truncated: true, slices: [{ info: { truncated: true } }] };

  // Still analyzing (canDisassemble: true, symbolsReady: false) -> must NOT block
  assert.equal(isTruncatedWithoutFunctions({
    store: makeMockStore({ fileInfo: truncatedInfo, sliceIndex: 0, canDisassemble: true, symbolsReady: false }),
    symbols: { functionCount: 0 },
  }), false);

  // Analysis finished (symbolsReady: true) with 0 functions -> MUST block
  assert.equal(isTruncatedWithoutFunctions({
    store: makeMockStore({ fileInfo: truncatedInfo, sliceIndex: 0, canDisassemble: true, symbolsReady: true }),
    symbols: { functionCount: 0 },
  }), true);

  // Cannot disassemble (canDisassemble: false) with 0 functions -> MUST block even if symbolsReady is false
  assert.equal(isTruncatedWithoutFunctions({
    store: makeMockStore({ fileInfo: truncatedInfo, sliceIndex: 0, canDisassemble: false, symbolsReady: false }),
    symbols: { functionCount: 0 },
  }), true);

  // Analysis finished with >0 functions -> must NOT block
  assert.equal(isTruncatedWithoutFunctions({
    store: makeMockStore({ fileInfo: truncatedInfo, sliceIndex: 0, canDisassemble: true, symbolsReady: true }),
    symbols: { functionCount: 3 },
  }), false);
});

test('product-base.js guards fileLoading, truncated-zero-function goals, and uses formatProjectError everywhere', () => {
  assert.match(productBaseSrc, /import\s*\{\s*formatProjectError\s*\}\s*from\s*'\.\.\/project\/errors\.js';/);
  assert.match(productBaseSrc, /function guardFileLoading\(app\)/);
  assert.match(productBaseSrc, /export function isTruncatedWithoutFunctions\(app\)/);
  assert.match(productBaseSrc, /function guardGoalAction\(app\)/);
  assert.match(productBaseSrc, /function buildTruncatedGoalWarning\(\)/);
  assert.match(productBaseSrc, /function requireFile\(app,\s*action\)\s*\{\s*if\s*\(guardFileLoading\(app\)\)\s*return null;/);
  assert.match(productBaseSrc, /function runInvestigation\(app,\s*query\)\s*\{\s*if\s*\(!guardGoalAction\(app\)\)\s*return null;/);

  const formatCalls = productBaseSrc.match(/formatProjectError\(/g) || [];
  assert.ok(formatCalls.length >= 6, `expected formatProjectError in all project/delta handlers, got ${formatCalls.length}`);

  const warnCalls = productBaseSrc.match(/buildTruncatedGoalWarning\(\)/g) || [];
  assert.ok(warnCalls.length >= 2, `expected buildTruncatedGoalWarning in quickstart & investigate, got ${warnCalls.length}`);

  // Verify formatProjectError hides raw codes
  const jaQuota = formatProjectError({ code: 'QUOTA_EXCEEDED' }, 'ja');
  assert.doesNotMatch(jaQuota, /QUOTA_EXCEEDED/);
  assert.match(jaQuota, /保存容量|書き出し/);
});

test('runtime: openFile unlocks fileLoading in finally even when setBusy or updateChrome throws before backend.open', async () => {
  const prevDoc = globalThis.document;
  const bodyClassList = makeClassList();
  globalThis.document = {
    body: { classList: bodyClassList },
    dispatchEvent: () => {},
    getElementById: () => null,
  };
  try {
    const app = Object.create(App.prototype);
    app._openSequence = 0;
    app.store = makeMockStore({ fileLoading: false });
    app.dom = {
      app: { classList: makeClassList() },
      loading: { hidden: true },
      loadingText: { textContent: '' },
    };
    app.workspace = { autosave: () => {} };
    app.flushDeltaSave = () => {};
    app.persistAnalysisSession = () => {};
    let busyCalls = 0;
    app.setBusy = (on) => {
      busyCalls++;
      if (on) throw new Error('setBusy-boom');
    };
    app.updateChrome = () => {};

    await assert.rejects(() => app.openFile({ name: 'bad.bin', size: 10 }), /setBusy-boom/);
    assert.equal(busyCalls, 2, 'finally must still call setBusy(false)');
    assert.equal(app.store.get('fileLoading'), false, 'fileLoading must be unlocked when setup throws');
    assert.equal(app.dom.app.classList.contains('is-file-loading'), false);
    assert.equal(bodyClassList.contains('is-file-loading'), false);
  } finally {
    globalThis.document = prevDoc;
  }
});

test('runtime: _clearSaveError removes previously attached badge after language switch and openFile clears save error on new file', async () => {
  setLang('ja');
  const prevDoc = globalThis.document;
  const makeNode = (tag) => ({
    tagName: tag,
    className: '',
    textContent: '',
    classList: makeClassList(),
    setAttribute: () => {},
    append: () => {},
    remove: () => {},
    querySelector: () => null,
  });
  const overlays = makeNode('div');
  const bodyClassList = makeClassList();
  globalThis.document = {
    createElement: (tag) => makeNode(tag),
    getElementById: (id) => (id === 'overlays' ? overlays : null),
    body: { ...overlays, classList: bodyClassList },
    dispatchEvent: () => {},
  };
  try {
    const app = Object.create(App.prototype);
    app._lastSaveErrorToastAt = 0;
    app._saveErrorActive = false;
    app._lastSaveErrorMessage = '';
    app._saveErrorBadgeText = '';
    const stClass = makeClassList();
    app.dom = {
      stRight: { textContent: '1 / 100', title: '', classList: stClass },
      app: { classList: makeClassList() },
      loading: { hidden: true },
      loadingText: { textContent: '' },
      integrityBanner: { hidden: true, textContent: '' },
    };

    // 1. Report error in ja, switch language to en, then clear -> ja badge must still be stripped
    app._reportSaveError({ code: 'QUOTA_EXCEEDED' });
    assert.equal(app.dom.stRight.textContent, `1 / 100 · ${t('status.saveFailed')}`);
    setLang('en');
    app._clearSaveError();
    assert.equal(app._saveErrorActive, false);
    assert.equal(app._saveErrorBadgeText, '');
    assert.equal(stClass.contains('status-save-error'), false);
    assert.equal(app.dom.stRight.textContent, '1 / 100');
    assert.equal(app.dom.stRight.title, '');

    // 2. Report error, then open a new file -> save error must be cleared during new file init
    app._reportSaveError({ code: 'IDB_ERROR' });
    assert.equal(app._saveErrorActive, true);
    assert.equal(stClass.contains('status-save-error'), true);

    app._openSequence = 0;
    app.store = makeMockStore({ fileLoading: false });
    app.workspace = { autosave: () => {}, invalidate: () => {}, bind: async () => null };
    app.flushDeltaSave = () => {};
    app.persistAnalysisSession = () => {};
    app.updateChrome = () => {};
    app.forgetSemantics = () => {};
    app.viewer = { setSymbols: () => {}, setRelocations: () => {}, invalidate: () => {} };
    app._resetDeltaReadiness = () => {};
    app._undoStack = [];
    app._redoStack = [];
    app.notes = { dispose: () => {} };
    app.bookmarks = { clear: () => {} };
    app._createPatchSet = () => ({});
    app.applySlice = () => {};
    app.attachNotes = async () => null;
    app.analysisResume = { saveLastFile: async () => {}, updateLastFileMeta: async () => {} };
    app.restoreAnalysisSession = async () => false;
    app.restoreDeltaSession = async () => {};
    app._startV6AutoAnalysis = () => {};
    app.backend = {
      gen: 1,
      binaryId: 'bin_sha256_' + 'c'.repeat(64),
      open: async () => ({ name: 'next.bin', size: 64, slices: [] }),
    };

    await app.openFile({ name: 'next.bin', size: 64 });
    assert.equal(app._saveErrorActive, false, 'openFile must clear previous file save error');
    assert.equal(stClass.contains('status-save-error'), false);
    assert.equal(app.dom.stRight.textContent, '1 / 100');
    assert.equal(app.dom.stRight.title, '');
  } finally {
    setLang('ja');
    globalThis.document = prevDoc;
  }
});

test('product-base.js capture-phase shortcut guards fileLoading and tools-base.js guards EMPTY_INDEX on notes import/clear', () => {
  assert.match(
    productBaseSrc,
    /const shortcut = \(event\) => \{\s*if \(isFileLoading\(app\)\) \{ event\.preventDefault\(\); return; \}/,
    'capture-phase shortcut handler must block shortcuts during fileLoading',
  );

  const toolsBaseSrc = fs.readFileSync(new URL('../js/tools-base.js', import.meta.url), 'utf8');
  assert.match(toolsBaseSrc, /import\s*\{\s*EMPTY_INDEX\s*\}\s*from\s*'\.\/symbols\.js';/);
  const applyCalls = toolsBaseSrc.match(/app\._applySymbolRenames\(/g) || [];
  assert.ok(applyCalls.length >= 2, `expected _applySymbolRenames in both notes import and clear-all, got ${applyCalls.length}`);
  const emptyGuards = toolsBaseSrc.match(/app\.symbols\s*&&\s*app\.symbols\s*!==\s*EMPTY_INDEX/g) || [];
  assert.ok(emptyGuards.length >= 2, `expected EMPTY_INDEX guard in both fallback paths, got ${emptyGuards.length}`);
});
