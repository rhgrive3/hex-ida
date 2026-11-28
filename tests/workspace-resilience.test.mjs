import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ProductWorkspace,
  applyWorkspaceProject,
  binaryIdentity,
  sameProjectIdentity,
  resolvePrimaryHash,
  resolveLegacyHash,
} from '../js/workspace.js';
import { createHexProject, serializeHexProject } from '../js/project/index.js';
import { PatchSet } from '../js/patch.js';

const SHA256_ID = 'bin_sha256_' + 'a'.repeat(64);
const LEGACY_FNV = 'fnv1a64:0123456789abcdef';

function createMemoryStorage() {
  const map = new Map();
  return {
    map,
    failWrites: false,
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) {
      if (this.failWrites) {
        const e = new Error('quota exceeded');
        e.name = 'QuotaExceededError';
        throw e;
      }
      map.set(String(k), String(v));
    },
    removeItem(k) { map.delete(String(k)); },
    clear() { map.clear(); },
  };
}

function createMockIdb() {
  const projects = new Map();
  let saveCalls = 0;
  let failSaves = false;
  return {
    projects,
    get saveCalls() { return saveCalls; },
    set failSaves(v) { failSaves = v; },
    async saveProject(key, payload, meta = {}) {
      saveCalls += 1;
      if (failSaves) {
        const err = new Error('IDB quota exceeded');
        err.code = 'QUOTA_EXCEEDED';
        throw err;
      }
      projects.set(key, { payload, revision: meta.revision ?? 1, updatedAt: Date.now() });
    },
    async loadProject(key) {
      return projects.get(key) || null;
    },
    async flush() {},
  };
}

function createMockApp({
  binaryId = SHA256_ID,
  contentHash = LEGACY_FNV,
  withEnsureBinaryId = true,
  fileSize = 4096,
  useBigIntSize = false,
  withRenameMany = true,
  withReplaceAll = true,
} = {}) {
  const state = new Map([
    ['file', { name: 'app.bin', size: useBigIntSize ? BigInt(fileSize) : fileSize }],
    ['fileInfo', {
      name: 'app.bin',
      size: useBigIntSize ? BigInt(fileSize) : fileSize,
      format: 'Mach-O 64-bit',
      slices: [{ offset: 0n, size: BigInt(fileSize), info: { uuid: 'UUID-1', architecture: 'arm64' } }],
    }],
    ['sliceIndex', 0],
    ['architecture', 'arm64'],
    ['currentAddress', 0x1000n],
  ]);

  const notes = {
    id: 'notes-test-1',
    names: new Map(),
    comments: new Map(),
    types: new Map(),
    vars: new Map(),
    structs: [],
    dirty: false,
    lastSaveError: null,
    saveCalls: [],
    replaceAllCalls: [],
    nameEntries() {
      return [...this.names.entries()].map(([k, name]) => ({ addr: BigInt(k), name }));
    },
    save(opts) {
      this.saveCalls.push(opts);
      this.dirty = false;
      return true;
    },
  };
  if (withReplaceAll) {
    notes.replaceAll = (payload, opts = {}) => {
      notes.replaceAllCalls.push({ payload, opts });
      notes.names.clear();
      notes.comments.clear();
      notes.types.clear();
      if (opts.replaceVars !== false) notes.vars.clear();
      for (const [k, v] of payload.names || []) notes.names.set(String(k), v);
      for (const [k, v] of payload.comments || []) notes.comments.set(String(k), v);
      for (const [k, v] of payload.types || []) notes.types.set(String(k), v);
      if (opts.replaceVars !== false) {
        for (const [k, v] of payload.vars || []) notes.vars.set(String(k), v);
      }
      notes.structs = Array.isArray(payload.structs) ? payload.structs.slice() : [];
      notes.dirty = true;
      if (opts.save) return notes.save({ replace: true });
      return true;
    };
  }

  const symbols = {
    gen: 1,
    renames: new Map(),
    renameCalls: 0,
    renameManyCalls: [],
    rename(addr, name) {
      this.renameCalls += 1;
      const k = BigInt(addr).toString();
      if (name) this.renames.set(k, name);
      else this.renames.delete(k);
    },
  };
  if (withRenameMany) {
    symbols.renameMany = (entries, opts = {}) => {
      const list = [...entries];
      symbols.renameManyCalls.push({ entries: list, opts });
      if (opts.replace) symbols.renames.clear();
      for (const [addr, name] of list) {
        const k = BigInt(addr).toString();
        if (name) symbols.renames.set(k, name);
        else symbols.renames.delete(k);
      }
      return list.length;
    };
  }

  const backend = {
    gen: 1,
    binaryId: withEnsureBinaryId ? binaryId : null,
    contentHash,
    async ensureContentHash() {
      this.contentHash = contentHash;
      return contentHash;
    },
  };
  if (withEnsureBinaryId) {
    backend.ensureBinaryId = async () => {
      backend.binaryId = binaryId;
      return binaryId;
    };
  }

  return {
    store: {
      get: (k) => state.get(k),
      set: (obj) => { for (const [k, v] of Object.entries(obj)) state.set(k, v); },
    },
    backend,
    notes,
    symbols,
    patches: new PatchSet(),
    prefs: { lang: 'ja', explain: true, textSize: 'm' },
    viewer: { setSymbols() {}, goToAddress() {} },
    navigation: { entries: [], index: -1, limit: 100, bookmarks: [], snapshot: () => ({}) },
    bookmarks: { list: () => [], restore() {} },
  };
}

describe('Track 5: ProductWorkspace resilience & SHA-256 identity', () => {
  it('uses ensureBinaryId() (bin_sha256_...) as primary hash and keeps fnv1a64 as legacyHash', async () => {
    const app = createMockApp();
    const storage = createMemoryStorage();
    const ws = new ProductWorkspace(app, { storage });
    const project = await ws.bind();

    assert.equal(resolvePrimaryHash(app.backend), SHA256_ID);
    assert.equal(resolveLegacyHash(app.backend), LEGACY_FNV);
    assert.equal(ws.identity.hash, SHA256_ID);
    assert.equal(ws.identity.legacyHash, LEGACY_FNV);
    assert.equal(project.binary.hash, SHA256_ID);
    assert.equal('legacyHash' in project.binary, false, 'serialized project.binary should only contain hash & metadata');
  });

  it('accepts legacy fnv1a64 .hexproj via sameProjectIdentity and importProject without HEX_WORKSPACE_STALE', async () => {
    const app = createMockApp();
    const storage = createMemoryStorage();
    const ws = new ProductWorkspace(app, { storage });
    await ws.bind();

    const legacyProject = createHexProject({
      binary: {
        hash: LEGACY_FNV,
        metadata: { ...ws.identity.metadata },
      },
      userNames: [{ address: 0x1000n, value: 'legacy_fn' }],
    });
    assert.equal(sameProjectIdentity(legacyProject, ws.identity).ok, true);

    const serialized = serializeHexProject(legacyProject);
    const imported = await ws.importProject(serialized);
    assert.equal(imported.user.names.length, 1);
    assert.equal(app.notes.names.get('4096'), 'legacy_fn');
    assert.equal(app.symbols.renames.get('4096'), 'legacy_fn');

    // Re-snapshot upgrades binary.hash to SHA-256
    const upgraded = ws.snapshot();
    assert.equal(upgraded.binary.hash, SHA256_ID);
  });

  it('imports SHA-256 .hexproj cleanly without false stale error', async () => {
    const app = createMockApp();
    const storage = createMemoryStorage();
    const ws = new ProductWorkspace(app, { storage });
    await ws.bind();

    const modernProject = createHexProject({
      binary: { hash: SHA256_ID, metadata: { ...ws.identity.metadata } },
      userNames: [{ address: 0x2000n, value: 'sha_fn' }],
    });
    const imported = await ws.importProject(serializeHexProject(modernProject));
    assert.equal(imported.binary.hash, SHA256_ID);
    assert.equal(app.notes.names.get('8192'), 'sha_fn');
  });

  it('rejects malformed patches (missing offset) with HEX_PROJECT_INVALID_PATCH', () => {
    const app = createMockApp({ fileSize: 4096 });
    const badProject = createHexProject({
      binary: binaryIdentity(app),
    });
    badProject.user.patches = [{ before: [0x00], after: [0x01] }];

    assert.throws(
      () => applyWorkspaceProject(app, badProject),
      (err) => err?.code === 'HEX_PROJECT_INVALID_PATCH',
    );
  });

  it('rejects out-of-range patches (both Number and BigInt fileSize) with HEX_PROJECT_PATCH_OUT_OF_RANGE', () => {
    for (const useBigIntSize of [false, true]) {
      const app = createMockApp({ fileSize: 1024, useBigIntSize });
      const project = createHexProject({
        binary: binaryIdentity(app),
        patches: [{ offset: 1020n, before: [1, 2, 3, 4, 5], after: [9, 9, 9, 9, 9] }],
      });

      assert.throws(
        () => applyWorkspaceProject(app, project),
        (err) => err?.code === 'HEX_PROJECT_PATCH_OUT_OF_RANGE',
      );
      assert.equal(app.patches.list().length, 0, 'failed preflight must leave patches untouched');
    }
  });

  it('uses symbols.renameMany({ replace: true }) and notes.replaceAll + save({ replace: true })', () => {
    const app = createMockApp({ withRenameMany: true, withReplaceAll: true });
    const project = createHexProject({
      binary: binaryIdentity(app),
      userNames: [
        { address: 0x1000n, value: 'fn_a' },
        { address: 0x1004n, value: 'fn_b' },
      ],
    });
    applyWorkspaceProject(app, project);

    assert.equal(app.symbols.renameCalls, 0, 'must not call per-item rename() when renameMany is available');
    assert.equal(app.symbols.renameManyCalls.length, 1);
    assert.equal(app.symbols.renameManyCalls[0].opts.replace, true);
    assert.equal(app.symbols.renameManyCalls[0].entries.length, 2);
    assert.equal(app.notes.replaceAllCalls.length, 1);
    assert.deepEqual(app.notes.saveCalls.at(-1), { replace: true });
  });

  it('debounces IDB autosave, supports immediate flush, restores from IDB (primary and legacy keys), and notifies on error/success', async () => {
    const app = createMockApp();
    const storage = createMemoryStorage();
    const idb = createMockIdb();
    const errors = [];
    let successes = 0;

    const ws = new ProductWorkspace(app, {
      storage,
      autosaveDebounceMs: 40,
      onAutosaveError: (e) => errors.push(e),
      onAutosaveSuccess: () => { successes += 1; },
    });
    ws.setIdb(idb);
    await ws.bind();

    app.notes.names.set('4096', 'debounced_fn');
    assert.equal(ws.autosave(), true);
    assert.equal(ws.autosave(), true);
    assert.equal(idb.saveCalls, 0, 'debounced calls must not write synchronously');

    await ws.flushAutosave();
    assert.equal(idb.saveCalls, 1, 'flushAutosave writes once immediately');
    assert.equal(successes, 1);
    assert.equal(storage.map.size, 0, 'IDB mode must not write project JSON to localStorage');

    // Verify restore from IDB on fresh ProductWorkspace bind()
    const app2 = createMockApp();
    const ws2 = new ProductWorkspace(app2, { storage, idb });
    await ws2.bind();
    assert.equal(app2.notes.names.get('4096'), 'debounced_fn');

    // Verify error notification on IDB failure
    idb.failSaves = true;
    assert.equal(ws.autosave({ immediate: true }), true);
    await ws.flushAutosave();
    assert.equal(errors.length, 1);
    assert.equal(ws.lastAutosaveError?.code, 'QUOTA_EXCEEDED');

    // Verify recovery clears lastAutosaveError
    idb.failSaves = false;
    assert.equal(ws.autosave({ immediate: true }), true);
    await ws.flushAutosave();
    assert.equal(ws.lastAutosaveError, null);
    assert.equal(successes, 2);
  });

  it('restores legacyHash project from localStorage fallback when IDB has no entry', async () => {
    const app = createMockApp();
    const storage = createMemoryStorage();
    const idb = createMockIdb();
    const ws = new ProductWorkspace(app, { storage, idb });

    const legacyIdentity = binaryIdentity(app, LEGACY_FNV);
    const legacyKey = ws._localKey(legacyIdentity);
    const legacyProject = createHexProject({
      binary: { hash: LEGACY_FNV, metadata: { ...legacyIdentity.metadata } },
      userNames: [{ address: 0x3000n, value: 'from_legacy_ls' }],
    });
    storage.setItem(legacyKey, serializeHexProject(legacyProject));

    await ws.bind();
    assert.equal(app.notes.names.get('12288'), 'from_legacy_ls');
  });

  it('notifies onAutosaveError and returns false when localStorage fallback fails', async () => {
    const app = createMockApp();
    const storage = createMemoryStorage();
    const errors = [];
    const ws = new ProductWorkspace(app, {
      storage,
      onAutosaveError: (e) => errors.push(e),
    });
    await ws.bind();

    storage.failWrites = true;
    assert.equal(ws.autosave(), false);
    assert.equal(errors.length, 1);
    assert.equal(ws.lastAutosaveError?.name, 'QuotaExceededError');
  });
  it('restores legacyHash project from IDB projects store when primary SHA-256 key is absent', async () => {
    const app = createMockApp();
    const storage = createMemoryStorage();
    const idb = createMockIdb();
    const ws = new ProductWorkspace(app, { storage, idb });

    const legacyIdentity = binaryIdentity(app, LEGACY_FNV);
    const legacyKey = ws._localKey(legacyIdentity);
    const legacyProject = createHexProject({
      binary: { hash: LEGACY_FNV, metadata: { ...legacyIdentity.metadata } },
      userNames: [{ address: 0x4000n, value: 'from_legacy_idb' }],
    });
    await idb.saveProject(legacyKey, serializeHexProject(legacyProject, { compact: true }));

    assert.equal(storage.map.size, 0);
    await ws.bind();
    assert.equal(app.notes.names.get('16384'), 'from_legacy_idb');
  });

  it('coalesces rapid debounced autosave() calls into a single natural IDB write', async () => {
    const app = createMockApp();
    const storage = createMemoryStorage();
    const idb = createMockIdb();
    const ws = new ProductWorkspace(app, { storage, idb, autosaveDebounceMs: 25 });
    await ws.bind();

    app.notes.names.set('4096', 'v1');
    assert.equal(ws.autosave(), true);
    app.notes.names.set('4096', 'v2');
    assert.equal(ws.autosave(), true);
    app.notes.names.set('4096', 'v3');
    assert.equal(ws.autosave(), true);
    assert.equal(idb.saveCalls, 0);

    await new Promise((resolve) => setTimeout(resolve, 65));
    await ws.flushAutosave();
    assert.equal(idb.saveCalls, 1, 'debounced timer should fire once with latest snapshot');
    const saved = [...idb.projects.values()][0];
    assert.match(saved.payload, /"v3"/);
  });

  it('persists previous file on autosave({ immediate: true }) even when invalidate() follows synchronously, and drops stale revision writes', async () => {
    const app = createMockApp();
    const storage = createMemoryStorage();
    const idb = createMockIdb();
    const ws = new ProductWorkspace(app, { storage, idb, autosaveDebounceMs: 30 });
    await ws.bind();

    const prevKey = ws._localKey(ws.identity);
    app.notes.names.set('4096', 'saved_before_switch');
    assert.equal(ws.autosave({ immediate: true }), true);
    ws.invalidate();
    await ws.flushAutosave();

    assert.equal(idb.saveCalls, 1, 'immediate autosave must not be dropped by synchronous invalidate()');
    assert.ok(idb.projects.has(prevKey));
    assert.match(idb.projects.get(prevKey).payload, /saved_before_switch/);

    // Rebind to a new binary and confirm stale expectedRevision is ignored
    const nextSha = 'bin_sha256_' + 'b'.repeat(64);
    app.backend.binaryId = nextSha;
    app.backend.ensureBinaryId = async () => nextSha;
    app.notes.names.set('4096', 'next_file_name');
    await ws.bind();
    const oldRev = ws.bindingRevision;
    ws.invalidate();
    const staleResult = await ws._performIdbAutosave(oldRev);
    assert.equal(staleResult, false, 'stale bindingRevision must abort deferred IDB autosave');
    assert.equal(idb.saveCalls, 1);
  });

  it('rejects duplicate-offset patches and oversized types/vars entries on direct applyWorkspaceProject()', () => {
    const app = createMockApp({ fileSize: 4096 });
    const dupPatchProject = createHexProject({ binary: binaryIdentity(app) });
    dupPatchProject.user.patches = [
      { offset: 16n, before: [0x01, 0x02], after: [0x03, 0x04] },
      { offset: 16n, before: [0x01, 0x02], after: [0x05, 0x06] },
    ];
    assert.throws(
      () => applyWorkspaceProject(app, dupPatchProject),
      (err) => err?.code === 'HEX_PROJECT_INVALID_PATCH',
    );

    const longTypeProject = createHexProject({ binary: binaryIdentity(app) });
    longTypeProject.user.types = [{ key: '0x1000:ret', value: 'T'.repeat(200) }];
    assert.throws(
      () => applyWorkspaceProject(app, longTypeProject),
      (err) => err?.code === 'HEX_PROJECT_TYPE_TOO_LONG',
    );

    const longVarProject = createHexProject({ binary: binaryIdentity(app) });
    longVarProject.user.vars = [{ key: '0x1000:v0', value: 'V'.repeat(300) }];
    assert.throws(
      () => applyWorkspaceProject(app, longVarProject),
      (err) => err?.code === 'HEX_PROJECT_VAR_TOO_LONG',
    );
  });

  it('constructs safely with storage=null when globalThis.localStorage throws SecurityError', () => {
    const app = createMockApp();
    const originalDesc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        const err = new Error('Access is denied.');
        err.name = 'SecurityError';
        throw err;
      },
    });
    try {
      const ws = new ProductWorkspace(app);
      assert.equal(ws.storage, null);
    } finally {
      if (originalDesc) Object.defineProperty(globalThis, 'localStorage', originalDesc);
      else delete globalThis.localStorage;
    }
  });

  it('flushes pending debounced autosave on file switch/invalidate and does not misattribute stale errors or successes to the next file', async () => {
    const app = createMockApp();
    const storage = createMemoryStorage();
    let releaseFirstSave;
    const firstSaveGate = new Promise((resolve) => { releaseFirstSave = resolve; });
    const baseIdb = createMockIdb();
    let failFirstSave = false;
    const savedKeys = [];
    const gatedIdb = {
      ...baseIdb,
      async saveProject(key, payload, meta) {
        savedKeys.push(key);
        if (savedKeys.length === 1) {
          await firstSaveGate;
          if (failFirstSave) {
            const err = new Error('File A quota error');
            err.code = 'QUOTA_EXCEEDED';
            throw err;
          }
        }
        return baseIdb.saveProject(key, payload, meta);
      },
      loadProject: (key) => baseIdb.loadProject(key),
      flush: () => baseIdb.flush(),
    };

    const errors = [];
    let successes = 0;
    const ws = new ProductWorkspace(app, {
      storage,
      idb: gatedIdb,
      autosaveDebounceMs: 200,
      onAutosaveError: (e) => errors.push(e),
      onAutosaveSuccess: () => { successes += 1; },
    });
    await ws.bind();
    const keyA = ws._localKey(ws.identity);

    // Schedule debounced autosave for File A, then immediately switch/invalidate before debounce fires.
    app.notes.names.set('4096', 'unsaved_file_a_edit');
    assert.equal(ws.autosave(), true);
    assert.equal(savedKeys.length, 0, 'debounced save not yet executed');

    // File A's flushed save will fail after File B is bound; it must NOT pollute File B.
    failFirstSave = true;
    ws.invalidate();

    // Bind File B.
    const nextSha = 'bin_sha256_' + 'c'.repeat(64);
    app.backend.binaryId = nextSha;
    app.backend.ensureBinaryId = async () => nextSha;
    app.notes.names.clear();
    await ws.bind();

    // Now let File A's flushed IDB write finish with an error.
    releaseFirstSave();
    await ws.flushAutosave();

    assert.equal(savedKeys[0], keyA, 'pending debounced autosave must be flushed for previous file before reset');
    assert.equal(ws.lastAutosaveError, null, 'previous file autosave error must not be attributed to current file');
    assert.equal(errors.length, 0, 'onAutosaveError must not fire for superseded bindingRevision');
    assert.equal(successes, 0, 'onAutosaveSuccess must not fire for superseded bindingRevision');

    // Also verify a pending debounced autosave succeeds and persists File A data on invalidate().
    const app2 = createMockApp();
    const idb2 = createMockIdb();
    const ws2 = new ProductWorkspace(app2, { storage, idb: idb2, autosaveDebounceMs: 200 });
    await ws2.bind();
    const keyA2 = ws2._localKey(ws2.identity);
    app2.notes.names.set('4096', 'flushed_on_switch');
    assert.equal(ws2.autosave(), true);
    ws2.invalidate();
    await ws2.flushAutosave();
    assert.ok(idb2.projects.has(keyA2), 'debounced autosave must be persisted to IDB when invalidate() runs');
    assert.match(idb2.projects.get(keyA2).payload, /flushed_on_switch/);
  });
});

