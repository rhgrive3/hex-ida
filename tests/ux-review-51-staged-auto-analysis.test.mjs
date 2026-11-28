import test from 'node:test';
import assert from 'node:assert/strict';

import { App } from '../js/app.js';
import { Store } from '../js/state.js';
import { SymbolIndex } from '../js/symbols.js';
import { NoteStore } from '../js/names.js';
import { setLang } from '../js/i18n.js';
import {
  DeltaSessionStore,
  STAGED_AUTO_ANALYSIS_STAGES,
  makeDeltaKey,
  normalizeStagedAutoAnalysis,
} from '../js/cache/delta-session.js';
import {
  V6Workbench,
  formatStagedAutoAnalysisStatus,
} from '../js/ui/v6-workbench-bridge.js';
import { AUTO_ANALYSIS_STATUS } from '../js/analysis/common/v6-auto-contracts.js';

function waitTick(ms = 15) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeMemoryLocalStorage() {
  const map = new Map();
  return {
    get length() { return map.size; },
    key(i) { return Array.from(map.keys())[i] ?? null; },
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(String(k), String(v)); },
    removeItem(k) { map.delete(String(k)); },
    clear() { map.clear(); },
  };
}

function makeFakeDomElement(tag = 'span') {
  const listeners = new Map();
  const attrs = new Map();
  const el = {
    tagName: tag.toUpperCase(),
    id: '',
    className: '',
    type: '',
    hidden: false,
    textContent: '',
    dataset: {},
    style: {},
    parentElement: null,
    children: [],
    setAttribute(k, v) { attrs.set(k, String(v)); },
    getAttribute(k) { return attrs.get(k) ?? null; },
    append(...nodes) {
      for (const n of nodes) {
        n.parentElement = el;
        el.children.push(n);
      }
    },
    appendChild(n) {
      n.parentElement = el;
      el.children.push(n);
      return n;
    },
    insertBefore(n, ref) {
      n.parentElement = el;
      const idx = el.children.indexOf(ref);
      if (idx >= 0) el.children.splice(idx, 0, n);
      else el.children.push(n);
      return n;
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    click() {
      for (const fn of listeners.get('click') || []) fn();
    },
  };
  return el;
}

function createHarnessApp({ sha256 = 'deadbeef0001', name = 'DemoApp', deltaStore = null } = {}) {
  const store = new Store();
  const regions = [{ id: 'text', name: '__TEXT.__text', section: '__text', vmAddr: 0x1000n, size: 0x4000n, exec: true }];
  const fileInfo = {
    name,
    size: 0x10000,
    format: 'Mach-O',
    slices: [{ info: { platform: 'ios', architecture: 'arm64', isArm64: true, uuid: `uuid-${sha256}` }, regions }],
  };
  store.set({
    file: { name, size: 0x10000 },
    fileInfo,
    sliceIndex: 0,
    regions,
    currentRegion: regions[0],
    architecture: 'arm64',
    canDisassemble: true,
    displayMode: 'asm',
  });

  const syms = new SymbolIndex({
    funcs: [0x1000n, 0x1100n, 0x1200n, 0x1300n],
    addrs: [0x1000n, 0x1100n],
    names: ['_main', 'sub_1100'],
    regions,
  });

  const app = Object.create(App.prototype);
  app.store = store;
  app.backend = {
    gen: 1,
    contentHash: sha256,
    binaryId: `bin_sha256_${sha256}`,
    formatId: 'macho',
    readAt: async () => ({ found: false, bytes: null }),
    dropQueued() {},
  };
  app.symbols = syms;
  app.notes = new NoteStore(`test-notes-${sha256}`, []);
  app.bookmarks = { list: () => [], restore: () => 0 };
  app.patches = { list: () => [], clear: () => {} };
  app.projectAnnotations = [];
  app.navigation = { entries: [], index: -1, limit: 40, snapshot: () => ({ canBack: false, canForward: false, current: null }) };
  app.uiResume = { explorerFilter: 'all', explorerSort: 'address', lastFunctionTab: null };
  app.sampleOpen = false;
  app._applyingDelta = false;
  app._deltaReadyEpoch = 1;
  app._deltaReadySlice = 0;
  app._deltaSaveTimer = null;
  app.lastDeltaRestore = null;
  app.stagedGoalCandidates = [];
  app.deltaSession = deltaStore || new DeltaSessionStore({ indexedDB: null, localStorage: makeMemoryLocalStorage() });
  app.viewer = {
    symbolUpdates: 0,
    setSymbols() { this.symbolUpdates += 1; },
    invalidate() {},
    setMode() {},
    setRegion() {},
    goToAddress() { return true; },
  };
  app.chromeUpdates = 0;
  app.updateChrome = () => { app.chromeUpdates += 1; };
  app.setMode = () => {};
  app.persistAnalysisSession = async () => true;
  app.v6 = new V6Workbench(app, {
    hexdbFactory: () => ({ open: async () => {}, close: async () => {} }),
  });
  app.v6Workbench = app.v6;
  app._unsubAutoAnalysisStatus = app.v6.subscribeAutoAnalysis((state) => {
    app._renderAutoAnalysisStatus(state);
  });

  return app;
}

test('Review 5.1: executes all 4 stages in order (names -> strings -> callgraph -> goals) with live JA/EN progress updates', async () => {
  setLang('ja');
  const wb = new V6Workbench(null, {
    hexdbFactory: () => ({ open: async () => {}, close: async () => {} }),
  });

  const stageOrder = [];
  const completedOrder = [];
  const jaStatuses = [];
  const enStatuses = [];
  let yieldCount = 0;

  wb.subscribeAutoAnalysis((state) => {
    const ja = formatStagedAutoAnalysisStatus(state, { lang: 'ja' });
    const en = formatStagedAutoAnalysisStatus(state, { lang: 'en' });
    if (ja.text) jaStatuses.push(ja.text);
    if (en.text) enStatuses.push(en.text);
  });

  wb.onBinaryReady({ sha256: 'staged_order_bin', sliceIndex: 0 }, {
    yieldFn: async () => {
      yieldCount += 1;
      await waitTick(1);
    },
    getBinaryMeta: () => ({ platform: 'ios', arch: 'arm64' }),
    getFunctions: () => [],
    getDeobfCandidates: () => [],
    recoverNames: async ({ onProgress }) => {
      stageOrder.push('names');
      onProgress({ completed: 38395, total: 153492 });
      await waitTick(2);
      return {
        named: 41200,
        total: 153492,
        objcCount: 38000,
        swiftCount: 3200,
        hexsigCount: 0,
        entries: [{ va: '0x1000', name: '-[LoginVC tap:]', source: 'objc-runtime' }],
      };
    },
    indexStrings: async ({ onProgress }) => {
      stageOrder.push('strings');
      onProgress({ completed: 120, total: 240 });
      await waitTick(2);
      return { count: 240 };
    },
    indexCallGraph: async ({ onProgress }) => {
      stageOrder.push('callgraph');
      onProgress({ completed: 50, total: 100 });
      await waitTick(2);
      return { functionCount: 153492, callCount: 42000, refCount: 18000 };
    },
    rankGoalCandidates: async () => {
      stageOrder.push('goals');
      await waitTick(2);
      return {
        count: 2,
        candidates: [
          { vaHex: '0x1000', name: '-[LoginVC tap:]', score: 95, reason: 'auth entry', goal: 'auth' },
          { vaHex: '0x2000', name: 'verifyLicense', score: 88, reason: 'license check', goal: 'license' },
        ],
      };
    },
    onStageComplete: (stageId) => {
      completedOrder.push(stageId);
    },
  });

  await waitTick(80);

  assert.deepEqual(stageOrder, ['names', 'strings', 'callgraph', 'goals']);
  assert.deepEqual(completedOrder, ['names', 'strings', 'callgraph', 'goals']);
  assert.ok(yieldCount >= 3, 'must yield cooperatively between stages');

  assert.ok(jaStatuses.includes('名前 38,395 / 153,492'), `expected JA name progress, got: ${JSON.stringify(jaStatuses)}`);
  assert.ok(jaStatuses.includes('文字列の参照を索引中…'), 'expected JA strings stage message');
  assert.ok(jaStatuses.includes('呼び出しグラフを構築中…'), 'expected JA callgraph stage message');
  assert.ok(jaStatuses.includes('目的ごとの候補を整理中…'), 'expected JA goals stage message');
  assert.ok(jaStatuses.some((s) => s.startsWith('自動解析完了') && s.includes('41,200 / 153,492')), 'expected JA completion badge');

  assert.ok(enStatuses.includes('Names 38,395 / 153,492'), 'expected EN name progress');
  assert.ok(enStatuses.includes('Indexing string references…'), 'expected EN strings stage message');
  assert.ok(enStatuses.includes('Building call graph…'), 'expected EN callgraph stage message');
  assert.ok(enStatuses.includes('Ranking goal candidates…'), 'expected EN goals stage message');
  assert.ok(enStatuses.some((s) => s.startsWith('Auto-analysis done')), 'expected EN completion badge');

  const finalState = wb.getAutoAnalysisState();
  assert.equal(finalState.staged.status, AUTO_ANALYSIS_STATUS.DONE);
  for (const stageId of STAGED_AUTO_ANALYSIS_STAGES) {
    assert.equal(finalState.staged.stages[stageId].status, AUTO_ANALYSIS_STATUS.DONE);
  }
  assert.equal(finalState.staged.goalCandidatesSummary.length, 2);
  wb.dispose();
});

test('Review 5.1: cancelling via status bar cancel trigger aborts remaining stages cleanly', async () => {
  setLang('ja');
  const prevDoc = globalThis.document;
  const footer = makeFakeDomElement('footer');
  const stLeft = makeFakeDomElement('span');
  const stRight = makeFakeDomElement('span');
  footer.append(stLeft, stRight);
  globalThis.document = {
    createElement: (tag) => makeFakeDomElement(tag),
    querySelector: (sel) => (sel === '.statusbar' ? footer : null),
    dispatchEvent: () => true,
  };

  try {
    const app = createHarnessApp({ sha256: 'cancel_test_bin' });
    app.dom = { stLeft, stRight };

    let resolveStrings;
    const stringsBlocked = new Promise((r) => { resolveStrings = r; });
    const executed = [];
    let observedAbortInStrings = false;

    app.ensureObjcIndex = async () => { executed.push('objc'); };
    app.ensureSwift = async () => { executed.push('swift'); };
    app.ensureStrings = async () => {
      executed.push('strings');
      await stringsBlocked;
      return [{ addr: 0x3000n, text: 'hello' }];
    };
    app.ensureProgram = async () => {
      executed.push('callgraph');
      return { callCount: 5, refCount: 2 };
    };

    const providers = app._buildV6AutoProviders(1, 0);
    const origIndexStrings = providers.indexStrings;
    providers.indexStrings = async (opts) => {
      opts.signal.addEventListener('abort', () => {
        observedAbortInStrings = true;
        resolveStrings();
      }, { once: true });
      return origIndexStrings(opts);
    };

    app.v6.onBinaryReady(app._currentDeltaFingerprint(), providers);

    // Wait until strings stage is running and cancel button is visible
    for (let i = 0; i < 30 && !executed.includes('strings'); i++) {
      await waitTick(10);
    }
    assert.ok(executed.includes('strings'), 'should reach strings stage');
    assert.equal(app.dom.stAuto.hidden, false, 'status bar auto indicator must be visible');
    assert.equal(app.dom.stAutoCancel.hidden, false, 'cancel button must be visible while running');
    assert.equal(app.dom.stAutoText.textContent, '文字列の参照を索引中…');

    // Click the bottom status bar cancel button
    app.dom.stAutoCancel.click();
    await waitTick(40);

    assert.equal(observedAbortInStrings, true, 'AbortController signal must abort in-flight stage');
    assert.ok(!executed.includes('callgraph'), 'callgraph stage must NOT run after cancel');
    assert.equal(app.dom.stAutoCancel.hidden, true, 'cancel button hides after stopping');
    assert.equal(app.dom.stAutoText.textContent, '自動解析を停止しました');
    assert.equal(app.v6.getAutoAnalysisState().staged.stages.names.status, AUTO_ANALYSIS_STATUS.DONE);
    assert.equal(app.v6.getAutoAnalysisState().staged.stages.callgraph.status, AUTO_ANALYSIS_STATUS.ABORTED);
    app.v6.dispose();
  } finally {
    globalThis.document = prevDoc;
  }
});

test('Review 5.1: switching binaries aborts in-flight staged run cleanly and prevents stale updates', async () => {
  const wb = new V6Workbench(null, {
    hexdbFactory: () => ({ open: async () => {}, close: async () => {} }),
  });

  let releaseBinANames;
  const binANamesGate = new Promise((r) => { releaseBinANames = r; });
  const binAStages = [];
  const binBStages = [];
  let binAAborted = false;

  wb.onBinaryReady({ sha256: 'binary_A', sliceIndex: 0 }, {
    getBinaryMeta: () => ({ platform: 'ios', arch: 'arm64' }),
    getFunctions: () => [],
    getDeobfCandidates: () => [],
    recoverNames: async ({ signal }) => {
      binAStages.push('names');
      signal.addEventListener('abort', () => {
        binAAborted = true;
        releaseBinANames();
      }, { once: true });
      await binANamesGate;
      return { named: 10, total: 20 };
    },
    indexStrings: async () => {
      binAStages.push('strings');
      return { count: 10 };
    },
    indexCallGraph: async () => {
      binAStages.push('callgraph');
      return { functionCount: 20, callCount: 5, refCount: 1 };
    },
    rankGoalCandidates: async () => {
      binAStages.push('goals');
      return { count: 0, candidates: [] };
    },
  });

  // Wait for binary A to enter names stage
  for (let i = 0; i < 20 && binAStages.length === 0; i++) {
    await waitTick(10);
  }
  assert.deepEqual(binAStages, ['names']);

  // Switch to binary B while binary A is in-flight
  wb.onBinaryReady({ sha256: 'binary_B', sliceIndex: 0 }, {
    getBinaryMeta: () => ({ platform: 'ios', arch: 'arm64' }),
    getFunctions: () => [],
    getDeobfCandidates: () => [],
    recoverNames: async () => { binBStages.push('names'); return { named: 5, total: 5 }; },
    indexStrings: async () => { binBStages.push('strings'); return { count: 12 }; },
    indexCallGraph: async () => { binBStages.push('callgraph'); return { functionCount: 5, callCount: 2, refCount: 0 }; },
    rankGoalCandidates: async () => { binBStages.push('goals'); return { count: 1, candidates: [{ vaHex: '0x1000', name: 'entry', score: 90 }] }; },
  });

  await waitTick(80);

  assert.equal(binAAborted, true, 'Binary A AbortController must abort on binary switch');
  assert.deepEqual(binAStages, ['names'], 'Binary A remaining stages must never execute');
  assert.deepEqual(binBStages, ['names', 'strings', 'callgraph', 'goals'], 'Binary B must complete all 4 stages');
  assert.equal(wb.getAutoAnalysisState().binaryKey, 'binary_B|0|');
  assert.equal(wb.getAutoAnalysisState().staged.status, AUTO_ANALYSIS_STATUS.DONE);
  wb.dispose();
});

test('Review 5.1: persists staged results alongside delta session and skips completed stages on reopen', async () => {
  const sharedStorage = makeMemoryLocalStorage();
  const deltaStore1 = new DeltaSessionStore({ indexedDB: null, localStorage: sharedStorage });

  // Session 1: open binary, run all 4 stages, persist delta session
  const app1 = createHarnessApp({ sha256: 'persist_bin_01', name: 'PersistTarget', deltaStore: deltaStore1 });
  const run1Stages = [];

  app1.ensureObjcIndex = async () => {
    run1Stages.push('names');
    app1.symbols.addNames(
      [{ addr: 0x1200n, name: '-[GameState applyDamage:]' }],
      { source: 'objc-runtime', confidence: 1, confirmed: true },
    );
  };
  app1.ensureSwift = async () => {};
  app1.ensureStrings = async () => {
    run1Stages.push('strings');
    return [{ addr: 0x4000n, text: 'damage_multiplier' }];
  };
  app1.ensureProgram = async () => {
    run1Stages.push('callgraph');
    return { callCount: 14, refCount: 9 };
  };

  app1._startV6AutoAnalysis(1, 0);
  await waitTick(90);

  assert.deepEqual(run1Stages, ['names', 'strings', 'callgraph']);
  const state1 = app1.getAutoAnalysisState();
  assert.equal(state1.staged.status, AUTO_ANALYSIS_STATUS.DONE);
  assert.equal(state1.staged.stages.goals.status, AUTO_ANALYSIS_STATUS.DONE);

  // Flush delta session save
  const saved = await app1.flushDeltaSave();
  assert.equal(saved, true, 'delta session must save staged auto-analysis metadata');
  const deltaKey = makeDeltaKey(app1._currentDeltaFingerprint());
  const storedRecord = await deltaStore1.load(deltaKey);
  assert.ok(storedRecord?.resume?.stagedAutoAnalysis, 'stagedAutoAnalysis must be stored in delta session resume');
  assert.equal(storedRecord.resume.stagedAutoAnalysis.stages.names.completed, true);
  assert.equal(storedRecord.resume.stagedAutoAnalysis.stages.strings.completed, true);
  assert.equal(storedRecord.resume.stagedAutoAnalysis.stages.callgraph.completed, true);
  assert.equal(storedRecord.resume.stagedAutoAnalysis.stages.goals.completed, true);
  assert.ok(
    storedRecord.resume.stagedAutoAnalysis.recoveredNamesSummary.entries.some((e) => e.name === '-[GameState applyDamage:]'),
    'recovered names summary must include ObjC recovered symbol',
  );
  app1.v6.dispose();

  // Session 2: reopen same binary with a fresh App + DeltaSessionStore backed by same storage
  const deltaStore2 = new DeltaSessionStore({ indexedDB: null, localStorage: sharedStorage });
  const app2 = createHarnessApp({ sha256: 'persist_bin_01', name: 'PersistTarget', deltaStore: deltaStore2 });
  // Reset delta readiness so restoreDeltaSession runs as on real binary open
  app2._deltaReadyEpoch = -1;
  app2._deltaReadySlice = -1;

  const run2Stages = [];
  app2.ensureObjcIndex = async () => { run2Stages.push('names'); };
  app2.ensureSwift = async () => { run2Stages.push('swift'); };
  app2.ensureStrings = async () => { run2Stages.push('strings'); return []; };
  app2.ensureProgram = async () => { run2Stages.push('callgraph'); return null; };

  const restored = await app2.restoreDeltaSession(1, 0);
  assert.ok(restored, 'restoreDeltaSession must load persisted record');
  // Recovered symbol should already be restored into symbols immediately!
  assert.equal(app2.symbols.nameAt(0x1200n), '-[GameState applyDamage:]');

  app2._startV6AutoAnalysis(1, 0);
  await waitTick(80);

  // Already-completed stages must NOT be re-executed!
  assert.deepEqual(run2Stages, [], 'completed stages must be skipped on reopen');
  const state2 = app2.getAutoAnalysisState();
  assert.equal(state2.staged.status, AUTO_ANALYSIS_STATUS.DONE);
  assert.equal(state2.staged.restoredFromCache, true);
  for (const stageId of STAGED_AUTO_ANALYSIS_STAGES) {
    assert.equal(state2.staged.stages[stageId].status, AUTO_ANALYSIS_STATUS.DONE);
    assert.equal(state2.staged.stages[stageId].restoredFromCache, true);
  }
  app2.v6.dispose();
});

test('Review 5.1: partial cache restore skips completed stages and runs only remaining incomplete stages', async () => {
  const wb = new V6Workbench(null, {
    hexdbFactory: () => ({ open: async () => {}, close: async () => {} }),
  });

  const partialCache = normalizeStagedAutoAnalysis({
    stages: {
      names: { completed: true, recovered: 500, total: 1000, objcCount: 500, completedAt: 1000 },
      strings: { completed: true, count: 320, completedAt: 2000 },
      callgraph: { completed: false },
      goals: { completed: false },
    },
    recoveredNamesSummary: { named: 500, total: 1000, objc: 500, swift: 0, hexsig: 0, entries: [] },
    goalCandidatesSummary: [],
  });

  const ran = [];
  wb.onBinaryReady({ sha256: 'partial_resume_bin', sliceIndex: 0 }, {
    cachedStagedAnalysis: partialCache,
    getBinaryMeta: () => ({ platform: 'ios', arch: 'arm64' }),
    getFunctions: () => [],
    getDeobfCandidates: () => [],
    recoverNames: async () => { ran.push('names'); return { named: 500, total: 1000 }; },
    indexStrings: async () => { ran.push('strings'); return { count: 320 }; },
    indexCallGraph: async () => { ran.push('callgraph'); return { functionCount: 1000, callCount: 80, refCount: 40 }; },
    rankGoalCandidates: async () => { ran.push('goals'); return { count: 1, candidates: [{ vaHex: '0x1000', name: 'main', score: 92 }] }; },
  });

  await waitTick(80);

  assert.deepEqual(ran, ['callgraph', 'goals'], 'must skip cached names/strings and run only callgraph/goals');
  const st = wb.getAutoAnalysisState().staged;
  assert.equal(st.status, AUTO_ANALYSIS_STATUS.DONE);
  assert.equal(st.stages.names.restoredFromCache, true);
  assert.equal(st.stages.strings.restoredFromCache, true);
  assert.equal(st.stages.callgraph.restoredFromCache, false);
  assert.equal(st.stages.goals.restoredFromCache, false);
  wb.dispose();
});

test('Review 5.1: HexSig-recovered names update Stage 1 counts, status bar, and delta cache persistence', async () => {
  const wb = new V6Workbench(null, {
    hexdbFactory: () => ({ open: async () => {}, close: async () => {} }),
  });

  // Mount a distinctive ARM64 memcpy pattern into the workbench's hexsigIndex
  const memcpyBytes = new Uint8Array([
    0xe3, 0x03, 0x00, 0xaa, 0x02, 0x14, 0x17, 0xb4,
    0x24, 0x04, 0x40, 0x38, 0x64, 0x04, 0x00, 0x38,
    0x42, 0x04, 0x00, 0xf1, 0x01, 0x20, 0x23, 0x54,
    0xc0, 0x03, 0x5f, 0xd6, 0x1f, 0x20, 0x03, 0xd5,
    0x1f, 0x20, 0x03, 0xd5, 0x1f, 0x20, 0x03, 0xd5,
    0x1f, 0x20, 0x03, 0xd5, 0xc0, 0x03, 0x5f, 0xd6,
  ]);
  const { buildBuiltinHexSigDb } = await import('../js/analysis/signature/hexsig-db-data.js');
  const db = buildBuiltinHexSigDb();
  wb.hexsigIndex.libs = db.libs;
  for (const entry of db.entries) wb.hexsigIndex.addEntry(entry);

  wb.onBinaryReady({ sha256: 'hexsig_stage1_bin', sliceIndex: 0 }, {
    getBinaryMeta: () => ({ platform: 'ios', arch: 'arm64' }),
    getFunctions: () => [
      { vaHex: '0x1000', name: '-[ExistingObjC foo]', size: 64 },
      { vaHex: '0x2000', name: 'sub_2000', size: 48 },
    ],
    readFunctionBytes: async (vaHex) => (vaHex === '0x2000' ? memcpyBytes : null),
    getDeobfCandidates: () => [],
    recoverNames: async () => ({
      named: 1,
      total: 2,
      objcCount: 1,
      swiftCount: 0,
      hexsigCount: 0,
      entries: [{ va: '0x1000', name: '-[ExistingObjC foo]', source: 'objc-runtime' }],
    }),
    indexStrings: async () => ({ count: 5 }),
    indexCallGraph: async () => ({ functionCount: 2, callCount: 1, refCount: 0 }),
    rankGoalCandidates: async () => ({ count: 0, candidates: [] }),
  });

  await waitTick(100);

  const st = wb.getAutoAnalysisState().staged;
  assert.equal(st.status, AUTO_ANALYSIS_STATUS.DONE);
  assert.equal(st.stages.names.hexsigCount, 1);
  assert.equal(st.stages.names.completed, 2, 'Stage 1 completed count must include HexSig-recovered names');
  assert.equal(st.recoveredNamesSummary.named, 2, 'recoveredNamesSummary.named must include HexSig-recovered names');
  assert.equal(st.recoveredNamesSummary.hexsig, 1);
  assert.ok(
    st.recoveredNamesSummary.entries.some((e) => e.va === '0x2000' && e.name === 'memcpy' && e.source === 'hexsig'),
    `expected HexSig entry in recoveredNamesSummary.entries, got: ${JSON.stringify(st.recoveredNamesSummary.entries)}`,
  );

  const statusModel = formatStagedAutoAnalysisStatus(wb.getAutoAnalysisState(), { lang: 'en' });
  assert.ok(statusModel.text.includes('2 / 2'), `expected status bar to reflect HexSig count, got: ${statusModel.text}`);

  const exported = wb.exportStagedAutoAnalysisCache();
  assert.equal(exported.stages.names.recovered, 2);
  assert.equal(exported.recoveredNamesSummary.named, 2);
  assert.ok(exported.recoveredNamesSummary.entries.some((e) => e.va === '0x2000' && e.name === 'memcpy'));
  wb.dispose();
});

test('Review 5.1: failed names stage is marked ERROR (not DONE) and all-failed run never stays stuck RUNNING', async () => {
  const wb = new V6Workbench(null, {
    hexdbFactory: () => ({ open: async () => {}, close: async () => {} }),
  });

  const completedStages = [];
  wb.onBinaryReady({ sha256: 'all_error_bin', sliceIndex: 0 }, {
    getBinaryMeta: () => ({ platform: 'ios', arch: 'arm64' }),
    getFunctions: () => [],
    getDeobfCandidates: () => [],
    recoverNames: async () => { throw new Error('objc_index_failed'); },
    indexStrings: async () => { throw new Error('strings_failed'); },
    indexCallGraph: async () => { throw new Error('callgraph_failed'); },
    rankGoalCandidates: async () => { throw new Error('goals_failed'); },
    onStageComplete: (stageId) => completedStages.push(stageId),
  });

  await waitTick(80);

  const state = wb.getAutoAnalysisState();
  assert.equal(state.staged.stages.names.status, AUTO_ANALYSIS_STATUS.ERROR, 'failed names stage must be ERROR');
  assert.equal(state.staged.stages.names.completedAt, null, 'failed names stage must not set completedAt');
  assert.deepEqual(completedStages, [], 'failed stages must not invoke onStageComplete');
  assert.equal(state.staged.status, AUTO_ANALYSIS_STATUS.ERROR, 'all-failed run must transition staged.status to ERROR');
  assert.equal(state.staged.activeStage, null);

  const statusModel = formatStagedAutoAnalysisStatus(state, { lang: 'en' });
  assert.equal(statusModel.running, false, 'formatStagedAutoAnalysisStatus must never stay stuck in running: true');

  const exported = wb.exportStagedAutoAnalysisCache();
  assert.equal(exported, null, 'all-failed stages must not be cached as completed');
  wb.dispose();
});
