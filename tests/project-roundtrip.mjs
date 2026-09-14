import assert from 'node:assert/strict';
import { NavigationHistory } from '../js/navigation.js';
import {
  HEX_PROJECT_VERSION,
  ProjectFormatError,
  createHexProject,
  importHexProject,
  parseHexProject,
  serializeHexProject,
  tryParseHexProject,
} from '../js/project/index.js';

if (!globalThis.localStorage) {
  const map = new Map();
  globalThis.localStorage = {
    getItem(k) { return map.get(String(k)) ?? null; },
    setItem(k, v) { map.set(String(k), String(v)); },
    removeItem(k) { map.delete(String(k)); },
    clear() { map.clear(); },
  };
}

import { NoteStore } from '../js/names.js';
import { ProductWorkspace, applyWorkspaceProject, snapshotWorkspace } from '../js/workspace.js';

const project = createHexProject({
  binaryHash: 'fnv1a64:10:abc',
  binaryMetadata: { format: 'macho', base: 0x100000000n },
  userNames: [{ addr: 0x100001000n, name: 'PlayerData::addCoins' }],
  comments: [{ addr: 0x100001004n, text: 'confirmed' }],
  types: [{ addr: 0x100001000n, type: 'int64_t(int64_t)' }],
  vars: [{ key: '0x100001000:v0', value: 'playerHp' }],
  structs: [{ name: 'PlayerData', fields: [] }],
  bookmarks: [{ addr: 0x100001000n }],
  patches: [{ addr: 0x100001008n, bytes: [0, 0, 0, 0] }],
  confirmedFindings: [{ id: 'coins' }],
  agentAnswers: [{ question: 'coins', answer: '...' }],
  evidence: [{ addr: 0x100001008n }],
  analysisSettings: { language: 'ja' },
  cacheReferences: ['summary'],
  navigation: { currentFunction: 0x100001000n, history: [{ addr: 0x100001000n }], bookmarks: [{ addr: 0x100001000n }], lastQuery: 'coins' },
});
const serialized = serializeHexProject(project);
const roundtrip = parseHexProject(serialized);
assert.equal(roundtrip.binary.metadata.base, 0x100000000n);
assert.equal(roundtrip.navigation.currentFunction, 0x100001000n);
assert.equal(roundtrip.user.vars[0].key, '0x100001000:v0');
assert.equal(roundtrip.user.vars[0].value, 'playerHp');
assert.equal(roundtrip.navigation.bookmarks[0].addr, 0x100001000n);
assert.equal(roundtrip.binary.embedded, false);

const future = JSON.stringify({ ...project, version: HEX_PROJECT_VERSION + 1 }, (_k, v) => typeof v === 'bigint' ? String(v) : v);
assert.equal(tryParseHexProject(future).ok, false);
assert.equal(tryParseHexProject('{broken').ok, false);

const marker = 'PlayerData::addCoins';
const markerOffset = serialized.indexOf(marker);
assert.notEqual(markerOffset, -1, 'malformed UTF-8 regression marker must exist');
const encoder = new TextEncoder();
const malformedUtf8 = new Uint8Array([
  ...encoder.encode(serialized.slice(0, markerOffset)),
  0xC3, 0x28,
  ...encoder.encode(serialized.slice(markerOffset + marker.length)),
]);
const rejectsInvalidUtf8 = (error) => (
  error instanceof ProjectFormatError
  && error.code === 'HEX_PROJECT_INVALID_UTF8'
);

assert.throws(() => parseHexProject(malformedUtf8), rejectsInvalidUtf8);
assert.throws(() => parseHexProject(malformedUtf8.buffer.slice(0)), rejectsInvalidUtf8);
await assert.rejects(importHexProject(new Blob([malformedUtf8])), rejectsInvalidUtf8);
assert.deepEqual(tryParseHexProject(malformedUtf8), {
  ok: false,
  error: 'project bytes are not valid UTF-8',
  code: 'HEX_PROJECT_INVALID_UTF8',
});

const unicodeProject = createHexProject({ comments: [{ text: '日本語🙂' }] });
const unicodeBytes = encoder.encode(serializeHexProject(unicodeProject));
assert.equal(parseHexProject(unicodeBytes).user.comments[0].text, '日本語🙂');
assert.equal((await importHexProject(new Blob([unicodeBytes]))).user.comments[0].text, '日本語🙂');

// Issue #2564: NoteStore transaction batching
{
  const store = new NoteStore('test-tx-store');
  let saveCount = 0;
  const origSave = store.save.bind(store);
  store.save = () => { saveCount++; return origSave(); };

  store.transaction(() => {
    store.setName(0x1000n, 'fn1');
    store.setName(0x2000n, 'fn2');
    store.setComment(0x1000n, 'comment1');
    store.setVarName(0x1000n, 'v0', 'var0');
  });

  assert.equal(saveCount, 1, 'Transaction must batch 4 mutations into exactly 1 save call');
  assert.equal(store.nameOf(0x1000n), 'fn1');
  assert.equal(store.nameOf(0x2000n), 'fn2');
  assert.equal(store.comment(0x1000n), 'comment1');
  assert.equal(store.varName(0x1000n, 'v0'), 'var0');
  store.clear();
}

// Issues #2575 & #547 & #2615: Workspace project full roundtrip
{
  const fakeStore = new Map([
    ['currentAddress', 0x100001000n],
  ]);
  const liveSettings = { language: 'en', explain: true, textSize: 'm' };
  const fakeApp = {
    notes: new NoteStore('test-ws-store'),
    patches: { list: () => [], add() {}, clear() {} },
    bookmarks: { list: () => [{ addr: 0x100001000n }], restore() {} },
    navigation: {
      entries: [{ addr: 0x100001000n }, { addr: 0x100002000n }],
      index: 1,
      limit: 500,
      snapshot() { return { entries: this.entries, index: this.index }; },
      onChange() {},
    },
    store: { get: (k) => fakeStore.get(k), set: (o) => { for (const [k, v] of Object.entries(o)) fakeStore.set(k, v); } },
    prefs: { lang: 'en', explain: true, textSize: 'm' },
    setLanguage(value) { this.prefs.lang = value; liveSettings.language = value; },
    setExplain(value) { this.prefs.explain = value; liveSettings.explain = value; },
    setTextSize(value) { this.prefs.textSize = value; liveSettings.textSize = value; },
    lastGoal: { text: 'find coins' },
    codeRegion: () => ({ vmAddr: 0x100000000n, size: 0x100000n }),
    viewer: { goToAddress() {}, setSymbols() {} },
  };

  const snap = snapshotWorkspace(fakeApp, { hash: 'test-hash' });
  assert.equal(snap.navigation.cursorIndex, 1);
  assert.equal(snap.navigation.lastQuery, 'find coins');
  assert.equal(snap.analysis.settings.language, 'en');

  // Change local state
  fakeApp.navigation.entries = [];
  fakeApp.navigation.index = -1;
  fakeApp.prefs.lang = 'ja';
  fakeApp.prefs.explain = false;
  fakeApp.prefs.textSize = 's';
  liveSettings.language = 'ja';
  liveSettings.explain = false;
  liveSettings.textSize = 's';
  fakeApp.lastGoal = null;

  // Restore
  applyWorkspaceProject(fakeApp, snap);
  assert.equal(fakeApp.navigation.entries.length, 2);
  assert.equal(fakeApp.navigation.index, 1);
  assert.equal(fakeApp.prefs.lang, 'en');
  assert.equal(fakeApp.prefs.explain, true);
  assert.equal(fakeApp.prefs.textSize, 'm');
  assert.deepEqual(liveSettings, { language: 'en', explain: true, textSize: 'm' }, 'project settings must be applied through the live app setters');
  assert.equal(fakeApp.lastGoal?.text, 'find coins');
  assert.equal(fakeStore.get('currentAddress'), 0x100001000n);

  // Issue #3648: malformed/unsupported settings must not overwrite live state.
  const invalidSettingsProject = {
    ...snap,
    analysis: {
      ...snap.analysis,
      settings: { language: 'fr', explain: 'true', textSize: 'xxl' },
    },
    navigation: { ...snap.navigation, currentFunction: null, history: [] },
  };
  applyWorkspaceProject(fakeApp, invalidSettingsProject);
  assert.deepEqual(liveSettings, { language: 'en', explain: true, textSize: 'm' });
  assert.deepEqual(fakeApp.prefs, { lang: 'en', explain: true, textSize: 'm' });

  // Issue #3652: rebasing cursorIndex when imported history is truncated to navigation.limit.
  const longHistory = Array.from({ length: 100 }, (_entry, index) => ({ addr: BigInt(index) }));
  const truncatedNavigationProject = {
    ...snap,
    navigation: {
      ...snap.navigation,
      currentFunction: null,
      history: longHistory,
      cursorIndex: 70,
    },
  };
  fakeApp.navigation.limit = 40;
  applyWorkspaceProject(fakeApp, truncatedNavigationProject);
  assert.equal(fakeApp.navigation.entries.length, 40);
  assert.equal(fakeApp.navigation.entries[0].addr, 60n);
  assert.equal(fakeApp.navigation.index, 10, 'cursor must be rebased by the 60 dropped history entries');

  truncatedNavigationProject.navigation.cursorIndex = 20;
  applyWorkspaceProject(fakeApp, truncatedNavigationProject);
  assert.equal(fakeApp.navigation.index, 0, 'cursor in dropped prefix must clamp to first retained entry');

  truncatedNavigationProject.navigation.history = longHistory.slice(0, 30);
  truncatedNavigationProject.navigation.cursorIndex = 20;
  applyWorkspaceProject(fakeApp, truncatedNavigationProject);
  assert.equal(fakeApp.navigation.index, 20, 'cursor must remain unchanged when history is not truncated');

  // Issue #5488: project import must honor the real history capacity, including zero.
  for (const limit of [0, 1, 40]) {
    for (const cursorIndex of [70, null]) {
      let restoredSnapshot;
      fakeApp.navigation = new NavigationHistory({
        limit,
        onChange(snapshot) { restoredSnapshot = snapshot; },
      });
      applyWorkspaceProject(fakeApp, {
        ...truncatedNavigationProject,
        navigation: { ...truncatedNavigationProject.navigation, history: longHistory, cursorIndex },
      });
      const navigation = fakeApp.navigation;
      assert.equal(navigation.entries.length, limit);
      assert.equal(navigation.index, limit === 0 ? -1 : cursorIndex === null ? limit - 1 : Math.max(0, cursorIndex - (100 - limit)));
      assert.deepEqual(restoredSnapshot, navigation.snapshot(), 'import must notify observers of the restored capacity');
      if (limit === 0) {
        assert.deepEqual(navigation.entries, []);
        assert.deepEqual(navigation.snapshot(), { length: 0, canBack: false, canForward: false, current: null });
      } else {
        assert.equal(navigation.entries[0].addr, BigInt(100 - limit));
        assert.equal(navigation.entries.at(-1).addr, 99n);
      }
    }
  }

  fakeApp.notes.clear();
}

// Issue #3658: importing an explicit empty findings state must clear the
// previous report before ProductWorkspace autosaves or exports the project.
{
  class Storage {
    constructor() { this.values = new Map(); }
    getItem(key) { return this.values.get(String(key)) ?? null; }
    setItem(key, value) { this.values.set(String(key), String(value)); }
  }

  const identity = {
    hash: 'hash-3658',
    metadata: {
      name: 'issue-3658.bin', size: 4, format: 'macho', sliceIndex: 0,
      sliceOffset: 0n, sliceSize: 4n, uuid: 'uuid-3658', architecture: 'arm64',
    },
  };
  const fileInfo = {
    name: identity.metadata.name, size: identity.metadata.size, format: identity.metadata.format,
    slices: [{
      offset: 0n, size: 4n,
      info: { uuid: identity.metadata.uuid, architecture: identity.metadata.architecture },
      capability: { architecture: identity.metadata.architecture },
    }],
  };
  const values = new Map([['fileInfo', fileInfo], ['sliceIndex', 0], ['architecture', 'arm64']]);
  const makeApp = () => ({
    notes: new NoteStore('test-ws-3658'),
    patches: { list: () => [], add() {}, clear() {} },
    bookmarks: { list: () => [], restore() {} },
    navigation: {
      entries: [], index: -1, limit: 40,
      snapshot() { return { entries: this.entries, index: this.index }; },
      onChange() {},
    },
    store: { get: (key) => values.get(key), set() {} },
    backend: {
      contentHash: identity.hash, gen: 1,
      async ensureContentHash() { return this.contentHash; },
    },
    symbols: { gen: 0, rename() {} },
    codeRegion: () => ({ id: 'text', vmAddr: 0n, size: 0x1000n }),
    viewer: { setSymbols() {}, goToAddress() {} },
    prefs: { lang: 'en', explain: true, textSize: 'm' },
  });
  const readExport = async (workspace) => parseHexProject(await workspace.exportProject().text());

  const app = makeApp();
  const storage = new Storage();
  const workspace = new ProductWorkspace(app, { storage });
  app.workspace = workspace;
  await workspace.bind();

  const projectA = createHexProject({
    binary: identity,
    confirmedFindings: [{ id: 'finding-A' }],
    evidence: [{ id: 'evidence-A' }],
  });
  await workspace.importProject(serializeHexProject(projectA));
  assert.deepEqual(app.autoReport.report.confirmed, [{ id: 'finding-A' }], 'non-empty findings must restore');
  assert.deepEqual(app.autoReport.report.deep, [{ id: 'evidence-A' }], 'non-empty evidence must restore');
  const exportedA = await readExport(workspace);
  assert.deepEqual(exportedA.findings.confirmed, [{ id: 'finding-A' }]);
  assert.deepEqual(exportedA.findings.evidence, [{ id: 'evidence-A' }]);

  const projectB = createHexProject({ binary: identity, confirmedFindings: [], evidence: [] });
  await workspace.importProject(serializeHexProject(projectB));
  assert.equal(app.autoReport, null, 'empty findings must clear stale autoReport');
  const savedB = parseHexProject(storage.getItem(workspace._localKey(workspace.identity)));
  assert.deepEqual(savedB.findings.confirmed, [], 'autosave must not reintroduce stale confirmed findings');
  assert.deepEqual(savedB.findings.evidence, [], 'autosave must not reintroduce stale evidence');
  const exportedB = await readExport(workspace);
  assert.deepEqual(exportedB.findings.confirmed, [], 'A→B import must not leak confirmed findings');
  assert.deepEqual(exportedB.findings.evidence, [], 'A→B import must not leak evidence');

  await workspace.importProject(serializeHexProject(exportedB));
  const exportedB2 = await readExport(workspace);
  assert.deepEqual(exportedB2.findings.confirmed, [], 'empty findings export/import must be idempotent');
  assert.deepEqual(exportedB2.findings.evidence, [], 'empty evidence export/import must be idempotent');
  app.notes.clear();
}

console.log('project-roundtrip: PASS');
