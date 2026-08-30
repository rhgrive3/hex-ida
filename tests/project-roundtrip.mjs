import assert from 'node:assert/strict';
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
import { applyWorkspaceProject, snapshotWorkspace } from '../js/workspace.js';

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
    prefs: { lang: 'en', explain: true, textSize: 'normal' },
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
  fakeApp.lastGoal = null;

  // Restore
  applyWorkspaceProject(fakeApp, snap);
  assert.equal(fakeApp.navigation.entries.length, 2);
  assert.equal(fakeApp.navigation.index, 1);
  assert.equal(fakeApp.prefs.lang, 'en');
  assert.equal(fakeApp.lastGoal?.text, 'find coins');
  assert.equal(fakeStore.get('currentAddress'), 0x100001000n);
  fakeApp.notes.clear();
}

console.log('project-roundtrip: PASS');
