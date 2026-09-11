// Regression for #5909: NoteStore address keys must be exact identities —
// decimal strings above 2^53 must not round through Number and collide.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { NoteStore } from '../js/names.js';

test('#5909 distinct >2^53 decimal string addresses stay distinct', () => {
  const notes = new NoteStore('test-5909');
  notes.setName('9007199254740992', 'A');
  notes.setName('9007199254740993', 'B');
  assert.equal(notes.nameOf(9007199254740992n), 'A');
  assert.equal(notes.nameOf(9007199254740993n), 'B');
  assert.equal(notes.nameOf('9007199254740993'), 'B');
});

test('#5909 canonical spellings keep sharing one key', () => {
  const notes = new NoteStore('test-5909-canonical');
  notes.setName(0x1000n, 'fn1');
  assert.equal(notes.nameOf(4096n), 'fn1');
  assert.equal(notes.nameOf(4096), 'fn1');
  assert.equal(notes.nameOf('4096'), 'fn1');
  assert.equal(notes.nameOf('0x1000'), 'fn1');
});

test('#5909 unsafe non-integer numbers fail closed instead of truncating', () => {
  const notes = new NoteStore('test-5909-unsafe');
  notes.setName(4096, 'safe');
  // A fractional/unsafe number is not an address: it must not alias 4096.
  notes.setName(4096.7, 'fractional');
  assert.equal(notes.nameOf(4096n), 'safe');
  assert.equal(notes.nameOf(4096.7), null);
});

test('#5909 malformed address strings stay inert', () => {
  const notes = new NoteStore('test-5909-malformed');
  notes.setName(0x2000n, 'real');
  assert.doesNotThrow(() => notes.setName('not-an-address', 'x'));
  assert.equal(notes.nameOf('not-an-address'), null);
  assert.equal(notes.nameOf(0x2000n), 'real');
});
