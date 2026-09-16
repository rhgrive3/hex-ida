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

const ID = 'binary-3667';

function makeApp() {
  const app = {
    backend: { gen: 1, binaryId: ID, contentHash: ID },
    store: { get: () => null },
    patches: new PatchSet(),
    notes: new NoteStore(ID),
    symbols: null,
  };
  app.notes.names.set('4096', 'KEEP_ME');
  assert.equal(app.notes.save(), true);
  app.patches.add(100n, [1, 2, 3, 4], [9, 9, 9, 9], { addr: null, label: null, reason: null });
  return app;
}

function durableNames() {
  return Object.fromEntries(new NoteStore(ID).names);
}

function project(patches, names) {
  return {
    user: { names, comments: [], types: [], vars: [], structs: [], patches },
    navigation: { history: [] },
  };
}

test('#3667 a patch rejected by PatchSet.add does not persist imported notes', () => {
  const app = makeApp();
  assert.throws(() => applyWorkspaceProject(app, project(
    [{ offset: 0n, before: [], after: [] }],
    [{ address: 8192n, value: 'IMPORTED' }],
  )), /same non-zero length/);
  assert.deepEqual(Object.fromEntries(app.notes.names), { 4096: 'KEEP_ME' });
  assert.deepEqual(durableNames(), { 4096: 'KEEP_ME' });
  assert.equal(app.patches.size, 1);
});

test('#3667 a malformed note address does not clear the existing notes', () => {
  const app = makeApp();
  assert.throws(() => applyWorkspaceProject(app, project(
    [],
    [{ address: 'not-an-address', value: 'IMPORTED' }],
  )));
  assert.deepEqual(Object.fromEntries(app.notes.names), { 4096: 'KEEP_ME' });
  assert.deepEqual(durableNames(), { 4096: 'KEEP_ME' });
  assert.equal(app.patches.size, 1);
});

test('#3667 a valid import still restores notes and patches', () => {
  const app = makeApp();
  applyWorkspaceProject(app, project(
    [{ offset: 0n, before: [1, 2], after: [3, 4], addr: 0n }],
    [{ address: 8192n, value: 'IMPORTED' }],
  ));
  assert.deepEqual(durableNames(), { 8192: 'IMPORTED' });
  assert.equal(app.patches.size, 1);
});
