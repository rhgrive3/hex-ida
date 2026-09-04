/**
 * Issue #6307 regression: a single corrupt delta record must not abort
 * `_loadDeltas()` — later valid deltas must still restore, and capacity
 * accounting must cover every raw delta that exists in storage.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

class StorageMock {
  constructor() { this.map = new Map(); }
  get length() { return this.map.size; }
  key(index) { return [...this.map.keys()][index] ?? null; }
  getItem(key) { return this.map.has(String(key)) ? this.map.get(String(key)) : null; }
  setItem(key, value) { this.map.set(String(key), String(value)); }
  removeItem(key) { this.map.delete(String(key)); }
  clear() { this.map.clear(); }
}

const PREFIX = 'hex.notes.';
const SNAPSHOT = JSON.stringify({ v: 2, names: {}, comments: {}, vars: {}, types: {}, structs: [] });

function freshStorage() {
  const storage = new StorageMock();
  globalThis.localStorage = storage;
  return storage;
}

const { NoteStore } = await import('../js/names.js');

test('#6307 broken delta before a valid delta still restores the valid one', () => {
  const storage = freshStorage();
  storage.setItem(`${PREFIX}demo`, SNAPSHOT);
  storage.setItem(`${PREFIX}demo.delta.00-broken`, '{broken-json');
  storage.setItem(`${PREFIX}demo.delta.01-valid`, JSON.stringify({
    kind: 'names', key: '4096', deleted: false, value: 'target_function',
  }));

  const notes = new NoteStore('demo');
  assert.equal(notes.nameOf(4096n), 'target_function');
  // Capacity accounting covers every raw delta present in storage, including
  // the unreadable one.
  assert.equal(notes._deltaTotalBytes,
    new TextEncoder().encode('{broken-json').byteLength
    + new TextEncoder().encode(storage.getItem(`${PREFIX}demo.delta.01-valid`)).byteLength);
  assert.ok(notes._deltaBytes.has(`${PREFIX}demo.delta.00-broken`));
});

test('#6307 broken delta between valid deltas skips only itself', () => {
  const storage = freshStorage();
  storage.setItem(`${PREFIX}demo2`, SNAPSHOT);
  storage.setItem(`${PREFIX}demo2.delta.00-first`, JSON.stringify({
    kind: 'names', key: '4096', deleted: false, value: 'first_name',
  }));
  storage.setItem(`${PREFIX}demo2.delta.01-broken`, '{"kind":');
  storage.setItem(`${PREFIX}demo2.delta.02-second`, JSON.stringify({
    kind: 'comments', key: '4096', deleted: false, value: 'hello comment',
  }));

  const notes = new NoteStore('demo2');
  assert.equal(notes.nameOf(4096n), 'first_name');
  assert.equal(notes.comment(4096n), 'hello comment');
});

test('#6307 tombstone and unknown-kind deltas keep existing behavior', () => {
  const storage = freshStorage();
  storage.setItem(`${PREFIX}demo3`, JSON.stringify({
    v: 2, names: { '4096': 'base_name' }, comments: {}, vars: {}, types: {}, structs: [],
  }));
  storage.setItem(`${PREFIX}demo3.delta.00-tombstone`, JSON.stringify({
    kind: 'names', key: '4096', deleted: true,
  }));
  storage.setItem(`${PREFIX}demo3.delta.01-unknown`, JSON.stringify({
    kind: 'widgets', key: '4096', deleted: false, value: 'x',
  }));
  storage.setItem(`${PREFIX}demo3.delta.02-missing-key`, JSON.stringify({
    kind: 'names', deleted: false, value: 'x',
  }));

  const notes = new NoteStore('demo3');
  assert.equal(notes.nameOf(4096n), null, 'tombstone deletes the base name');
  assert.equal(notes._deltaBytes.size, 3, 'unknown-kind / missing-key records still count toward storage bytes');
});

test('#6307 storage getItem throwing on one key does not stop later deltas', () => {
  const storage = freshStorage();
  storage.setItem(`${PREFIX}demo4`, SNAPSHOT);
  storage.setItem(`${PREFIX}demo4.delta.00-throwing`, 'x');
  storage.setItem(`${PREFIX}demo4.delta.01-valid`, JSON.stringify({
    kind: 'names', key: '8192', deleted: false, value: 'after_throw',
  }));
  const originalGetItem = storage.getItem.bind(storage);
  storage.getItem = (key) => {
    if (key === `${PREFIX}demo4.delta.00-throwing`) throw new Error('storage fault');
    return originalGetItem(key);
  };

  const notes = new NoteStore('demo4');
  assert.equal(notes.nameOf(8192n), 'after_throw');
});
