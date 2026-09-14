// Regression for #5968: NoteStore.fromJSON must compare the imported id
// type-preservingly. A structured id (Array, custom toString) must never
// launder into the current namespace through String() coercion.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { NoteStore } from '../js/names.js';

const notesPayload = (id, name) => JSON.stringify({
  v: 1,
  id,
  names: { '4096': name },
  comments: {},
  vars: {},
  types: {},
  structs: [],
});

test('#5968 a matching string id still imports', () => {
  const store = new NoteStore('binary-A');
  const n = store.fromJSON(notesPayload('binary-A', 'imported-name'));
  assert.equal(n, 1);
  assert.equal(store.nameOf(4096n), 'imported-name');
});

test('#5968 a structured id matching String(this.id) is rejected', () => {
  const store = new NoteStore('binary-A');
  assert.throws(() => store.fromJSON(notesPayload(['binary-A'], 'imported-name')), (error) => error?.message === 'notes-file-mismatch');
  assert.equal(store.nameOf(4096n), null);
});

test('#5968 a structured id with a custom toString is rejected', () => {
  const store = new NoteStore('binary-A');
  const forged = { toString: () => 'binary-A' };
  assert.throws(() => store.fromJSON(notesPayload(forged, 'imported-name')), (error) => error?.message === 'notes-file-mismatch');
  assert.equal(store.nameOf(4096n), null);
});

test('#5968 a genuinely different id stays rejected', () => {
  const store = new NoteStore('binary-A');
  assert.throws(() => store.fromJSON(notesPayload('binary-B', 'other-name')), (error) => error?.message === 'notes-file-mismatch');
  assert.equal(store.nameOf(4096n), null);
});
