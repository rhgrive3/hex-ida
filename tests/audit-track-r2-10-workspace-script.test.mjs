import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { applyWorkspaceProject } from '../js/workspace.js';
import { createHexProject } from '../js/project/index.js';
import { SymbolIndex } from '../js/symbols.js';
import { PatchSet } from '../js/patch.js';
import { InvestigationSessionStore, createInvestigationSession } from '../js/ai/session-core/index.js';
import { createApi } from '../js/script.js';
import { SANDBOX_EXECUTION_CONTEXT } from '../js/sandbox.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKER_DIC_SOURCE = fs.readFileSync(path.join(ROOT, 'js/worker-data-in-code-fix.js'), 'utf8');

function createNotesStub(id = 'notes-test') {
  const store = {
    id,
    names: new Map(),
    comments: new Map(),
    types: new Map(),
    vars: new Map(),
    structs: [],
    dirty: false,
    failSave: false,
    lastSaveError: null,
    nameEntries() {
      const out = [];
      for (const [k, name] of this.names.entries()) {
        out.push({ addr: typeof k === 'bigint' ? k : BigInt(k), name });
      }
      return out;
    },
    save() {
      if (this.failSave) {
        this.lastSaveError = { code: 'QUOTA_EXCEEDED' };
        return false;
      }
      this.dirty = false;
      return true;
    },
  };
  return store;
}

// ---------------------------------------------------------------------------
// [P1-1] js/worker-data-in-code-fix.js — findXrefsDataInCode row offset
// ---------------------------------------------------------------------------
test('P1-1: findXrefsDataInCode adds delta / 4n to row for 2nd and subsequent code spans', async () => {
  const regions = new Map();
  const baseRegion = {
    id: 'text',
    vmAddr: 0x1000n,
    size: 0x100n,
    fileOffset: 0x200n,
    dataInCode: [
      { address: 0x1020n, length: 0x20 }, // code span 0: [0x1000, 0x1020) delta=0x00 (rowBase=0)
      { address: 0x1080n, length: 0x10 }, // code span 1: [0x1040, 0x1080) delta=0x40 (rowBase=16)
                                          // code span 2: [0x1090, 0x1100) delta=0x90 (rowBase=36)
    ],
  };
  regions.set('text', baseRegion);

  let callIndex = 0;
  const ctx = {
    regions,
    INSN_SIZE: 4,
    CHUNK_BYTES: 4096,
    MAX_EDGES: 1000,
    MAX_REFS: 1000,
    MAX_KIND_WORDS: 1000,
    getChunk: async () => ({}),
    scanProgram: async () => ({}),
    guessFunctions: async () => ({ starts: [] }),
    runSearch: async () => ({ results: [] }),
    functionStartsForRegion: () => [],
    readRange: async () => new Uint8Array(0),
    Words: { isCallImm: () => false, isBranchImm: () => false, branchImm26: () => null },
    findXrefs: async ({ regionId }) => {
      const sub = regions.get(regionId);
      assert.ok(sub, 'temporary sub-region must exist during __dicFindXrefs');
      const idx = callIndex++;
      if (idx === 0) {
        // Span 0: vmAddr=0x1000n, local row=1 -> addr=0x1004n, global row=1
        assert.equal(sub.vmAddr, 0x1000n);
        return { results: [{ row: 1, addr: sub.vmAddr + 4n, kind: 'branch' }], cancelled: false, capped: false };
      }
      if (idx === 1) {
        // Span 1: vmAddr=0x1040n, local row=2 -> addr=0x1048n, global row=16+2=18
        assert.equal(sub.vmAddr, 0x1040n);
        return { results: [{ row: 2, addr: sub.vmAddr + 8n, kind: 'load' }], cancelled: false, capped: false };
      }
      // Span 2: vmAddr=0x1090n, local row=3n (BigInt) and row=5 (Number)
      assert.equal(sub.vmAddr, 0x1090n);
      return {
        results: [
          { row: 3, addr: sub.vmAddr + 12n, kind: 'address' },
          { row: 5n, addr: sub.vmAddr + 20n, kind: 'store' },
        ],
        cancelled: false,
        capped: false,
      };
    },
  };

  vm.runInNewContext(WORKER_DIC_SOURCE, ctx);

  const out = await ctx.findXrefs({ regionId: 'text', target: 0x2000n, limit: 100 });
  assert.equal(out.cancelled, false);
  assert.equal(out.results.length, 4);

  assert.deepEqual({ ...out.results[0] }, { row: 1, addr: 0x1004n, kind: 'branch' });
  assert.deepEqual({ ...out.results[1] }, { row: 18, addr: 0x1048n, kind: 'load' });
  assert.deepEqual({ ...out.results[2] }, { row: 39, addr: 0x109cn, kind: 'address' });
  assert.deepEqual({ ...out.results[3] }, { row: 41n, addr: 0x10a4n, kind: 'store' });

  // Verify every result's row matches (addr - original.vmAddr) / 4n
  for (const r of out.results) {
    assert.equal(BigInt(r.row), (r.addr - baseRegion.vmAddr) / 4n);
  }
  // Temporary sub-region keys must be cleaned up
  assert.deepEqual([...regions.keys()], ['text']);
});

// ---------------------------------------------------------------------------
// [P1-2] js/workspace.js — colliding session ID preserved/restored on rollback
// ---------------------------------------------------------------------------
test('P1-2: failed import rollback restores pre-existing colliding session and deletes only newly added sessions', () => {
  const hash = 'a'.repeat(64);
  const sessionStore = new InvestigationSessionStore();

  const existingRecord = sessionStore.register(createInvestigationSession({
    id: 'sess-collide',
    binaryId: hash,
    turns: [{ role: 'user', text: 'original investigation turn' }],
  }));
  const untouchedRecord = sessionStore.register(createInvestigationSession({
    id: 'sess-untouched',
    binaryId: hash,
    turns: [{ role: 'user', text: 'untouched turn' }],
  }));

  const notes = createNotesStub('notes-p1-2');
  notes.failSave = true;

  const app = {
    backend: { contentHash: hash },
    notes,
    patches: new PatchSet(),
    symbols: new SymbolIndex({}),
    viewer: { setSymbols() {} },
    aiRuntime: { sessionStore },
  };

  const incomingProject = createHexProject({
    binary: { hash, metadata: { name: 'sample.bin' } },
    userNames: [{ address: 0x1000n, value: 'incoming_fn' }],
    investigationSessions: [
      { id: 'sess-collide', binaryId: hash, turns: [{ role: 'user', text: 'overwritten by failed import' }] },
      { id: 'sess-brand-new', binaryId: hash, turns: [{ role: 'user', text: 'brand new session' }] },
    ],
  });

  assert.throws(() => applyWorkspaceProject(app, incomingProject), /QUOTA_EXCEEDED/);

  // Pre-existing colliding session must NOT be deleted and must be restored to its original value
  assert.equal(sessionStore.sessions.has('sess-collide'), true);
  assert.strictEqual(sessionStore.sessions.get('sess-collide'), existingRecord);
  assert.equal(sessionStore.sessions.get('sess-collide').id, 'sess-collide');

  // Unrelated pre-existing session stays intact
  assert.strictEqual(sessionStore.sessions.get('sess-untouched'), untouchedRecord);

  // Newly added session from the failed import must be removed
  assert.equal(sessionStore.sessions.has('sess-brand-new'), false);
});

// ---------------------------------------------------------------------------
// [P1-3] js/workspace.js — symbol renames cleared on switch & restored on rollback
// ---------------------------------------------------------------------------
test('P1-3: project switch clears stale renames from app.symbols and rollback restores app.symbols and viewer', () => {
  const hash = 'b'.repeat(64);
  const notes = createNotesStub('notes-p1-3');
  notes.names.set('4096', 'old_only_fn');     // 0x1000
  notes.names.set('8192', 'shared_old_name'); // 0x2000

  const symbols = new SymbolIndex({
    addrs: new BigUint64Array([0x1000n, 0x2000n, 0x3000n]),
    names: ['_orig_1000', '_orig_2000', '_orig_3000'],
    kinds: new Uint8Array([0, 0, 0]),
    flags: new Uint8Array([0, 0, 0]),
    funcs: new BigUint64Array([0x1000n, 0x2000n, 0x3000n]),
  });
  symbols.rename(0x1000n, 'old_only_fn');
  symbols.rename(0x2000n, 'shared_old_name');

  let viewerSetSymbolsCalls = 0;
  const app = {
    backend: { contentHash: hash },
    notes,
    patches: new PatchSet(),
    symbols,
    viewer: { setSymbols(s) { viewerSetSymbolsCalls++; assert.strictEqual(s, symbols); } },
  };

  // Step 1: Successful switch to Project B (removes 0x1000 rename, updates 0x2000, adds 0x3000)
  const projectB = createHexProject({
    binary: { hash, metadata: { name: 'sample.bin' } },
    userNames: [
      { address: 0x2000n, value: 'shared_project_b' },
      { address: 0x3000n, value: 'project_b_only' },
    ],
  });
  assert.equal(applyWorkspaceProject(app, projectB), true);

  assert.equal(symbols.renamedAt(0x1000n), null, 'stale rename from previous project must be cleared');
  assert.equal(symbols.nameAt(0x1000n), '_orig_1000', 'cleared rename must fall back to original binary symbol');
  assert.equal(symbols.renamedAt(0x2000n), 'shared_project_b');
  assert.equal(symbols.renamedAt(0x3000n), 'project_b_only');
  assert.equal(notes.names.size, 2);
  assert.equal(symbols.renames.size, 2);
  assert.equal(viewerSetSymbolsCalls, 1);

  // Step 2: Failed switch to Project C -> rollback must restore Project B symbols & notify viewer
  notes.failSave = true;
  const projectC = createHexProject({
    binary: { hash, metadata: { name: 'sample.bin' } },
    userNames: [
      { address: 0x2000n, value: 'failed_override' },
      { address: 0x4000n, value: 'failed_added' },
    ],
  });

  assert.throws(() => applyWorkspaceProject(app, projectC), /QUOTA_EXCEEDED/);

  assert.equal(symbols.renamedAt(0x4000n), null, 'rename added by failed import must be removed on rollback');
  assert.equal(symbols.renamedAt(0x1000n), null);
  assert.equal(symbols.renamedAt(0x2000n), 'shared_project_b', 'overwritten rename must be restored on rollback');
  assert.equal(symbols.renamedAt(0x3000n), 'project_b_only', 'removed rename must be restored on rollback');
  assert.equal(symbols.renames.size, 2);
  assert.equal(notes.names.size, 2);
  assert.equal(viewerSetSymbolsCalls, 3, 'viewer.setSymbols must be invoked on apply and again on rollback');
});

// ---------------------------------------------------------------------------
// [P2-4] js/script.js — emulator* functions strip trailing hostContext
// ---------------------------------------------------------------------------
test('P2-4: emulator* API methods strip trailing sandbox hostContext instead of leaking it into parameters', async () => {
  const BASE = 0x100000000n;
  const region = { id: 'text', vmAddr: BASE, size: 0x1000n, fileOffset: 0n, exec: true, name: '__text' };
  const memBytes = new Uint8Array(256);
  for (let i = 0; i < memBytes.length; i++) memBytes[i] = i & 0xff;

  const patches = new PatchSet();
  // Stage a 4-byte patch at BASE so we can verify applyPatches default (true) vs explicit false
  patches.add(0n, new Uint8Array([0, 1, 2, 3]), new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]), { addr: BASE });

  const values = new Map([
    ['architecture', 'arm64'],
    ['fileInfo', { format: 'macho' }],
    ['file', { name: 'emu-fixture.bin', size: 0x1000 }],
    ['regions', [region]],
  ]);

  const app = {
    store: { get: (k) => values.get(k) },
    codeRegion: () => region,
    currentSlice: () => ({ info: {}, capability: { architecture: 'arm64' } }),
    patches,
    backend: {
      async fetchChunk() {
        // mov x0, #7; ret
        return { mn: ['mov', 'ret'], ops: ['x0, #7', ''], rows: 2 };
      },
      async readAt(addr, len) {
        const off = Number(BigInt(addr) - BASE);
        if (off < 0 || off >= memBytes.length) return { found: false, bytes: null };
        const slice = memBytes.slice(off, Math.min(memBytes.length, off + len));
        return { found: true, bytes: slice };
      },
    },
    symbols: { nameAt: () => null, label: () => null },
    notes: { setName() {}, setComment() {} },
    viewer: { setSymbols() {} },
  };

  const { api } = createApi(app, () => {});
  const controller = new AbortController();
  const hostContext = Object.freeze({
    [SANDBOX_EXECUTION_CONTEXT]: true,
    signal: controller.signal,
  });

  // 0 positional args + hostContext: must not pass hostContext as addr
  const created0 = api.emulatorCreate(hostContext);
  assert.ok(created0.id);

  // 1 positional arg + hostContext: must not pass hostContext as args array
  const created1 = api.emulatorCreate(BASE, hostContext);
  assert.equal(created1.state.pc, BASE);

  // 2 positional args + hostContext: must not pass hostContext as emuOptions
  const created2 = api.emulatorCreate(BASE, [42n], hostContext);
  assert.equal(created2.state.x0, 42n);

  // emulator() alias with trailing hostContext
  const createdAlias = api.emulator(hostContext);
  assert.ok(createdAlias.id);

  // emulatorSetup with omitted args + hostContext
  const setupState = api.emulatorSetup(created0.id, BASE, hostContext);
  assert.equal(setupState.pc, BASE);

  // emulatorDump with omitted len + hostContext: must default len=64 (NOT 0 from NaN)
  const dumped = await api.emulatorDump(created0.id, BASE, hostContext);
  assert.equal(dumped.length, 64, 'omitted len must default to 64 when hostContext is appended');
  // Patch overlay should be active by default (applyPatches !== false)
  assert.deepEqual([...dumped.slice(0, 4)], [0xaa, 0xbb, 0xcc, 0xdd]);

  // Explicit { applyPatches: false } + hostContext still respected
  const createdNoPatch = api.emulatorCreate(BASE, [], { applyPatches: false }, hostContext);
  const dumpedUnpatched = await api.emulatorDump(createdNoPatch.id, BASE, 4, hostContext);
  assert.deepEqual([...dumpedUnpatched], [0, 1, 2, 3]);

  // Remaining emulator* methods with trailing hostContext
  assert.equal(api.emulatorState(created0.id, hostContext).pc, BASE);
  assert.equal(api.emulatorSetRegister(created0.id, 'x1', 99n, hostContext), 99n);
  assert.equal(api.emulatorGetRegister(created0.id, 'x1', hostContext), 99n);
  assert.equal(await api.emulatorStore(created0.id, BASE + 0x20n, 4, 0x12345678n, hostContext), true);
  assert.equal(api.emulatorAddBreakpoint(created0.id, BASE + 4n, hostContext), true);
  assert.deepEqual(api.emulatorBreakpoints(created0.id, hostContext), [BASE + 4n]);
  assert.equal(api.emulatorRemoveBreakpoint(created0.id, BASE + 4n, hostContext), true);
  assert.deepEqual(api.emulatorBreakpoints(created0.id, hostContext), []);
  assert.equal(api.emulatorReset(created0.id, hostContext).steps, 0);
  assert.equal(api.emulatorDestroy(created0.id, hostContext), true);
  assert.equal(api.emulatorDestroy(created1.id, hostContext), true);
  assert.equal(api.emulatorDestroy(created2.id, hostContext), true);
  assert.equal(api.emulatorDestroy(createdAlias.id, hostContext), true);
  assert.equal(api.emulatorDestroy(createdNoPatch.id, hostContext), true);

  // Aborted hostContext signal is respected
  const abortedController = new AbortController();
  abortedController.abort(new Error('cancelled'));
  const abortedContext = Object.freeze({
    [SANDBOX_EXECUTION_CONTEXT]: true,
    signal: abortedController.signal,
  });
  assert.throws(() => api.emulatorCreate(abortedContext), /cancelled/);
});
