import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyClassName, buildAppMap } from '../js/appmap.js';
import { classifyString } from '../js/features.js';
import { vendorInText, vendorOf } from '../js/vendors.js';
import { inferRole, ACTION } from '../js/role.js';
import { describePurpose } from '../js/purpose.js';
import {
  classifyFunction,
  applicationCodeScore,
  discoverSubsystems,
} from '../js/recognition/classifier.js';
import { autoAnalyze } from '../js/auto.js';
import {
  changeVerb,
  oneLiner,
  actionPhrase,
  reasonText,
  notableReasonText,
  roleProofText,
  fnRoleTitle,
  placeName,
  flowPlaceName,
  autoStepText,
} from '../js/narrate.js';
import { lang, setLang } from '../js/i18n.js';

function withLang(target, fn) {
  const prev = lang();
  setLang(target);
  try {
    return fn();
  } finally {
    setLang(prev);
  }
}

/* ── T6-P1-1: CLASS_NAME_HINTS ReDoS fix ─────────────────────── */
test('[T6-P1-1] appmap.js: CLASS_NAME_HINTS avoids O(N^2) ReDoS and preserves normal matches', () => {
  const inputs = [
    'api'.repeat(15000) + 'X',
    'ad'.repeat(15000) + 'X',
    'view'.repeat(15000) + 'X',
  ];
  const t0 = performance.now();
  for (const s of inputs) {
    classifyClassName(s);
  }
  const elapsed = performance.now() - t0;
  assert.ok(elapsed < 250, `Expected linear runtime < 250ms, got ${elapsed.toFixed(1)}ms`);

  const idsOf = (name) => classifyClassName(name).map((h) => h.id);
  assert.ok(idsOf('GameApiClient').includes('network'));
  assert.ok(idsOf('AdsManager').includes('ads'));
  assert.ok(idsOf('ShopViewModel').includes('ui'));
  assert.ok(idsOf('MainViewController').includes('ui'));
});

/* ── T6-P1-2: Low-confidence cluster vendor guard ────────────── */
test('[T6-P1-2] appmap.js: low-confidence cluster vendor does not wipe out app classes', () => {
  const classNames = [
    'MYBattleManager',
    'MYShopController',
    'MYLoginService',
    'MYQuestRunner',
    'MYEnemyUnit',
    'MYItemBag',
    'MYAudioPlayer',
    'MYRankingBoard',
    'MYFriendChat',
    'MYSaveStore',
    'MYTutorialStep',
    'MYGachaPool',
    'GADBannerView',
  ];
  const classes = new Map();
  let addr = 0x100001000n;
  for (const name of classNames) {
    classes.set(name, { name, methods: [{ sel: 'run', addr }], classMethods: [] });
    addr += 0x100n;
  }
  const fields = { classes, classCount: classes.size };
  const map = buildAppMap({ fields });
  const byName = new Map();
  for (const cat of map.subsystems) {
    for (const c of cat.classes) byName.set(c.name, cat.id);
  }
  assert.equal(byName.get('MYBattleManager'), 'battle');
  assert.equal(byName.get('MYShopController'), 'purchase');
  assert.equal(byName.get('MYLoginService'), 'login');
  assert.equal(byName.get('GADBannerView'), 'ads');
});

/* ── T6-P1-3: Unified negative lookaheads ────────────────────── */
test('[T6-P1-3] features.js & appmap.js: unified negative lookaheads eliminate draw/present/unity/third-party false positives', () => {
  const featIds = (s) => classifyString(s).map((h) => h.id);
  for (const fp of ['DrawingRect', 'DrawCall', 'PresentationController', 'PresentModal', 'presentViewController']) {
    assert.equal(featIds(fp).includes('gacha'), false, `${fp} should not classify as gacha`);
  }
  assert.equal(featIds('gacha_draw').includes('gacha'), true);
  assert.equal(featIds('present_box').includes('gacha'), true);

  const clsIds = (s) => classifyClassName(s).map((h) => h.id);
  assert.equal(clsIds('UnityAppController').includes('character'), false);
  assert.equal(clsIds('ThirdPartyLibrary').includes('character'), false);
  assert.equal(clsIds('First_Party_SDK').includes('character'), false);
  assert.equal(clsIds('BattleUnit').includes('character'), true);
  assert.equal(clsIds('PartyManager').includes('character'), true);
});

/* ── T6-P1-4: vendorInText game-string FP fix + vendorOf compat ─ */
test('[T6-P1-4] vendors.js: vendorInText avoids generic game string false positives while vendorOf keeps compatibility', () => {
  assert.equal(vendorInText('Adjust volume'), null);
  assert.equal(vendorInText('audio amplitude'), null);
  assert.equal(vendorInText('Flurry of Blows'), null);
  assert.equal(vendorInText('show interstitialad'), null);

  assert.equal(vendorInText('AdjustSDK')?.vendor, 'Adjust');
  assert.equal(vendorInText('https://app.adjust.com/event')?.vendor, 'Adjust');
  assert.equal(vendorInText('AmplitudeSDK')?.vendor, 'Amplitude');
  assert.equal(vendorInText('com.flurry.android.FlurryAgent')?.vendor, 'Flurry');
  assert.equal(vendorInText('admob_rewarded')?.vendor, 'Google Mobile Ads');

  assert.equal(vendorOf('Adjust')?.vendor, 'Adjust');
  assert.equal(vendorOf('Amplitude')?.vendor, 'Amplitude');
  assert.equal(vendorOf('Flurry')?.vendor, 'Flurry');
  assert.equal(vendorOf('InterstitialAd')?.vendor, 'Google Mobile Ads');
});

/* ── T6-P1-5: classifyStorageAction read/write fix ───────────── */
test('[T6-P1-5] role.js: classifyStorageAction separates case-sensitive store/set/get with leading boundaries', () => {
  const storageRole = (name, callees = []) => inferRole({
    name,
    apis: [{ id: 'file', cat: 'io' }],
    callees,
    updates: [],
    stores: 0,
    verified: true,
  });

  assert.equal(storageRole('restoreFromBackup').action, ACTION.LOAD);
  assert.equal(storageRole('MyStore::read').action, ACTION.LOAD);
  assert.equal(storageRole('Store::read').action, ACTION.LOAD);
  assert.equal(storageRole('KeyStore::get').action, ACTION.LOAD);
  assert.equal(storageRole('resetData').action, ACTION.LOAD);
  assert.equal(storageRole('targetValue').action, ACTION.LOAD);
  assert.equal(storageRole('StoredConfig').action, ACTION.LOAD);
  assert.equal(storageRole('StoreFront').action, ACTION.LOAD);
  assert.equal(storageRole('settings').action, ACTION.LOAD);

  assert.equal(storageRole('setValue').action, ACTION.SAVE);
  assert.equal(storageRole('set_config').action, ACTION.SAVE);
  assert.equal(storageRole('storeValue').action, ACTION.SAVE);
  assert.equal(storageRole('STORE_KEY').action, ACTION.SAVE);
  assert.equal(storageRole('writeData').action, ACTION.SAVE);
});

/* ── T6-P1-6: actionOfUpdate sourceOnLeft === false ──────────── */
test('[T6-P1-6] role.js: actionOfUpdate falls back to ACTION.SET when non-commutative op has sourceOnLeft === false', () => {
  const mkUpdate = (step) => ({
    kind: 'read-modify-write',
    location: { base: 'x0', disp: 0x20n, size: 4, stack: false, self: true },
    store: { row: 1, address: 0x1000n },
    from: { row: 0, address: 0x0ffcn },
    steps: [step],
    confidence: 0.9,
  });

  for (const step of [
    { op: 'sub', imm: 10n, sourceOnLeft: false },
    { op: 'subs', imm: 5n, sourceOnLeft: false },
    { op: 'fsub', immFloat: 1.5, sourceOnLeft: false },
    { op: 'sdiv', imm: 2n, sourceOnLeft: false },
    { op: 'lsl', imm: 2n, sourceOnLeft: false },
  ]) {
    const r = inferRole({ updates: [mkUpdate(step)], verified: true });
    assert.equal(r.action, ACTION.SET, `${step.op} with sourceOnLeft=false must be SET`);
    assert.equal(r.amount, null, `${step.op} with sourceOnLeft=false must clear amount`);
  }

  const normalSub = inferRole({ updates: [mkUpdate({ op: 'subs', imm: 5n, sourceOnLeft: true })], verified: true });
  assert.equal(normalSub.action, ACTION.DECREASE);
  assert.equal(normalSub.amount, 5n);
});

/* ── T6-P1-7: changeVerb safeShiftFactor & oneLiner primary step */
test('[T6-P1-7] narrate.js: changeVerb uses safeShiftFactor and oneLiner ignores trailing clamp steps', () => {
  assert.ok(changeVerb({ op: 'lsl', imm: 3n }).includes('8'));
  const bigLsl = changeVerb({ op: 'lsl', imm: 1024n });
  assert.equal(bigLsl.includes('Infinity'), false);
  const negLsr = changeVerb({ op: 'lsr', imm: -1n });
  assert.equal(negLsr.includes('0.5'), false);
  const overAsr = changeVerb({ op: 'asr', imm: 54n });
  assert.equal(overAsr.includes('18014398509481984'), false);

  const clampedLine = oneLiner({
    editTargets: [{
      field: { plain: 'hp' },
      location: { base: 'x0', disp: 0x10n },
      steps: [
        { op: 'sub', imm: 10n },
        { op: 'asr', imm: 31n, signMaskClampPart: true },
        { op: 'bic', signMaskClamp: true },
      ],
    }],
  });
  assert.ok(clampedLine.includes('10'), `Expected primary sub 10 in oneLiner, got: ${clampedLine}`);
  assert.equal(clampedLine.includes('ビット単位'), false);

  const cselLine = oneLiner({
    editTargets: [{
      field: { plain: 'hp' },
      location: { base: 'x0', disp: 0x10n },
      steps: [
        { op: 'sub', imm: 5n },
        { op: 'csel' },
      ],
    }],
  });
  assert.ok(cselLine.includes('5'), `Expected primary sub 5 before csel in oneLiner, got: ${cselLine}`);
});

/* ── T6-P1-8: amountText & reasonText/notableReasonText guards ─ */
test('[T6-P1-8] narrate.js: amountText, reasonText, and notableReasonText do not throw on invalid inputs', () => {
  assert.doesNotThrow(() => actionPhrase('increase', 1.5));
  assert.doesNotThrow(() => actionPhrase('increase', Number.NaN));
  assert.doesNotThrow(() => actionPhrase('increase', Number.POSITIVE_INFINITY));
  assert.doesNotThrow(() => actionPhrase('increase', 'non-numeric'));
  assert.ok(actionPhrase('increase', 1.5).includes('1.5'));

  assert.doesNotThrow(() => reasonText({ code: 'size-penalty', detail: { n: undefined } }));
  assert.doesNotThrow(() => reasonText({ code: 'size-penalty', detail: { n: 'bad' } }));
  assert.doesNotThrow(() => notableReasonText({ code: 'huge', detail: { n: undefined } }));
  assert.doesNotThrow(() => notableReasonText({ code: 'huge', detail: { n: null } }));
});

/* ── T6-P1-9: isFormatString percentage false positives ──────── */
test('[T6-P1-9] purpose.js: isFormatString does not misclassify percentage prose as format strings', () => {
  const mkModel = (texts) => ({
    startAddress: 0x1000n,
    instructions: [],
    calls: [],
    facts: {
      instructionCount: 20,
      calls: 1,
      calledNames: [{ name: 'format_helper', row: 1 }],
      stringRefs: texts.map((text, i) => ({ text, addr: BigInt(0x2000 + i * 16), row: i })),
    },
  });

  const pct = describePurpose({
    model: mkModel(['50% discount', '100% complete', '20% off', '25% chance', '50% EXP', '100%']),
    updates: [],
  });
  assert.equal(pct.formats, 0);
  assert.notEqual(pct.headline?.code, 'work-format');

  const realFmt = describePurpose({
    model: mkModel(['HP: %d/%d (50% off)']),
    updates: [],
  });
  assert.equal(realFmt.formats, 1);
  assert.equal(realFmt.headline?.code, 'work-format');
});

/* ── T6-P1-10: classifier.js rules & vendorConfidenceOf ──────── */
test('[T6-P1-10] classifier.js: vendorConfidenceOf handles string levels and subsystem rules reject false positives', () => {
  const baseFn = {
    address: 0x1000n,
    name: 'sub_1000',
    size: 64,
    imports: [],
    calls: [],
    strings: [],
  };

  const highVendor = classifyFunction(baseFn, {
    vendor: { vendor: 'IronSource', kind: 'ads', confidence: 'high' },
  });
  assert.equal(highVendor.classification, 'SDK');
  assert.equal(highVendor.confidence, 0.85);
  assert.equal(highVendor.hardSuppress, true);

  const lowVendor = classifyFunction(baseFn, {
    vendor: { vendor: 'MY', kind: 'library', confidence: 'low' },
  });
  assert.equal(lowVendor.hardSuppress, false);

  const highScore = applicationCodeScore(baseFn, {
    vendor: { vendor: 'IronSource', kind: 'ads', confidence: 'high' },
  });
  const noVendorScore = applicationCodeScore(baseFn, {});
  assert.ok(highScore < noVendorScore);

  // persistence.calls read patterns
  const persistPositive = [
    ['-[MyStore read]'],
    ['MyStore::read()'],
    ['ReadFile'],
  ];
  for (const calls of persistPositive) {
    const subs = discoverSubsystems({ ...baseFn, calls });
    assert.ok(subs.some((s) => s.subsystem === 'persistence'), `Expected persistence for ${calls[0]}`);
  }
  const persistNegative = discoverSubsystems({
    ...baseFn,
    calls: ['pthread_create', 'spread_damage', 'is_ready', 'already_done'],
  });
  assert.equal(persistNegative.some((s) => s.subsystem === 'persistence'), false);

  // economy/reward coin(?!cid) / gem(?!ent) & semanticHit backing
  const econFP = discoverSubsystems({
    ...baseFn,
    strings: ['coincidence', 'management', 'arrangement'],
    semantic: { writes: [{ disp: 0x10n }], thresholds: [100] },
  });
  assert.equal(econFP.some((s) => s.subsystem === 'economy/reward'), false);

  const econTP = discoverSubsystems({
    ...baseFn,
    strings: ['coin_count'],
    semantic: { writes: [{ disp: 0x10n }], thresholds: [100] },
  });
  const econHit = econTP.find((s) => s.subsystem === 'economy/reward');
  assert.ok(econHit);
  assert.ok(econHit.evidence.includes('semantic-write-threshold'));

  // analytics adjust
  const anaFP = discoverSubsystems({ ...baseFn, strings: ['adjust volume'] });
  assert.equal(anaFP.some((s) => s.subsystem === 'analytics'), false);
  const anaTP = discoverSubsystems({ ...baseFn, strings: ['https://app.adjust.com/ping'] });
  assert.equal(anaTP.some((s) => s.subsystem === 'analytics'), true);
});

/* ── T6-P1-11: auto.js report.notable BigInt normalization ───── */
test('[T6-P1-11] auto.js: report.notable normalizes addresses to BigInt and deduplicates canonical matches', async () => {
  const fn1 = 0x100001000n;
  const fn2 = 0x100002000n;
  const program = {
    functionCount: 2,
    functions: [fn1, fn2],
    functionRange: (a) => (a === fn1 ? { start: fn1, end: fn1 + 0x40n } : { start: fn2, end: fn2 + 0x40n }),
    callersOf: (a) => (a === fn1 ? [{ from: 0x100003000n }, { from: 0x100003100n }, { from: 0x100003200n }] : []),
    calleesOf: () => [],
    refsFrom: () => [],
  };
  const symbols = { nameAt: (a) => (a === fn1 ? 'BattleUpdate' : null) };
  const region = { vmAddr: 0x100000000n, size: 0x10000n };

  const report = await autoAnalyze({
    program,
    symbols,
    region,
    strings: [],
    pinpointBudget: 0,
    deepLimit: 0,
    recognition: {
      complete: true,
      scannedCount: 3,
      total: 3,
      records: [
        { address: '0x100001000', name: 'BattleUpdate', classification: 'APPLICATION', score: 0.91, confidence: 0.9 },
        { address: 0x100002000, name: 'ShopCalc', classification: 'APPLICATION', score: 0.85, confidence: 0.88 },
        { address: 'not-an-address', name: 'Broken', classification: 'APPLICATION', score: 0.99, confidence: 0.99 },
      ],
    },
  });

  assert.ok(report.notable.length >= 2);
  for (const item of report.notable) {
    assert.equal(typeof item.addr, 'bigint');
  }
  const fn1Hits = report.notable.filter((x) => x.addr === fn1);
  assert.equal(fn1Hits.length, 1, 'String hex and BigInt addresses for the same function must deduplicate');
  assert.ok(report.notable.some((x) => x.addr === fn2));
});

/* ── T6-P2-1: role.js kind propagation & narrate.js read/write ─ */
test('[T6-P2-1] role.js & narrate.js: role-subject-field propagates kind and switches read vs write narration', () => {
  const r = inferRole({
    name: '-[BattleManager readCurrentHp]',
    owner: { className: 'BattleManager', sel: 'readCurrentHp' },
    strings: [{ text: 'hp' }],
    updates: [{
      kind: 'read',
      location: { base: 'x0', disp: 0x20n, size: 4, stack: false, self: true },
      store: { row: 0, address: 0x1000n },
      field: { name: '_hp', plain: 'hp', className: 'BattleManager', type: { kind: 'int', bytes: 4 }, certain: true },
      steps: [],
      confidence: 0.9,
    }],
    verified: true,
  });

  const subjItem = (r.evidence || []).find((e) => e.code === 'role-subject-field');
  assert.ok(subjItem, 'Expected role-subject-field evidence item');
  assert.equal(subjItem.detail.kind, 'read');

  const jaRead = withLang('ja', () => roleProofText(subjItem));
  const enRead = withLang('en', () => roleProofText(subjItem));
  assert.ok(jaRead.includes('読み出している'));
  assert.ok(enRead.includes('the field it reads'));

  const writeItem = { code: 'role-subject-field', detail: { name: '_hp', term: 'hp', kind: 'read-modify-write' } };
  const jaWrite = withLang('ja', () => roleProofText(writeItem));
  const enWrite = withLang('en', () => roleProofText(writeItem));
  assert.ok(jaWrite.includes('書き換えている'));
  assert.ok(enWrite.includes('the field it writes'));
});

/* ── T6-P2-2: notableReasonText case 'recognition' ───────────── */
test('[T6-P2-2] narrate.js: notableReasonText formats recognition reason in JA and EN', () => {
  const item = { code: 'recognition', detail: { classification: 'APPLICATION', confidence: 0.92 } };
  const ja = withLang('ja', () => notableReasonText(item));
  const en = withLang('en', () => notableReasonText(item));
  assert.ok(ja.length > 0 && ja.includes('92%'));
  assert.ok(en.length > 0 && en.includes('92%'));
});

/* ── T6-P2-3: English fnRoleTitle double space removal ───────── */
test('[T6-P2-3] narrate.js: English fnRoleTitle has no double space for computed topic role', () => {
  const title = withLang('en', () => fnRoleTitle({
    action: 'compute',
    subject: { kind: 'computed', steps: 5 },
    topic: 'damage',
    topicSettled: true,
  }, { icon: false }));
  assert.equal(title.includes('  '), false, `Unexpected double space in: "${title}"`);
  assert.ok(title.includes('builds the damage value through 5 calculation steps'));
});

/* ── T6-P2-4: hex / atOffset / offsetText safeBigInt ─────────── */
test('[T6-P2-4] narrate.js: hex, atOffset, and offsetText handle invalid/non-integer values safely', () => {
  assert.doesNotThrow(() => placeName(null, 'x0', 'not-a-number'));
  assert.doesNotThrow(() => placeName(null, 'x0', 1.5));
  assert.doesNotThrow(() => flowPlaceName({ kind: 'field', disp: Number.NaN }));
  assert.doesNotThrow(() => flowPlaceName({ kind: 'global', address: 'invalid-addr' }));
  assert.doesNotThrow(() => autoStepText({ code: 'open-update', detail: { addr: 'bad-addr' } }));
});

/* ── T6-P2-5: describePurpose O(N) Set dedup ─────────────────── */
test('[T6-P2-5] purpose.js: describePurpose deduplicates large call/selector/string lists in O(N)', () => {
  const calledNames = [];
  const calls = [];
  const stringRefs = [];
  for (let i = 0; i < 3000; i++) {
    calledNames.push({ name: `fn_${i % 500}`, row: i });
    calls.push({ selector: `sel_${i % 500}:`, row: i });
    stringRefs.push({ text: i % 2 === 0 ? `val_%d_${i % 50}` : `plain_${i % 50}`, addr: BigInt(0x10000 + i * 8), row: i });
  }
  const t0 = performance.now();
  const res = describePurpose({
    model: {
      startAddress: 0x1000n,
      instructions: [],
      calls,
      facts: {
        instructionCount: 100,
        calls: 3000,
        calledNames,
        stringRefs,
      },
    },
    updates: [],
  });
  const elapsed = performance.now() - t0;
  assert.ok(elapsed < 250, `Expected O(N) dedup < 250ms, got ${elapsed.toFixed(1)}ms`);
  assert.equal(res.callNames.length, 8);
  assert.equal(res.texts.length, 6);
  assert.equal(res.formatTexts.length, 6);
  assert.equal(res.formats, 1500);
});
