import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

class StorageMock {
  constructor() {
    this.keys = [];
    this.map = new Map();
  }
  getItem(key) {
    return this.map.has(String(key)) ? this.map.get(String(key)) : null;
  }
  setItem(key, value) {
    if (!this.map.has(String(key))) this.keys.push(String(key));
    this.map.set(String(key), String(value));
  }
  removeItem(key) {
    this.map.delete(String(key));
    this.keys = this.keys.filter((k) => k !== String(key));
  }
  get length() {
    return this.keys.length;
  }
  key(i) {
    return this.keys[i] ?? null;
  }
  clear() {
    this.map.clear();
    this.keys = [];
  }
}

globalThis.localStorage = new StorageMock();

const {
  findLegacyV3NoteKey,
  noteKeyFor,
  noteKeyFromBinaryId,
  NoteStore,
} = await import('../js/names.js');

function fileLike(bytes, name = 'binary.bin') {
  const blob = new Blob([bytes]);
  Object.defineProperty(blob, 'name', { value: name });
  return blob;
}

test('issue #6227: ambiguity reject when multiple v3 keys with same prefix exist without verified digest', () => {
  const storage = new StorageMock();
  const fileB = fileLike(new Uint8Array(64));
  const info = {
    slices: [
      {
        offset: 0n,
        size: 64n,
        info: { uuid: 'UUID1', cpu: 'arm64', cpuSub: '0', architecture: 'arm64' },
      },
    ],
  };

  const keyA = 'v3|64|UUID1|arm64|0|0|64|sha256tree:v1:DIGEST_A';
  const keyB = 'v3|64|UUID1|arm64|0|0|64|sha256tree:v1:DIGEST_B';

  // Key A is enumerated first
  storage.setItem(`hex.notes.${keyA}`, JSON.stringify({ comments: { '0x10': 'comment A' } }));
  storage.setItem(`hex.notes.${keyB}`, JSON.stringify({ comments: { '0x10': 'comment B' } }));

  // Without verified digest, it must reject ambiguity and return null instead of choosing A
  const candidate = findLegacyV3NoteKey(fileB, info, 0, storage);
  assert.equal(candidate, null);
});

test('issue #6227: exact v3 digest matching selects only matching key B even when A is enumerated first', async () => {
  const storage = new StorageMock();
  const bytesB = new Uint8Array(64);
  bytesB[0] = 42;
  const fileB = fileLike(bytesB);
  const info = {
    slices: [
      {
        offset: 0n,
        size: 64n,
        info: { uuid: 'UUID1', cpu: 'arm64', cpuSub: '0', architecture: 'arm64' },
      },
    ],
  };

  const computedKeyB = await noteKeyFor(fileB, info, 0);
  assert.ok(computedKeyB.startsWith('v3|64|UUID1|arm64|0|0|64|'));

  const keyA = 'v3|64|UUID1|arm64|0|0|64|sha256tree:v1:DIFFERENT_DIGEST_A';
  // Put keyA first in storage
  storage.setItem(`hex.notes.${keyA}`, JSON.stringify({ comments: { '0x10': 'comment A' } }));
  storage.setItem(`hex.notes.${computedKeyB}`, JSON.stringify({ comments: { '0x10': 'comment B' } }));

  // Now findLegacyV3NoteKey has access to verified key in NOTE_KEY_CACHE
  const candidate = findLegacyV3NoteKey(fileB, info, 0, storage);
  assert.equal(candidate, computedKeyB);
});

test('issue #6227: single exact legacy match continues normal migration', () => {
  const storage = new StorageMock();
  const file = fileLike(new Uint8Array(64));
  const info = {
    slices: [
      {
        offset: 0n,
        size: 64n,
        info: { uuid: 'UUID1', cpu: 'arm64', cpuSub: '0', architecture: 'arm64' },
      },
    ],
  };

  const key = 'v3|64|UUID1|arm64|0|0|64|sha256tree:v1:SINGLE_DIGEST';
  storage.setItem(`hex.notes.${key}`, JSON.stringify({ names: { '0x100': 'func1' } }));
  storage.setItem(`hex.notes.${key}.delta.0001`, JSON.stringify({ type: 'name', addr: '0x100', name: 'func1' }));

  const candidate = findLegacyV3NoteKey(file, info, 0, storage);
  assert.equal(candidate, key);
});

test('issue #6227: NoteStore does not apply legacy candidate if v4 payload already exists', () => {
  globalThis.localStorage.clear();
  const v4Id = 'v4|binary:sha256:1234|64|UUID1|arm64|0|arm64|0|64';
  const legacyV3Id = 'v3|64|UUID1|arm64|0|0|64|sha256tree:v1:OLD';

  globalThis.localStorage.setItem(`hex.notes.${v4Id}`, JSON.stringify({ names: { '0x100': 'currentFunc' } }));
  globalThis.localStorage.setItem(`hex.notes.${legacyV3Id}`, JSON.stringify({ names: { '0x100': 'oldFunc' } }));

  const store = new NoteStore(v4Id, [legacyV3Id]);
  assert.equal(store.names.get('0x100'), 'currentFunc');
  assert.equal(store.legacyCandidate, null);
});

test('issue #6227: NoteStore does not mix legacy candidate contents before explicit import', () => {
  globalThis.localStorage.clear();
  const v4Id = 'v4|binary:sha256:5678|64|UUID1|arm64|0|arm64|0|64';
  const legacyV3Id = 'v3|64|UUID1|arm64|0|0|64|sha256tree:v1:OLD';

  globalThis.localStorage.setItem(`hex.notes.${legacyV3Id}`, JSON.stringify({ comments: { '0x200': 'oldComment' } }));

  const store = new NoteStore(v4Id, [legacyV3Id]);
  assert.equal(store.comments.get('0x200'), undefined);
  assert.ok(store.legacyCandidate);
  assert.equal(store.legacyCandidate.sourceId, legacyV3Id);

  // Contents are only mixed upon explicit import
  const imported = store.importLegacyCandidate({ save: false });
  assert.equal(imported, true);
  assert.equal(store.comments.get('0x200'), 'oldComment');
});
