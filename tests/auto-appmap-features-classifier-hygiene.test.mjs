import assert from 'node:assert/strict';
import test from 'node:test';

import { autoAnalyze, findings, notableFunctions } from '../js/auto.js';
import { buildAppMap, buildStringMap, classifyClassName } from '../js/appmap.js';
import {
  classifyFeaturesAndEngineAsync,
  classifyString,
  detectEngine,
  groupByFeature,
} from '../js/features.js';
import { fingerprintFunction } from '../js/fingerprint/index.js';
import {
  classifyFunction,
  clusterFunctions,
  discoverSubsystems,
  rankApplicationFunctions,
} from '../js/recognition/classifier.js';

function stubProgram(extra = {}) {
  return {
    callCount: 0,
    refCount: 0,
    statsComplete: true,
    callsCapped: false,
    refsCapped: false,
    functionRange: (addr) => ({ start: addr, end: addr + 0x20n }),
    statsOf: () => ({ total: 10, numeric: 0, mul: 0, div: 0, fmul: 0, load: 1, store: 1, cmp: 0 }),
    callCountOf: () => 0,
    functionsReferencing: () => [],
    refsFrom: () => [],
    calleesOf: () => [],
    ...extra,
  };
}

// ============================================================================
// 1. js/auto.js
// ============================================================================

test('auto.js findings: rewarded requires ad context and TODO is uppercase-only', () => {
  const program = stubProgram({
    functionsReferencing: () => [{ addr: 0x1000n, site: 0x1004n }],
  });
  const strings = [
    { addr: 0x2000n, text: 'Player was rewarded 100 gold' },
    { addr: 0x2020n, text: 'rewarded_ad_unit_id' },
    { addr: 0x2040n, text: 'rewarded video finished' },
    { addr: 0x2060n, text: 'todo list for quest' },
    { addr: 0x2080n, text: 'TODO: remove debug hook' },
    null,
    undefined,
    { addr: 0x20a0n, text: 12345 },
    { addr: 0x20c0n },
  ];

  const hits = findings(strings, program, null);
  const adTexts = hits.filter((h) => h.id === 'ads').map((h) => h.text);
  assert.deepEqual(adTexts, ['rewarded_ad_unit_id', 'rewarded video finished']);

  const debugTexts = hits.filter((h) => h.id === 'debuglog').map((h) => h.text);
  assert.deepEqual(debugTexts, ['TODO: remove debug hook']);
});

test('auto.js notableFunctions: comparator is reflexive (handles duplicate/equal addresses safely)', () => {
  const program = stubProgram({
    statsOf: () => ({ total: 20, numeric: 2, mul: 2, div: 0, fmul: 0, load: 2, store: 2, cmp: 2 }),
    callCountOf: () => 3,
  });
  const symbols = {
    functionCount: 3,
    funcs: [0x1000n, 0x1000n, 0x1020n],
    functionList: () => [
      { addr: 0x1000n, name: 'fnA', size: 0x20n },
      { addr: 0x1000n, name: 'fnA_dup', size: 0x20n },
      { addr: 0x1020n, name: 'fnB', size: 0x20n },
    ],
    nameAt: () => 'fn',
  };
  const res = notableFunctions(program, symbols, null, 10);
  assert.equal(res.length, 3);
  assert.equal(res[0].addr, 0x1000n);
  assert.equal(res[2].addr, 0x1020n);
});

test('auto.js autoAnalyze: recognizedNotable filters by region & APPLICATION only and merges with structuralNotable by score', async () => {
  const region = { vmAddr: 0x1000n, size: 0x1000n };
  const program = stubProgram({
    statsOf: (start) => {
      if (start === 0x1100n) {
        // High structural score: called(18) + numeric(12) + readwrite(10) + named(6) + cmp(4) = 50
        return { total: 40, numeric: 4, mul: 4, div: 0, fmul: 0, load: 5, store: 5, cmp: 3 };
      }
      // Lower structural score: named(6) + readwrite(4) = 10
      return { total: 20, numeric: 0, mul: 0, div: 0, fmul: 0, load: 2, store: 2, cmp: 0 };
    },
    callCountOf: (addr) => (addr === 0x1100n ? 6 : 0),
  });
  const symbols = {
    functionCount: 2,
    funcs: [0x1100n, 0x1200n],
    addrs: [0x1100n, 0x1200n],
    names: ['structHigh', 'structLow'],
    nameAt: (a) => (a === 0x1100n ? 'structHigh' : a === 0x1200n ? 'structLow' : null),
    functionAt: (a) => ({ start: a, end: a + 0x40n }),
  };

  const report = await autoAnalyze({
    strings: [],
    program,
    symbols,
    region,
    recognition: {
      complete: true,
      scannedCount: 5,
      total: 5,
      records: [
        { address: 0x1300n, name: 'recUnknown', classification: 'UNKNOWN', score: 0.99, confidence: 0.5 },
        { address: 0x1400n, name: 'recSdk', classification: 'SDK', score: 0.99, confidence: 0.9 },
        { address: 0x3000n, name: 'recOutOfRegion', classification: 'APPLICATION', score: 0.99, confidence: 0.9 },
        { address: 0x1500n, name: 'recAppHigh', classification: 'APPLICATION', score: 0.85, confidence: 0.9 },
        { address: 0x1600n, name: 'recAppLow', classification: 'APPLICATION', score: 0.30, confidence: 0.7 },
      ],
    },
  });

  const names = report.notable.map((n) => n.name);
  assert.ok(!names.includes('recUnknown'), 'UNKNOWN records must be excluded');
  assert.ok(!names.includes('recSdk'), 'SDK records must be excluded');
  assert.ok(!names.includes('recOutOfRegion'), 'out-of-region APPLICATION records must be excluded');
  // Expected descending score order: recAppHigh (85) > structHigh (50) > recAppLow (30) > structLow (10)
  assert.deepEqual(names, ['recAppHigh', 'structHigh', 'recAppLow', 'structLow']);
});

test('auto.js autoAnalyze: pinpointModes only increments when mode actually executes', async () => {
  const program = stubProgram();
  const symbols = { functionCount: 1, funcs: [0x1000n], nameAt: () => 'fn' };
  const fields = {
    classCount: 1,
    fieldCount: 1,
    classes: new Map([
      ['Player', { name: 'Player', superName: 'NSObject', methods: [{ sel: 'hp', addr: 0x1000n }], classMethods: [], ivars: [] }],
    ]),
    ownerOf: () => null,
    resolveAccess: () => null,
  };

  const reportZeroBudget = await autoAnalyze({
    strings: [{ addr: 0x2000n, text: 'player_hp' }],
    program,
    symbols,
    fields,
    analyze: async () => null,
    pinpointBudget: 0,
  });
  assert.deepEqual(reportZeroBudget.stats.pinpointModes, { field: 0, location: 0, function: 0 });

  const reportZeroField = await autoAnalyze({
    strings: [],
    program,
    symbols,
    fields,
    pinpointBudget: 10,
    pinpointFieldBudget: 0,
  });
  assert.equal(reportZeroField.stats.pinpointModes.field, 0);
  assert.equal(reportZeroField.stats.pinpointModes.location, 0);
  assert.equal(reportZeroField.stats.pinpointModes.function, 0);
});

// ============================================================================
// 2. js/appmap.js
// ============================================================================

test('appmap.js classifyClassName: eliminates false positives and fixes SEManager/SEPlayer', () => {
  const hasId = (name, id) => classifyClassName(name).some((h) => h.id === id);

  // False positives resolved
  assert.equal(hasId('SessionManagement', 'purchase'), false, 'Management must not match gem/purchase');
  assert.equal(hasId('ByteBuffer', 'battle'), false, 'ByteBuffer must not match buff/battle');
  assert.equal(hasId('NSMutableArray', 'ui'), false, 'Mutable must not match table/ui');
  assert.equal(hasId('CameraPermission', 'quest'), false, 'Permission must not match mission/quest');
  assert.equal(hasId('GarbageCollector', 'item'), false, 'Garbage must not match bag/item');
  assert.equal(hasId('HashMap', 'anticheat'), false, 'HashMap must not match hash/anticheat');
  assert.equal(hasId('UILayoutGuide', 'tutorial'), false, 'LayoutGuide must not match guide/tutorial');
  assert.equal(hasId('UILayoutGuide', 'ui'), true, 'LayoutGuide still maps to ui');
  assert.equal(hasId('NavigationDrawer', 'gacha'), false, 'Drawer must not match draw/gacha');
  assert.equal(hasId('MainPresenter', 'gacha'), false, 'Presenter must not match present/gacha');

  // Positive cases preserved
  assert.equal(hasId('GemManager', 'purchase'), true);
  assert.equal(hasId('BuffManager', 'battle'), true);
  assert.equal(hasId('UITableView', 'ui'), true);
  assert.equal(hasId('GameMission', 'quest'), true);
  assert.equal(hasId('ItemBag', 'item'), true);
  assert.equal(hasId('IntegrityHashVerifier', 'anticheat'), true);
  assert.equal(hasId('BeginnerGuide', 'tutorial'), true);
  assert.equal(hasId('GachaDraw', 'gacha'), true);
  assert.equal(hasId('PresentBox', 'gacha'), true);

  // SEManager / SEPlayer fix
  assert.equal(hasId('SEManager', 'audio'), true);
  assert.equal(hasId('SEPlayer', 'audio'), true);
  assert.equal(hasId('SE_Manager', 'audio'), true);
  assert.equal(hasId('BaseManager', 'audio'), false);
  assert.equal(hasId('PurchaseManager', 'audio'), false);
});

test('appmap.js buildAppMap & buildStringMap: classMethods[0].addr fallback, s?.text guard, and samples dedup', () => {
  const fields = {
    classCount: 1,
    classes: new Map([
      [
        'StaticHelper',
        {
          name: 'StaticHelper',
          superName: 'NSObject',
          methods: [],
          classMethods: [{ sel: 'shared', addr: 0x4000n }],
          ivars: [],
          instanceSize: 8,
        },
      ],
    ]),
  };
  const map = buildAppMap({
    fields,
    program: stubProgram(),
    symbols: null,
    strings: [null, { addr: 0x100n, text: 42 }, { addr: 0x120n, text: 'hello' }],
  });
  assert.equal(map.classes[0].addr, 0x4000n);

  const strMap = buildStringMap({
    program: stubProgram({
      functionsReferencing: () => [{ addr: 0x5000n, site: 0x5004n }],
    }),
    symbols: { nameAt: () => 'shopFn' },
    strings: [
      null,
      { addr: 0x6000n, text: undefined },
      { addr: 0x6010n, text: 'purchase_pack' },
      { addr: 0x6020n, text: 'purchase_pack' },
      { addr: 0x6030n, text: 'checkout_flow' },
    ],
  });
  const purchase = strMap.subsystems.find((s) => s.id === 'purchase');
  assert.ok(purchase);
  assert.deepEqual(purchase.functions[0].samples, ['purchase_pack', 'checkout_flow']);
});

// ============================================================================
// 3. js/features.js
// ============================================================================

test('features.js: UE4 word boundary and FEATURES false-positive hardening', () => {
  const hasFeature = (text, id) => classifyString(text).some((h) => h.id === id);

  // UE4 word boundary
  assert.equal(detectEngine([{ addr: 0x1n, text: 'value4_queue4_UE4Game' }]), null);
  assert.equal(detectEngine([{ addr: 0x2n, text: 'UE4 Editor Build' }])?.id, 'unreal');

  // FEATURES false positives eliminated
  assert.equal(hasFeature('ByteBuffer', 'battle'), false);
  assert.equal(hasFeature('buffer_size', 'battle'), false);
  assert.equal(hasFeature('clang_version', 'social'), false);
  assert.equal(hasFeature('UnityEngine', 'character'), false);
  assert.equal(hasFeature('camera_permission', 'quest'), false);
  assert.equal(hasFeature('third-party license', 'social'), false);
  assert.equal(hasFeature('author name', 'login'), false);
  assert.equal(hasFeature('adjustsFontSizeToFitWidth', 'ads'), false);

  // True positives preserved
  assert.equal(hasFeature('apply_buff', 'battle'), true);
  assert.equal(hasFeature('clan_id', 'social'), true);
  assert.equal(hasFeature('unit_id', 'character'), true);
  assert.equal(hasFeature('daily_mission', 'quest'), true);
  assert.equal(hasFeature('party_id', 'social'), true);
  assert.equal(hasFeature('auth_token', 'login'), true);
  assert.equal(hasFeature('adjust.com/event', 'ads'), true);
  assert.equal(hasFeature('AdjustSDK', 'ads'), true);
});

test('features.js: detectEngine and classifyFeaturesAndEngineAsync share engine priority and s?.text guards', async () => {
  const strings = [
    null,
    { addr: 0x10n, text: 999 },
    { addr: 0x20n, text: 'flutter_engine_start' },
    { addr: 0x30n, text: 'UnityEngine.CoreModule' },
  ];

  const syncEngine = detectEngine(strings);
  const asyncRes = await classifyFeaturesAndEngineAsync(strings);
  assert.equal(syncEngine?.id, 'unity');
  assert.equal(asyncRes.engine?.id, 'unity');
  assert.equal(asyncRes.engine?.sample, syncEngine?.sample);

  assert.doesNotThrow(() => groupByFeature(strings));
  assert.equal(detectEngine(null), null);
});

// ============================================================================
// 4. js/recognition/classifier.js
// ============================================================================

test('classifier.js discoverSubsystems: excludes objc_msgSend, pthread_*, and substring xp', () => {
  const objcSubs = discoverSubsystems({ address: 0x1000n, imports: ['_objc_msgSend', 'objc_msgSendSuper2'] });
  assert.equal(objcSubs.some((s) => s.subsystem === 'network'), false);
  const netSubs = discoverSubsystems({ address: 0x1000n, imports: ['send'] });
  assert.equal(netSubs.some((s) => s.subsystem === 'network'), true);

  const pthreadSubs = discoverSubsystems({ address: 0x1000n, imports: ['_pthread_mutex_lock', 'pthread_create'] });
  assert.equal(pthreadSubs.some((s) => s.subsystem === 'persistence'), false);
  const readSubs = discoverSubsystems({ address: 0x1000n, imports: ['fread'] });
  assert.equal(readSubs.some((s) => s.subsystem === 'persistence'), true);

  const xpFalseSubs = discoverSubsystems({ address: 0x1000n, strings: ['export', 'expired', 'exception'] });
  assert.equal(xpFalseSubs.some((s) => s.subsystem === 'economy/reward'), false);
  const xpTrueSubs = discoverSubsystems({ address: 0x1000n, strings: ['gain xp'] });
  assert.equal(xpTrueSubs.some((s) => s.subsystem === 'economy/reward'), true);
});

test('classifier.js: custom-objc/swift-type (+0.24) + not-known-vendor (+0.14) reaches 0.38 only when combined', () => {
  const objcOnly = { address: 0x1000n, objcClass: 'GamePlayer' };
  const swiftOnly = { address: 0x1004n, swiftTypeDescriptor: 'Game.Player' };
  const plain = { address: 0x1008n };

  // Alone: each stays below 0.38 -> UNKNOWN
  const rObjcAlone = classifyFunction(objcOnly, {});
  assert.equal(rObjcAlone.classification, 'UNKNOWN');
  assert.ok(rObjcAlone.evidence.includes('custom-objc-type'));

  const rSwiftAlone = classifyFunction(swiftOnly, {});
  assert.equal(rSwiftAlone.classification, 'UNKNOWN');
  assert.ok(rSwiftAlone.evidence.includes('custom-swift-type'));

  const rNotVendorAlone = classifyFunction(plain, { notKnownVendor: true });
  assert.equal(rNotVendorAlone.classification, 'UNKNOWN');
  assert.ok(rNotVendorAlone.evidence.includes('not-known-vendor'));

  // Combined: 0.24 + 0.14 = 0.38 -> APPLICATION
  const rObjcCombined = classifyFunction(objcOnly, { notKnownVendor: true });
  assert.equal(rObjcCombined.classification, 'APPLICATION');
  assert.ok(rObjcCombined.evidence.includes('custom-objc-type'));
  assert.ok(rObjcCombined.evidence.includes('not-known-vendor'));

  const rSwiftCombined = classifyFunction(swiftOnly, { notKnownVendor: true });
  assert.equal(rSwiftCombined.classification, 'APPLICATION');
  assert.ok(rSwiftCombined.evidence.includes('custom-swift-type'));
  assert.ok(rSwiftCombined.evidence.includes('not-known-vendor'));
});

test('classifier.js isAppleSystemLibrary: expanded frameworks and \\1 backreference enforcement', () => {
  assert.equal(
    classifyFunction({}, { owningLibrary: '/System/Library/Frameworks/UIKit.framework/UIKit' }).classification,
    'SYSTEM'
  );
  assert.equal(
    classifyFunction({}, { owningLibrary: '/System/Library/Frameworks/Metal.framework/Versions/A/Metal' }).classification,
    'SYSTEM'
  );
  assert.equal(
    classifyFunction({}, { owningLibrary: '/System/Library/Frameworks/Security.framework/Versions/A/Security' }).classification,
    'SYSTEM'
  );
  assert.equal(
    classifyFunction({}, { owningLibrary: '/usr/lib/libc++.1.dylib' }).classification,
    'SYSTEM'
  );
  assert.equal(
    classifyFunction({}, { owningLibrary: '/usr/lib/system/libdispatch.dylib' }).classification,
    'SYSTEM'
  );
  // Mismatched bundle name vs binary name must fail the \1 backreference
  assert.equal(
    classifyFunction({}, { owningLibrary: '/System/Library/Frameworks/Foundation.framework/CoreFoundation' }).classification,
    'UNKNOWN'
  );
  assert.equal(
    classifyFunction({}, { owningLibrary: '/System/Library/Frameworks/UIKit.framework/Foundation' }).classification,
    'UNKNOWN'
  );
});

test('classifier.js: rankApplicationFunctions fingerprints once per function and clusterFunctions guards NaN size', () => {
  let baselineReads = 0;
  fingerprintFunction({
    address: 0x2000n,
    objcClass: 'PlayerController',
    get instructions() {
      baselineReads++;
      return ['ret'];
    },
  });
  let instructionReads = 0;
  const fn = {
    address: 0x2000n,
    objcClass: 'PlayerController',
    get instructions() {
      instructionReads++;
      return ['ret'];
    },
  };
  const ranked = rankApplicationFunctions([fn], () => ({ notKnownVendor: true }));
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].classification.classification, 'APPLICATION');
  assert.equal(instructionReads, baselineReads, 'fingerprintFunction must run only once per item in rankApplicationFunctions');

  const clusters = clusterFunctions([
    { address: 0x3000n, size: Number.NaN },
    { address: 0x3010n, size: Number.POSITIVE_INFINITY },
    { address: 0x3020n, size: -5 },
  ]);
  for (const g of clusters) {
    assert.ok(!g.key.includes('NaN'), `cluster key must not contain NaN: ${g.key}`);
    assert.ok(!g.key.includes('Infinity'), `cluster key must not contain Infinity: ${g.key}`);
  }
});
