import test from 'node:test';
import assert from 'node:assert/strict';

import { GOALS, expandTerms, goalFromPreset, matchField, matchText, parseGoal } from '../js/goals.js';
import {
  narrowedPriorCount,
  jevShortlist,
  pinpointField,
  pinpointFunction,
  pinpointLocation,
} from '../js/pinpoint.js';
import { composePinpointFields } from '../js/pinpoint-fields.js';
import { FieldIndex } from '../js/fields.js';
import { CxxMemberIndex } from '../js/analysis/cxx/member-index.js';
import { createCppReceiverEvidence, createCppMemberEvidence } from '../js/analysis/cxx/object-evidence.js';
import { describePurpose, changeAt } from '../js/purpose.js';
import { buildSemanticModel } from '../js/blocks.js';
import { rankCandidates, REASON } from '../js/rank.js';
import { buildAppMap, buildStringMap } from '../js/appmap.js';
import { AMOUNT, SHAPE, foldShapes } from '../js/shapes.js';
import { vendorsOf } from '../js/vendors.js';

const INT4 = { kind: 'int', bytes: 4, signed: true, enc: 'i' };
const BOOL1 = { kind: 'bool', bytes: 1, enc: 'B' };

function makeFieldIndex(defs) {
  return new FieldIndex({
    classes: defs.map((d, i) => ({
      name: d.name,
      addr: BigInt(i + 1),
      superName: d.superName || null,
      instanceSize: d.size || 0x80,
      ivars: d.ivars || [],
      properties: d.properties || [],
      methods: d.methods || [],
      classMethods: d.classMethods || [],
    })),
  });
}

function makeModel(lines, base = 0x100000000n) {
  const rows = lines.map((line, i) => {
    const s = line.trim();
    const p = s.indexOf(' ');
    return {
      row: i,
      address: base + BigInt(i * 4),
      mn: p < 0 ? s : s.slice(0, p),
      ops: p < 0 ? '' : s.slice(p + 1),
    };
  });
  const rowOfAddress = (addr) => {
    const d = addr - base;
    if (d < 0n || d >= BigInt(lines.length * 4)) return null;
    return Number(d / 4n);
  };
  return buildSemanticModel(rows, { startRow: 0, endRow: rows.length - 1, rowOfAddress });
}

test('1. Preset label hijacking: goalFromPreset sets isPreset and preserves Japanese titles', () => {
  const hp = goalFromPreset('hp');
  const dmg = goalFromPreset('damage');
  const money = goalFromPreset('money');
  assert.equal(hp.isPreset, true);
  assert.equal(dmg.isPreset, true);
  assert.equal(money.isPreset, true);
  assert.equal(GOALS.find((g) => g.id === 'hp').ja, 'HP・体力');
  assert.equal(GOALS.find((g) => g.id === 'damage').ja, 'ダメージ計算');
  assert.equal(GOALS.find((g) => g.id === 'money').ja, '所持金・コイン');
});

test('1. Preset label hijacking: English preset label "Score" does not literal-narrow or bypass SDK vendor penalty', async () => {
  const fields = makeFieldIndex([
    { name: 'GameScoreBoard', ivars: [{ name: '_highscore', offset: 0x10, size: 4, type: INT4 }] },
    // SDK prefix with 3+ classes so vendor learning flags LPM* as a vendor
    { name: 'LPMMetric', ivars: [{ name: '_score', offset: 0x10, size: 4, type: INT4 }] },
    { name: 'LPMAd', ivars: [] },
    { name: 'LPMBanner', ivars: [] },
  ]);
  const presetScore = { ...goalFromPreset('score'), text: 'Score' };
  const res = await pinpointField({ goal: presetScore, fields, limit: 40 });
  assert.equal(res.top.className, 'GameScoreBoard');
  assert.equal(res.top.field.name, '_highscore');
  const sdk = res.candidates.find((c) => c.className === 'LPMMetric');
  assert.ok(sdk, 'SDK candidate remains visible for transparency');
  assert.equal(sdk.askedByName, false);
  assert.ok(sdk.evidence.some((e) => e.code === 'third-party-class' || e.code === 'library-prefix-class'));
});

test('2a. Mixed ObjC+C++ prior does not collapse when C++ recallLane candidates are appended', () => {
  const candidates = [
    { key: 'App#8#_totalWaitTime', askedByName: false, askedBySequence: true, askedByWords: false, recallLane: false },
    { key: 'cxx:1', source: 'cxx', askedByName: false, askedBySequence: false, askedByWords: false, recallLane: true },
    { key: 'cxx:2', source: 'cxx', askedByName: false, askedBySequence: false, askedByWords: false, recallLane: true },
  ];
  assert.equal(narrowedPriorCount(candidates, 20000), 1);
  // Pure C++ anonymous universe still retains universe prior
  const cxxOnly = [
    { key: 'cxx:1', source: 'cxx', askedByName: false, askedBySequence: false, askedByWords: false },
    { key: 'cxx:2', source: 'cxx', askedByName: false, askedBySequence: false, askedByWords: false },
  ];
  assert.equal(narrowedPriorCount(cxxOnly, 500), 500);
});

test('2b. jevShortlist orders primary lane ahead of recallLane and higher confidence ahead', () => {
  const shortlist = jevShortlist([
    { key: 'recall_high', recallLane: true, fusion: { logOdds: 99 } },
    { key: 'primary_low', recallLane: false, fusion: { logOdds: 2 } },
    { key: 'primary_high', recallLane: false, fusion: { logOdds: 10 } },
  ]);
  assert.deepEqual(shortlist.map((c) => c.key), ['primary_high', 'primary_low', 'recall_high']);
});

test('2c. purpose.changeAt finds field updates ranked 7+ without top-6 truncation', () => {
  const lines = ['mov x19, x0'];
  // Create 8 distinct 4-byte field updates so the 8th offset sits below top 6
  for (let i = 0; i < 8; i++) {
    const off = 0x20 + i * 4;
    lines.push(`ldr w8, [x19, #0x${off.toString(16)}]`);
    lines.push(`add w8, w8, #1`);
    lines.push(`str w8, [x19, #0x${off.toString(16)}]`);
  }
  lines.push('ret');
  const model = makeModel(lines);
  const purpose = describePurpose({ model, addr: 0x100000000n });
  assert.equal(purpose.changes.length, 6, 'display changes remain concise at 6');
  assert.equal(purpose.allChanges.length, 8, 'allChanges preserves every update');
  for (let i = 0; i < 8; i++) {
    const off = 0x20 + i * 4;
    assert.ok(changeAt(purpose, off), `changeAt must find offset 0x${off.toString(16)}`);
  }
});

test('2d. pinpointFunction applies REASON.VENDOR penalty and pinpointLocation passes verdict to starsOf', async () => {
  const goal = goalFromPreset('money');
  const fnRes = await pinpointFunction({
    goal,
    ranked: [
      {
        addr: 0x1000n,
        name: '-[LPMReward coin]',
        vendor: { vendor: 'IronSource', kind: 'ads', confidence: 'high' },
        reasons: [
          { code: REASON.NAME, points: 25, detail: { name: '-[LPMReward coin]' } },
          { code: REASON.VENDOR, points: -34, detail: { vendor: 'IronSource', kind: 'ads' } },
        ],
        strings: [],
      },
      {
        addr: 0x2000n,
        name: '-[PlayerWallet coin]',
        reasons: [
          { code: REASON.NAME, points: 25, detail: { name: '-[PlayerWallet coin]' } },
        ],
        strings: [],
      },
    ],
    functionCount: 200,
  });
  assert.equal(fnRes.top.addr, 0x2000n);
  const sdkFn = fnRes.candidates.find((c) => c.addr === 0x1000n);
  assert.ok(sdkFn.evidence.some((e) => e.code === 'third-party-class'));
  assert.ok(fnRes.top.probability > sdkFn.probability);

  const BASE = 0x100000000n;
  const model = makeModel([
    'mov x19, x0',
    'ldr w9, [x20, #0x30]',
    'ldr w8, [x19, #0x20]',
    'sub w8, w8, w9',
    'cmp w8, #0',
    'csel w8, w8, wzr, gt',
    'str w8, [x19, #0x20]',
    'ret',
  ], BASE);
  const locRes = await pinpointLocation({
    goal: goalFromPreset('hp'),
    ranked: [{ addr: BASE, name: 'applyDamage', strings: [{ text: 'HP damage' }] }],
    program: { functionRange: () => ({ start: BASE, end: BASE + 32n }), functionStartOf: () => BASE },
    analyze: async () => model,
    limit: 5,
  });
  assert.ok(locRes.top);
  assert.ok(locRes.top.stars >= 1 && locRes.top.stars <= 5);
});

test('2e. pinpoint-fields composePinpointFields includes cxxFields in ownerOf and ownersOf', () => {
  const objcFields = makeFieldIndex([
    { name: 'ObjCPlayer', methods: [{ sel: 'hp', addr: 0x1000n }], ivars: [{ name: '_hp', offset: 8, size: 4, type: INT4 }] },
  ]);
  const cxxFields = new CxxMemberIndex();
  const receiver = createCppReceiverEvidence({
    functionId: 'fn_0x2000',
    functionAddress: 0x2000n,
    canonicalValueId: 'arg0',
    receiverRole: 'this',
    classIdentity: { kind: 'named', className: 'CppPlayer' },
    nonStaticProof: { rule: 'vtable-slot', isStatic: false },
    abiBinding: { architecture: 'arm64', register: 'x0', argumentIndex: 0 },
    snapshotId: 'snap:0',
    completeness: 'complete',
  });
  cxxFields.publish({
    receiver,
    members: [createCppMemberEvidence({
      functionId: receiver.functionId,
      receiverDigest: receiver.digest,
      snapshotId: receiver.snapshotId,
      offsetBytes: 16n,
      sizeBytes: 4,
      category: 'int32',
      typeLabel: 'int32_t',
      rule: 'width-32',
      readCount: 1,
      writeCount: 1,
    })],
  });
  const composed = composePinpointFields(objcFields, cxxFields);
  assert.equal(composed.ownerOf(0x1000n).className, 'ObjCPlayer');
  assert.equal(composed.ownerOf(0x2000n).className, 'CppPlayer');
  assert.equal(composed.ownerOf(0x2000n).source, 'cxx');
  assert.equal(composed.ownersOf(0x2000n).length, 1);
  assert.equal(composed.ownersOf(0x2000n)[0].className, 'CppPlayer');
});

test('3. Domain vocabulary gaps: IAP, Anti-cheat, HP UI-widget avoid, Currency/Coins', () => {
  const purchase = goalFromPreset('purchase');
  for (const term of ['iap', 'in-app purchase', 'inapp', 'sku', 'entitlement', 'storekit', 'receipt']) {
    assert.ok(matchText(purchase, term), `purchase should match "${term}"`);
  }
  for (const field of ['_iapProduct', '_inAppState', '_sku', '_entitlement', '_storeKitReceipt']) {
    assert.ok(matchField(purchase, field), `purchase field should match "${field}"`);
  }

  const anticheat = goalFromPreset('anticheat');
  assert.equal(matchField(anticheat, 'isSecureTextEntry'), null, 'anticheat must not match UI isSecureTextEntry');
  assert.equal(matchField(anticheat, 'secureTextEntry'), null);
  for (const term of ['rooted', 'rooting', 'root_detect', 'rootCheck', 'magisk', 'ptrace', 'sslpinning', 'frida', 'jailbreak', 'tamper']) {
    assert.ok(matchText(anticheat, term), `anticheat should match "${term}"`);
  }

  const hp = goalFromPreset('hp');
  for (const uiWidget of ['_hpBar', 'healthBar', 'healthLabel', 'hpLabel', 'hpGauge']) {
    assert.equal(matchField(hp, uiWidget), null, `hp must avoid UI widget "${uiWidget}"`);
  }
  assert.ok(matchField(hp, '_hp'));
  assert.ok(matchField(hp, '_currentHP'));

  const money = goalFromPreset('money');
  for (const term of ['coins', 'diamond', 'crystal', 'gem', 'gold', 'wallet']) {
    assert.ok(matchText(money, term), `money should match "${term}"`);
    assert.ok(matchField(money, '_' + term), `money field should match "_${term}"`);
  }
});

test('4a. pinpoint.js does not permanently cache emptyGroups() when scanAccess is aborted', async () => {
  const BASE = 0x100000000n;
  const shapes = foldShapes({
    count: 1, capped: false,
    disp: Int32Array.of(0x20),
    size: Uint8Array.of(4),
    flags: Uint8Array.of(SHAPE.DECREASE | SHAPE.CROSS),
    amtKind: Uint8Array.of(AMOUNT.FIELD),
    amtDisp: Int32Array.of(0x30),
    addr: BigUint64Array.of(BASE + 16n),
    span: Int32Array.of(0x100),
    amtSize: Uint8Array.of(4),
    amtSpan: Int32Array.of(0x100),
  });
  const model = makeModel([
    'mov x19, x0',
    'ldr w9, [x20, #0x30]',
    'ldr w8, [x19, #0x20]',
    'sub w8, w8, w9',
    'str w8, [x19, #0x20]',
    'ret',
  ], BASE);
  const program = { functionRange: () => ({ start: BASE, end: BASE + 24n }), functionStartOf: () => BASE };
  let calls = 0;
  const scanAccess = async (requested, { signal }) => {
    calls++;
    if (signal?.aborted) {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }
    const groups = new Map();
    for (const item of requested) {
      groups.set(BigInt(item.offset).toString(), [{ addr: BASE + 16n, kind: 'store', size: 4 }]);
    }
    return groups;
  };
  const aborted = new AbortController();
  aborted.abort();
  await pinpointLocation({
    goal: goalFromPreset('hp'),
    ranked: [{ addr: BASE, name: 'applyDamage', strings: [{ text: 'hp' }] }],
    program, shapes, analyze: async () => model, scanAccess, signal: aborted.signal,
  });
  assert.equal(calls, 0, 'pre-aborted signal must not start or poison batched scanAccess');

  const live = await pinpointLocation({
    goal: goalFromPreset('hp'),
    ranked: [{ addr: BASE, name: 'applyDamage', strings: [{ text: 'hp' }] }],
    program, shapes, analyze: async () => model, scanAccess,
  });
  assert.equal(calls, 1);
  assert.ok(live.changeSites.length >= 1, 'subsequent non-aborted call succeeds and populates changeSites');
});

test('4b. rank.js applies vendor penalty before seed selection and statsOf', () => {
  const addrs = [];
  const names = [];
  // 45 SDK functions matching "coin" + 1 real app function matching "coin"
  for (let i = 0; i < 45; i++) {
    addrs.push(BigInt(0x1000 + i * 0x10));
    names.push(`-[GADRewardItem${i} coin]`);
  }
  const appAddr = 0x9000n;
  addrs.push(appAddr);
  names.push('-[PlayerWallet coin]');
  const calleeAddr = 0xa000n;

  const statsQueried = [];
  const seeded = [];
  const symbols = {
    symbolCount: addrs.length,
    functionCount: addrs.length,
    addrs,
    names,
    isFunctionStart: () => true,
    nameAt: (a) => {
      const idx = addrs.indexOf(a);
      return idx >= 0 ? names[idx] : (a === calleeAddr ? '-[PlayerWallet saveBalance]' : null);
    },
  };
  const program = {
    callsCapped: false,
    functionRange: (a) => ({ start: a, end: a + 0x10n }),
    calleesOf: (start) => {
      seeded.push(start);
      return start === appAddr ? [{ addr: calleeAddr, site: appAddr + 4n }] : [];
    },
    callersOf: () => [],
    statsOf: (start) => {
      statsQueried.push(start);
      return { total: 10, numeric: 1, store: 1, cmp: 1, mul: 1, div: 0, fmul: 0, farith: 0, covered: true };
    },
    callCountOf: () => 1,
    functionsReferencing: () => [],
  };
  const vendors = vendorsOf(makeFieldIndex(names.slice(0, 45).map((n) => ({ name: n.slice(2, n.indexOf(' ')) }))));
  const res = rankCandidates({ goal: goalFromPreset('money'), strings: [], program, symbols, vendors });
  assert.equal(res.candidates[0].addr, appAddr, 'real app function must rank #1');
  assert.ok(seeded.includes(appAddr), 'real app function must be selected as a seed despite 45 SDK noise functions');
  assert.ok(statsQueried.includes(appAddr));
  assert.equal(statsQueried.filter((a) => a < appAddr).length, 0, 'hopeless vendor-penalized SDK functions must skip statsOf');
});

test('4c. appmap.js classifies game subsystems before generic ui/system and samples huge string tables', () => {
  const fields = makeFieldIndex([
    { name: 'BattleViewController', methods: [{ sel: 'viewDidLoad', addr: 0x1000n }] },
    { name: 'ShopDialogView', methods: [{ sel: 'buyItem', addr: 0x2000n }] },
    { name: 'StoreKitPurchaseManager', methods: [{ sel: 'buy', addr: 0x3000n }] },
    { name: 'PlainButtonView', methods: [{ sel: 'layoutSubviews', addr: 0x4000n }] },
  ]);
  const map = buildAppMap({ fields });
  const catOf = (name) => map.classes.find((c) => c.name === name)?.category;
  assert.equal(catOf('BattleViewController'), 'battle');
  assert.equal(catOf('ShopDialogView'), 'purchase');
  assert.equal(catOf('StoreKitPurchaseManager'), 'purchase');
  assert.equal(catOf('PlainButtonView'), 'ui');

  // Huge binary with 12,000 strings where game strings appear past index 4,000
  const strings = Array.from({ length: 12_000 }, (_, i) => ({
    addr: BigInt(i * 16),
    text: i >= 8000 && i < 8020 ? 'gacha_summon_rate' : 'plain_padding_string',
    byteLength: i >= 8000 && i < 8020 ? 17 : 20,
  }));
  let xrefCalls = 0;
  const smap = buildStringMap({
    strings,
    program: {
      functionsReferencing(addr) {
        xrefCalls++;
        return [{ addr: 0x5000n + addr }];
      },
    },
  });
  assert.ok(xrefCalls > 0 && xrefCalls <= 4000, 'stratified sampling stays bounded while reaching deep strings');
  assert.ok(smap.subsystems.some((s) => s.id === 'gacha'), 'gacha strings past index 4000 are discovered');
});

test('5. Findings 7, 8, 12: scoped root-detection, coinCount/coin_count matching, and hp avoid trailing word boundary', () => {
  // Finding 7: unscoped root must NOT falsely match anticheat
  const anticheat = goalFromPreset('anticheat');
  for (const benign of ['_rootViewController', '_rootNode', '_rootLayer', '_rootPath', '_squareRoot']) {
    assert.equal(matchField(anticheat, benign), null, `anticheat must not match field "${benign}"`);
    assert.equal(matchText(anticheat, benign), null, `anticheat must not match text "${benign}"`);
  }
  for (const realRoot of ['_isRooted', '_rootingCheck', '_rootDetect', '_rootBypass', '_rootAccess']) {
    assert.ok(matchField(anticheat, realRoot), `anticheat should match field "${realRoot}"`);
  }
  const expandedBenign = expandTerms('rootViewController').map((t) => t.word);
  assert.ok(!expandedBenign.includes('jailbreak'), 'rootViewController must not trigger anticheat synonyms');

  // Finding 8: /\bcoin/i matches coinCount and coin_count
  const money = goalFromPreset('money');
  assert.ok(matchText(money, '-[Player coinCount]'), 'money should match -[Player coinCount]');
  assert.ok(matchText(money, 'coin_count'), 'money should match coin_count');
  assert.ok(matchField(money, '_coinCount'), 'money field should match _coinCount');
  assert.ok(matchField(money, 'coin_count'), 'money field should match coin_count');

  // Finding 12: trailing \b in hp UI-widget avoid does not drop hp_uid or hp_texture
  const hp = goalFromPreset('hp');
  for (const okName of ['hp_uid', 'hp_texture', '_hpUid', '_hpTexture']) {
    assert.ok(matchField(hp, okName), `hp must NOT falsely avoid "${okName}"`);
  }
  for (const uiName of ['hp_ui', 'hp_text', 'health_bar']) {
    assert.equal(matchField(hp, uiName), null, `hp must still avoid UI widget "${uiName}"`);
  }
});

test('6. Finding 9: batchedScanAccess caches emptyGroups() on timeout/error but NOT on in-flight parent abort', async () => {
  const BASE = 0x100000000n;
  const shapes = foldShapes({
    count: 1, capped: false,
    disp: Int32Array.of(0x20),
    size: Uint8Array.of(4),
    flags: Uint8Array.of(SHAPE.DECREASE | SHAPE.CROSS),
    amtKind: Uint8Array.of(AMOUNT.FIELD),
    amtDisp: Int32Array.of(0x30),
    addr: BigUint64Array.of(BASE + 16n),
    span: Int32Array.of(0x100),
    amtSize: Uint8Array.of(4),
    amtSpan: Int32Array.of(0x100),
  });
  const model = makeModel([
    'mov x19, x0',
    'ldr w9, [x20, #0x30]',
    'ldr w8, [x19, #0x20]',
    'sub w8, w8, w9',
    'str w8, [x19, #0x20]',
    'ret',
  ], BASE);
  const program = { functionRange: () => ({ start: BASE, end: BASE + 24n }), functionStartOf: () => BASE };

  // Case A: worker timeout caches emptyGroups() so second call in same burst does NOT re-hammer worker
  let timeoutCalls = 0;
  const slowScan = () => {
    timeoutCalls++;
    return new Promise(() => {}); // never resolves -> triggers timeout
  };
  await pinpointLocation({
    goal: goalFromPreset('hp'),
    ranked: [{ addr: BASE, name: 'applyDamage', strings: [{ text: 'hp' }] }],
    program, shapes, analyze: async () => model, scanAccess: slowScan, accessScanTimeoutMs: 15,
  });
  await pinpointLocation({
    goal: goalFromPreset('hp'),
    ranked: [{ addr: BASE, name: 'applyDamage', strings: [{ text: 'hp' }] }],
    program, shapes, analyze: async () => model, scanAccess: slowScan, accessScanTimeoutMs: 15,
  });
  assert.equal(timeoutCalls, 1, 'timed-out scanAccess must cache emptyGroups() for burst-backoff');

  // Case B: worker rejection caches emptyGroups() for burst-backoff
  let errCalls = 0;
  const failingScan = async () => {
    errCalls++;
    throw new Error('worker crashed');
  };
  await pinpointLocation({
    goal: goalFromPreset('hp'),
    ranked: [{ addr: BASE, name: 'applyDamage', strings: [{ text: 'hp' }] }],
    program, shapes, analyze: async () => model, scanAccess: failingScan,
  });
  await pinpointLocation({
    goal: goalFromPreset('hp'),
    ranked: [{ addr: BASE, name: 'applyDamage', strings: [{ text: 'hp' }] }],
    program, shapes, analyze: async () => model, scanAccess: failingScan,
  });
  assert.equal(errCalls, 1, 'rejected scanAccess must cache emptyGroups() for burst-backoff');

  // Case C: in-flight parent abort must NOT poison cache
  let abortCalls = 0;
  const abortableScan = (requested, { signal }) => {
    abortCalls++;
    if (abortCalls === 1) {
      return new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(new Error('parent aborted')), { once: true });
      });
    }
    const groups = new Map();
    for (const item of requested) {
      groups.set(BigInt(item.offset).toString(), [{ addr: BASE + 16n, kind: 'store', size: 4 }]);
    }
    return Promise.resolve(groups);
  };
  const parentCtrl = new AbortController();
  const firstPromise = pinpointLocation({
    goal: goalFromPreset('hp'),
    ranked: [{ addr: BASE, name: 'applyDamage', strings: [{ text: 'hp' }] }],
    program, shapes, analyze: async () => model, scanAccess: abortableScan, signal: parentCtrl.signal,
  });
  setTimeout(() => parentCtrl.abort('user-cancelled'), 5);
  await firstPromise;
  const secondRes = await pinpointLocation({
    goal: goalFromPreset('hp'),
    ranked: [{ addr: BASE, name: 'applyDamage', strings: [{ text: 'hp' }] }],
    program, shapes, analyze: async () => model, scanAccess: abortableScan,
  });
  assert.equal(abortCalls, 2, 'in-flight parent abort must not poison batchedScanAccess cache');
  assert.ok(secondRes.changeSites.length >= 1, 'follow-up call after parent abort populates changeSites');
});

test('7. Finding 10: buildStringMap stratified sampling covers indices 4000..7999', () => {
  // 6,000 strings (between MAX_STRINGS_TO_SCAN=4000 and 2*MAX_STRINGS_TO_SCAN=8000)
  // with target strings exclusively in 5000..5020
  const strings = Array.from({ length: 6_000 }, (_, i) => ({
    addr: BigInt(i * 16),
    text: i >= 5000 && i < 5020 ? 'gacha_summon_rate' : 'plain_padding_string',
    byteLength: i >= 5000 && i < 5020 ? 17 : 20,
  }));
  let xrefCalls = 0;
  const smap = buildStringMap({
    strings,
    program: {
      functionsReferencing(addr) {
        xrefCalls++;
        return [{ addr: 0x5000n + addr }];
      },
    },
  });
  assert.ok(xrefCalls > 0 && xrefCalls <= 4000, 'stratified sampling stays bounded');
  assert.ok(smap.subsystems.some((s) => s.id === 'gacha'), 'gacha strings in 4000..7999 must be discovered');
});
