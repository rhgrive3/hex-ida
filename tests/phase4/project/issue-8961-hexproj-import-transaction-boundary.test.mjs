// Regression for #8961: the #5646 atomicity repair only pre-staged *patches*;
// `applyWorkspaceProject()` still cleared+persisted notes early, then kept
// mutating patches/sessions/navigation/settings, so (A) a `notes.save()` storage
// failure, (B) a downstream `sessionStore.register` throw on a malformed
// `investigationSessions[].binaryId`, or (C) any later fallible publish left the
// live AND durable workspace in a partially-imported split state while the caller
// saw only "import failed". The fix adds a preflight for the session records plus
// a full snapshot/rollback boundary around every mutation with `notes.save()` as
// the commit point, so any failure restores the pre-import semantic state.
import assert from 'node:assert/strict';
import test from 'node:test';

import { applyWorkspaceProject } from '../../../js/workspace.js';
import { PatchSet } from '../../../js/patch.js';
import { InvestigationSessionStore } from '../../../js/ai/session-core/index.js';

class Notes {
  constructor() {
    this.id = 'notes-8961';
    this.names = new Map([['4096', 'old_name']]);
    this.comments = new Map([['4096', 'old_comment']]);
    this.types = new Map([['old_key', 'old_type']]);
    this.vars = new Map([['old_var', 'old_var_value']]);
    this.structs = [{ name: 'old_struct' }];
    this.dirty = false;
    this.lastSaveError = null;
    this.saves = 0;
    this.saveResult = true;
  }
  save() { this.saves += 1; return this.saveResult; }
  nameEntries() { return [...this.names].map(([addr, name]) => ({ addr: BigInt(addr), name })); }
}

function makeApp() {
  const notes = new Notes();
  const patches = new PatchSet();
  patches.add(100n, [1, 2, 3, 4], [9, 8, 7, 6], { addr: null, label: null, reason: null });
  const app = {
    backend: { gen: 1, binaryId: 'b-8961', contentHash: null },
    store: { get: (k) => (k === 'currentAddress' ? 4096n : null), set: () => {} },
    notes,
    patches,
    symbols: null,
    viewer: null,
    navigation: { entries: [], index: -1, limit: 40 },
    prefs: { lang: 'en', explain: true, textSize: 'normal' },
    projectAnnotations: [],
    aiRuntime: { sessionStore: new InvestigationSessionStore() },
  };
  return { app, notes, patches };
}

function importWith(patchesExtra, sessions) {
  return {
    user: {
      names: [{ address: 0x2000n, value: 'imported_name' }],
      comments: [], types: [], structs: [], vars: [], varsPresent: false,
      patches: patchesExtra,
    },
    findings: { confirmed: [], evidence: [], investigationSessions: sessions || [] },
    navigation: { history: [], cursorIndex: null, bookmarks: [], lastQuery: null },
  };
}

const VALID_PATCH = { offset: 0n, before: [1, 2, 3, 4], after: [4, 3, 2, 1], addr: 0x2000n };

test('#8961 (A) a notes.save() failure keeps every existing note/patch and commits no durable import', () => {
  const { app, notes, patches } = makeApp();
  notes.saveResult = false;
  notes.lastSaveError = { code: 'storage-quota' };
  assert.throws(() => applyWorkspaceProject(app, importWith([VALID_PATCH], [])), /storage-quota|notes-save-failed/);
  assert.equal(notes.names.get('4096'), 'old_name', 'old name preserved');
  assert.equal(notes.names.get('8192'), undefined, 'imported name not committed');
  assert.equal(notes.comments.get('4096'), 'old_comment', 'old comment preserved');
  assert.equal(patches.size, 1, 'old patch set preserved');
  assert.equal(patches.at(0n), null, 'imported patch not committed');
  assert.equal(patches.at(100n).offset, 100n, 'existing patch still present');
});

test('#8961 (B) a malformed investigation-session binaryId is rejected before any mutation', () => {
  for (const bad of [{}, [], true, '   ', 123]) {
    const { app, notes } = makeApp();
    const before = [...notes.names];
    assert.throws(
      () => applyWorkspaceProject(app, importWith([VALID_PATCH], [{ id: 'bad', binaryId: bad, turns: [] }])),
      /binaryId|must be/,
      `session binaryId ${JSON.stringify(bad)} must be rejected`,
    );
    assert.deepEqual([...notes.names], before, 'no live note mutated');
    assert.equal(notes.saves, 0, 'notes.save() must NOT be reached for an invalid project');
    assert.equal(app.aiRuntime.sessionStore.sessions.size, 0, 'no session partially registered');
  }
});

test('#8961 (C) a first-valid-then-malformed session leaves no partial session state', () => {
  const { app, notes } = makeApp();
  const sessions = [
    { id: 'good', binaryId: null, turns: [] },
    { id: 'bad', binaryId: { oops: 1 }, turns: [] },
  ];
  assert.throws(() => applyWorkspaceProject(app, importWith([VALID_PATCH], sessions)), /binaryId|must be/);
  assert.equal(app.aiRuntime.sessionStore.sessions.has('good'), false, 'the valid-but-later rolled-back session is not left behind');
  assert.equal(app.aiRuntime.sessionStore.sessions.size, 0);
  assert.equal(notes.names.get('4096'), 'old_name', 'notes untouched');
  assert.equal(notes.saves, 0, 'durable commit never started for a structurally invalid import');
});

test('#8961 (D) a fallible post-mutation publish rolls the whole import back to the pre-import state', () => {
  const { app, notes, patches } = makeApp();
  // Analysis settings are applied after notes/patches/sessions; make that throw.
  app.setLanguage = () => { throw new Error('settings-publish-failed'); };
  const project = importWith([VALID_PATCH], [{ id: 'sess', binaryId: null, turns: [] }]);
  project.analysis = { settings: { language: 'en' } };
  assert.throws(() => applyWorkspaceProject(app, project), /settings-publish-failed/);
  // notes restored
  assert.equal(notes.names.get('4096'), 'old_name');
  assert.equal(notes.names.get('8192'), undefined);
  // patches restored to exactly the prior set
  assert.equal(patches.size, 1);
  assert.equal(patches.at(0n), null);
  assert.equal(patches.at(100n).offset, 100n);
  // the session registered during the import was withdrawn
  assert.equal(app.aiRuntime.sessionStore.sessions.has('sess'), false, 'registered session rolled back');
  // prefs restored (no partial settings applied)
  assert.deepEqual({ lang: app.prefs.lang, explain: app.prefs.explain, textSize: app.prefs.textSize }, { lang: 'en', explain: true, textSize: 'normal' });
});

test('#8961 (E) a valid import still fully commits notes, patches and sessions', () => {
  const { app, notes, patches } = makeApp();
  assert.equal(applyWorkspaceProject(app, importWith([VALID_PATCH], [{ id: 'sess', binaryId: null, turns: [] }])), true);
  assert.equal(notes.names.get('8192'), 'imported_name');
  assert.equal(notes.names.get('4096'), undefined, 'old notes replaced by a successful import');
  assert.equal(patches.at(0n).offset, 0n, 'imported patch committed');
  assert.equal(patches.at(100n), null, 'old patch cleared by the successful import');
  assert.equal(app.aiRuntime.sessionStore.sessions.has('sess'), true, 'session registered on success');
  assert.ok(notes.saves >= 1);
});
