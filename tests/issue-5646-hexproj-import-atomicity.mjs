import test from 'node:test';
import assert from 'node:assert/strict';
// NoteStore persists through localStorage; node needs a shim first.
if (!globalThis.localStorage) {
  const backing = new Map();
  globalThis.localStorage = {
    getItem: (key) => backing.has(key) ? backing.get(key) : null,
    setItem: (key, value) => backing.set(key, String(value)),
    removeItem: (key) => backing.delete(key),
  };
}

import { applyWorkspaceProject } from '../js/workspace.js';
import { PatchSet } from '../js/patch.js';
import { NoteStore } from '../js/names.js';

// #5646: applyWorkspaceProject() mutated live state in destructive order, so
// an imported patch list that only failed mid-way (e.g. an overlap rejected
// by PatchSet.add) left notes replaced + persisted and the previous patch set
// destroyed while importProject() rejected. Patches must be staged and
// validated into a throwaway PatchSet BEFORE any live mutation.

function makeApp() {
  const app = {
    backend: { gen: 1, binaryId: 'binary-5646' },
    store: { get: () => null },
    patches: new PatchSet(),
    notes: null,
    symbols: null,
  };
  // A real NoteStore: save() participates in the boundary under test.
  app.notes = new NoteStore('binary-5646');
  // Existing user state that a failed import must not destroy.
  app.notes.names.set('4096', 'old_name');
  app.patches.add(100n, [1, 2, 3, 4], [9, 9, 9, 9], { addr: null, label: null, reason: null });
  return { app };
}

const OVERLAPPING_IMPORT = {
  user: {
    names: [{ address: 0x2000n, value: 'imported_name' }],
    comments: [],
    types: [],
    structs: [],
    varsPresent: false,
    patches: [
      { offset: 0n, before: [1, 2, 3, 4], after: [4, 3, 2, 1], addr: 0x2000n },
      // Overlaps the first imported patch: PatchSet.add throws only when the
      // second one is applied.
      { offset: 2n, before: [5, 6, 7, 8], after: [8, 7, 6, 5], addr: 0x2002n },
    ],
  },
  findings: { confirmed: [], evidence: [] },
  navigation: { history: [] },
};

test('#5646 a mid-import patch failure leaves the workspace untouched', () => {
  const { app } = makeApp();
  assert.throws(() => applyWorkspaceProject(app, OVERLAPPING_IMPORT),
    /overlaps/, 'the import must still fail');
  assert.equal(app.notes.names.get('4096'), 'old_name',
    'the old note must survive a failed import');
  assert.equal(app.notes.names.get('8192'), undefined,
    'imported notes must not be committed by a failed import');
  assert.equal(app.patches.size, 1, 'the old patch set must survive');
  const [existing] = app.patches.items.values();
  assert.equal(existing.offset, 100n);
});

test('#5646 a valid import still commits patches and notes', () => {
  const { app } = makeApp();
  const valid = {
    user: {
      names: [{ address: 0x2000n, value: 'imported_name' }],
      comments: [],
      types: [],
      structs: [],
      varsPresent: false,
      patches: [
        { offset: 0n, before: [1, 2, 3, 4], after: [4, 3, 2, 1], addr: 0x2000n },
      ],
    },
    findings: { confirmed: [], evidence: [] },
    navigation: { history: [] },
  };
  applyWorkspaceProject(app, valid);
  assert.equal(app.notes.names.get('8192'), 'imported_name');
  assert.equal(app.patches.size, 1);
  const [committed] = app.patches.items.values();
  assert.equal(committed.offset, 0n);
});
