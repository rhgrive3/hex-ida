import assert from 'node:assert/strict';
import test from 'node:test';

import { rankCandidates, reasonKind, REASON } from '../js/rank.js';
import {
  EVIDENCE,
  FAMILY,
  GROUP,
  VERDICT,
  evidence,
  evidenceInfo,
  evidenceFamily,
  evidenceKind,
  isIdentifying,
  groupOf,
  fuse,
  decide,
  independentGroupCount,
} from '../js/evidence.js';
import {
  GOALS,
  parseGoal,
  goalFromPreset,
  fieldVocab,
  matchField,
  typeFits,
} from '../js/goals.js';
import { compileGoal } from '../js/goalc.js';
import { FieldIndex } from '../js/fields.js';
import { AMOUNT, SHAPE, foldShapes } from '../js/shapes.js';
import {
  pinpoint,
  pinpointField,
  pinpointLocation,
  pinpointFunction,
} from '../js/pinpoint.js';
import {
  pinpoint as legacyPinpoint,
  pinpointField as legacyPinpointField,
  pinpointLocation as legacyPinpointLocation,
  pinpointFunction as legacyPinpointFunction,
} from '../js/pinpoint-legacy.js';

const INT4 = { kind: 'int', bytes: 4, signed: true, enc: 'i' };
const BASE = 0x100000000n;

function makeGoal(id) {
  return goalFromPreset(id);
}

function makeShapes(offsets = [0x20]) {
  const n = offsets.length;
  return foldShapes({
    count: n,
    capped: false,
    disp: Int32Array.from(offsets),
    size: Uint8Array.from(offsets.map(() => 4)),
    flags: Uint8Array.from(offsets.map(() => SHAPE.DECREASE | SHAPE.CROSS | SHAPE.CLAMP_ZERO)),
    amtKind: Uint8Array.from(offsets.map(() => AMOUNT.FIELD)),
    amtDisp: Int32Array.from(offsets.map(() => 0x30)),
    addr: BigUint64Array.from(offsets.map((_, i) => BASE + BigInt((i + 1) * 0x20))),
    span: Int32Array.from(offsets.map(() => 0x100)),
    amtSize: Uint8Array.from(offsets.map(() => 4)),
    amtSpan: Int32Array.from(offsets.map(() => 0x100)),
  });
}

// ── T5-P1-1: Vendor-tainted seed revival suppression & CALLEE/CALLER damping cap ──
test('T5-P1-1: vendor-tainted seed cannot revive via CALLEE_NAME/CALLER_NAME and non-tainted seeds are damped & capped', () => {
  const goal = makeGoal('money');
  const vendorAddr = 0x1000n;
  const dispatcherAddr = 0x2000n;
  const directAddr = 0x3000n;
  const helperAddrs = Array.from({ length: 10 }, (_, i) => 0x4000n + BigInt(i * 0x100));

  const nameMap = new Map([
    [vendorAddr.toString(), '-[GADRewardedAd rewardCoin]'],
    [dispatcherAddr.toString(), '-[GameLoop tick]'],
    [directAddr.toString(), '-[PlayerWallet addCoin]'],
  ]);
  for (let i = 0; i < helperAddrs.length; i++) {
    nameMap.set(helperAddrs[i].toString(), `-[ShopHelper coinOp${i}]`);
  }

  const symbols = {
    symbolCount: nameMap.size,
    functionCount: nameMap.size,
    addrs: [vendorAddr, dispatcherAddr, directAddr, ...helperAddrs],
    names: [vendorAddr, dispatcherAddr, directAddr, ...helperAddrs].map((a) => nameMap.get(a.toString())),
    nameAt: (a) => nameMap.get(a.toString()) || null,
    functionStartAt: (a) => a,
  };

  const strings = [
    { addr: 0x9000n, text: 'Coin balance updated', byteLength: 20 },
  ];

  const program = {
    functionsReferencing: (addr) => {
      if (addr === 0x9000n) {
        return [
          { addr: directAddr, site: directAddr + 4n, kind: 'adrp-add' },
          { addr: dispatcherAddr, site: dispatcherAddr + 4n, kind: 'adrp-add' },
        ];
      }
      return [];
    },
    functionRange: (addr) => ({ start: addr, end: addr + 0x40n }),
    calleesOf: (start) => {
      if (start === vendorAddr || start === dispatcherAddr) {
        return helperAddrs.map((a, i) => ({ addr: a, site: start + BigInt(i * 4) }));
      }
      return [];
    },
    callersOf: (addr) => {
      if (addr === vendorAddr || addr === dispatcherAddr) {
        return helperAddrs.map((a, i) => ({ addr: a, site: a + BigInt(i * 4) }));
      }
      return [];
    },
    callCountOf: () => 1,
    statsOf: () => ({ total: 20, numeric: 0, store: 0, cmp: 0, covered: true }),
    callsCapped: false,
  };

  const res = rankCandidates({ goal, strings, program, symbols, limit: 40 });
  const vendorCand = res.candidates.find((c) => c.addr === vendorAddr);
  assert.equal(vendorCand, undefined, 'tainted vendor seed must not be revived by CALLEE_NAME/CALLER_NAME');

  const dispatcher = res.candidates.find((c) => c.addr === dispatcherAddr);
  assert.ok(dispatcher, 'non-tainted dispatcher should remain a candidate');
  const calleeReasons = dispatcher.reasons.filter((r) => r.code === REASON.CALLEE_NAME);
  const callerReasons = dispatcher.reasons.filter((r) => r.code === REASON.CALLER_NAME);
  assert.equal(calleeReasons.length, 3, 'CALLEE_NAME must be capped at 3 damped hits');
  assert.equal(callerReasons.length, 3, 'CALLER_NAME must be capped at 3 damped hits');
  const calleeSum = calleeReasons.reduce((s, r) => s + r.points, 0);
  const callerSum = callerReasons.reduce((s, r) => s + r.points, 0);
  assert.ok(calleeSum <= 24, `damped CALLEE_NAME sum (${calleeSum}) must stay bounded`);
  assert.ok(callerSum <= 20, `damped CALLER_NAME sum (${callerSum}) must stay bounded`);
});

// ── T5-P1-2: Net group aggregation in fuse(), independentGroupCount(), observedGroupSet() ──
test('T5-P1-2: fuse(), independentGroupCount(), and observedGroupSet() use net per-group sum while preserving N7b fail-closed', () => {
  // type-declared (+ln(3) ~= +1.0986) + type-conflict (+ln(0.06) ~= -2.8134) => net STRUCTURAL < 0
  const negatedStruct = fuse([
    evidence('field-name-asked', 1),
    evidence('type-declared', 1),
    evidence('type-conflict', 1),
  ], { candidates: 10, absent: 0 });

  assert.ok(negatedStruct.byGroup[GROUP.STRUCTURAL] < 0, 'byGroup preserves negative net sum');
  assert.equal(negatedStruct.groups.includes(GROUP.STRUCTURAL), false, 'net-negative group excluded from groups');
  assert.deepEqual(negatedStruct.groups, [GROUP.METADATA]);
  assert.equal(negatedStruct.independentGroups, 1);
  assert.equal(independentGroupCount(negatedStruct), 1);

  // Even if logOdds/probability were high, net-negative structural group must NOT pass trusted 2-group gate
  const forged = {
    ...negatedStruct,
    logOdds: 6,
    probability: 0.995,
    groups: [GROUP.METADATA, GROUP.STRUCTURAL],
    independentGroups: 2,
  };
  const rival = { fusion: fuse([evidence('field-name-weak', 1)], { candidates: 200 }) };
  const decision = decide([{ fusion: forged }, rival], { allowTrustedTwoGroup: true });
  assert.equal(decision.verdict, VERDICT.AMBIGUOUS, 'negated structural group cannot pass trusted 2-group gate');

  // independentGroupCount: element-wise skip + net sum > 0
  assert.equal(independentGroupCount({
    items: [
      { code: 'unregistered-xyz', applied: 5 },
      { code: 'type-declared', applied: 1.0 },
      { code: 'type-conflict', applied: -2.0 },
      { code: 'field-name-asked', applied: 2.5 },
    ],
  }), 1, 'only net-positive registered group is counted');

  // observedGroupSet fail-closed on a single invalid/unregistered item (N7b compatibility)
  const withUnregistered = fuse([
    evidence('field-name-asked', 1),
    evidence('size-fits', 1),
    evidence('custom-unregistered', 1, {}, 4),
  ], { candidates: 5, absent: 0 });
  const n7bDecision = decide([{ fusion: withUnregistered }, rival], { allowTrustedTwoGroup: true });
  assert.equal(n7bDecision.verdict, VERDICT.AMBIGUOUS, 'observedGroupSet fails closed on unregistered item');
});

// ── T5-P1-3: Facade pinpoint() exported from js/pinpoint.js + shapes-only location fallback ──
test('T5-P1-3: js/pinpoint.js exports facade pinpoint() with facade field/location/function and shapes-only fallback', async () => {
  assert.notEqual(pinpoint, legacyPinpoint, 'pinpoint exported by js/pinpoint.js must be the facade version');

  const fields = new FieldIndex({
    classes: [{
      name: 'Player',
      addr: 1n,
      superName: null,
      instanceSize: 0x40,
      ivars: [{ name: '_hp', offset: 0x8, size: 4, type: INT4 }],
      properties: [],
      methods: [],
      classMethods: [],
    }],
  });

  const fieldRes = await pinpoint({ goal: parseGoal('hp'), fields, limit: 0 });
  assert.equal(fieldRes.field.priorStableAcrossVerification, true, 'facade pinpoint() delegates to facade pinpointField()');
  assert.deepEqual(fieldRes.field.candidates, [], 'facade pinpoint() respects resultLimit(0)');

  // Shapes-only fallback (no fields, empty ranked, non-empty shapes)
  const shapesOnlyRes = await pinpoint({
    goal: makeGoal('hp'),
    fields: null,
    ranked: [],
    shapes: makeShapes([0x20]),
  });
  assert.equal(shapesOnlyRes.field.kind, 'location', 'facade pinpoint() falls back to pinpointLocation when shapes exist without ranked');
  assert.ok(shapesOnlyRes.field.top, 'shapes-only fallback produces a top location candidate');

  const legacyShapesOnlyRes = await legacyPinpoint({
    goal: makeGoal('hp'),
    fields: null,
    ranked: [],
    shapes: makeShapes([0x20]),
  });
  assert.equal(legacyShapesOnlyRes.field.kind, 'location', 'legacy pinpoint() stays synchronized on shapes-only fallback');
});

// ── T5-P1-4: Object.prototype key collision defense across all Track 5 modules ──
test('T5-P1-4: Object.prototype property names do not collide or throw across goals, goalc, evidence, rank, pinpoint', async () => {
  const protoKeys = ['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__'];

  for (const key of protoKeys) {
    assert.equal(reasonKind(key), 'inference');
    assert.equal(fieldVocab(key), null);
    assert.equal(evidenceInfo(key), null);
    assert.equal(isIdentifying(key), false);
    assert.equal(evidenceFamily(key), FAMILY.CONTEXT);
    assert.equal(evidenceKind(key), 'inference');
    assert.equal(groupOf({ code: key, family: key }), GROUP.METADATA);

    const ev = evidence(key);
    assert.equal(ev.lr, 1);
    assert.equal(ev.family, FAMILY.CONTEXT);
    assert.equal(ev.kind, 'inference');
    assert.equal(ev.id, false);

    const fakeGoal = { id: key, text: key, strong: [], weak: [], extraTerms: [], expects: {} };
    assert.equal(typeFits(fakeGoal, INT4), 'unknown');
    assert.doesNotThrow(() => matchField(fakeGoal, '_hp'));
    assert.doesNotThrow(() => compileGoal(key));
  }

  // pinpointField and pinpointFunction with proto goal id / proto reason code
  const fields = new FieldIndex({
    classes: [{
      name: 'GameState',
      addr: 1n,
      superName: null,
      instanceSize: 0x40,
      ivars: [{ name: '_hp', offset: 0x8, size: 4, type: INT4 }],
      properties: [],
      methods: [],
      classMethods: [],
    }],
  });
  const pf = await pinpointField({
    goal: { id: 'toString', text: 'hp', strong: [/\bhp\b/i], weak: [], extraTerms: [], expects: {} },
    fields,
  });
  assert.equal(pf.kind, 'field');

  const pfn = await pinpointFunction({
    goal: { id: 'constructor', text: 'hp', strong: [/\bhp\b/i], weak: [], extraTerms: [], expects: {} },
    ranked: [{ addr: BASE, name: 'updateHp', reasons: [{ code: 'constructor', points: 25 }] }],
  });
  assert.equal(pfn.kind, 'function');
  assert.equal(pfn.candidates[0].evidence.length, 0, 'prototype reason code must be ignored');
});

// ── T5-P1-5 & T5-P2-5: AbortSignal/isCancelled composition, guardedAnalyze, batchedScanAccess ──
test('T5-P1-5: AbortSignal composes into isCancelled and skips analyze/scanAccess/verifyShapes', async () => {
  const ac = new AbortController();
  ac.abort('user-stop');

  let analyzeCalls = 0;
  let scanCalls = 0;
  const fields = new FieldIndex({
    classes: [{
      name: 'Hero',
      addr: 1n,
      superName: null,
      instanceSize: 0x40,
      ivars: [{ name: '_hp', offset: 0x8, size: 4, type: INT4 }],
      properties: [],
      methods: [{ sel: 'hp', addr: BASE }],
      classMethods: [],
    }],
  });

  const resField = await pinpointField({
    goal: parseGoal('hp'),
    fields,
    signal: ac.signal,
    analyze: async () => { analyzeCalls++; return null; },
    scanAccess: async () => { scanCalls++; return new Map(); },
  });
  assert.equal(analyzeCalls, 0, 'pre-aborted signal must prevent analyze calls in pinpointField');
  assert.equal(scanCalls, 0, 'pre-aborted signal must prevent scanAccess calls in pinpointField');
  assert.equal(resField.checked, 0);

  const resLoc = await pinpointLocation({
    goal: makeGoal('hp'),
    shapes: makeShapes([0x20]),
    signal: ac.signal,
    program: { functionRange: () => ({ start: BASE, end: BASE + 0x20n }), functionStartOf: () => BASE },
    analyze: async () => { analyzeCalls++; return null; },
    scanAccess: async () => { scanCalls++; return new Map(); },
  });
  assert.equal(analyzeCalls, 0, 'pre-aborted signal must prevent verifyShapes analyze calls');
  assert.equal(scanCalls, 0, 'pre-aborted signal must prevent scanAccess calls in pinpointLocation');
  assert.equal(resLoc.kind, 'location');
});

test('T5-P2-5: batchedScanAccess handles supplemental missing offsets, non-poisoning abort, failure preservation, and bad offsets', async () => {
  const shapes = makeShapes([0x20]);
  const program = { functionRange: () => ({ start: BASE, end: BASE + 0x20n }), functionStartOf: () => BASE };
  const fieldsForOffset = (off) => new FieldIndex({
    classes: [{
      name: 'Hero',
      addr: 1n,
      superName: null,
      instanceSize: 0x100,
      ivars: [{ name: '_hp', offset: off, size: 4, type: INT4 }],
      properties: [],
      methods: [],
      classMethods: [],
    }],
  });

  // 1. Supplemental scan for missing offset + 0-hit caching
  const scannedBatches = [];
  const scanAccess = async (requested) => {
    scannedBatches.push(requested.map((r) => Number(r.offset)));
    const out = new Map();
    for (const r of requested) {
      if (Number(r.offset) === 0x20) {
        out.set(BigInt(r.offset).toString(), [{ addr: BASE + 4n, kind: 'store', size: 4 }]);
      }
      // 0x60 intentionally omitted (0 hits) to test empty [] fill
    }
    return out;
  };

  // First call scans 0x20 (from shapes)
  const r1 = await pinpointField({
    goal: parseGoal('hp'),
    fields: fieldsForOffset(0x20),
    shapes,
    program,
    scanAccess,
  });
  assert.equal(r1.changeSites.length, 1);
  assert.equal(scannedBatches.length, 1);

  // Second call requests 0x60 (not in initial shapes) -> supplemental scan for [0x60] only
  const r2 = await pinpointField({
    goal: parseGoal('hp'),
    fields: fieldsForOffset(0x60),
    shapes,
    program,
    scanAccess,
  });
  assert.equal(r2.changeSites.length, 0);
  assert.equal(scannedBatches.length, 2, 'missing offset 0x60 must trigger a supplemental scan');
  assert.deepEqual(scannedBatches[1], [0x60]);

  // Third call requests 0x60 again -> cached as [], no rescan
  await pinpointField({
    goal: parseGoal('hp'),
    fields: fieldsForOffset(0x60),
    shapes,
    program,
    scanAccess,
  });
  assert.equal(scannedBatches.length, 2, '0-hit scanned offset must be cached without rescanning');

  // 2. Aborted first waiter must NOT poison state.failed for a subsequent non-cancelled waiter
  const shapes2 = makeShapes([0x20]);
  let attempts = 0;
  const abortableScan = (_req, { signal }) => {
    attempts++;
    return new Promise((resolve, reject) => {
      if (attempts === 1) {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      } else {
        resolve(new Map([['32', [{ addr: BASE + 8n, kind: 'store', size: 4 }]]]));
      }
    });
  };
  const ac1 = new AbortController();
  const p1 = pinpointField({
    goal: parseGoal('hp'),
    fields: fieldsForOffset(0x20),
    shapes: shapes2,
    program,
    signal: ac1.signal,
    scanAccess: abortableScan,
  });
  setTimeout(() => ac1.abort('cancel-waiter-1'), 10);
  await p1;

  const p2 = await pinpointField({
    goal: parseGoal('hp'),
    fields: fieldsForOffset(0x20),
    shapes: shapes2,
    program,
    scanAccess: abortableScan,
  });
  assert.equal(attempts, 2, 'second non-cancelled caller must retry after first caller aborted');
  assert.equal(p2.changeSites.length, 1, 'retry after abort succeeds and returns sites');

  // 3. Supplemental failure sets state.failed=true while preserving previously fetched groups
  const shapes3 = makeShapes([0x20]);
  let supCalls = 0;
  const failOnSecondScan = async (req) => {
    supCalls++;
    if (supCalls === 1) {
      return new Map([['32', [{ addr: BASE + 12n, kind: 'store', size: 4 }]]]);
    }
    throw new Error('worker failed on supplemental scan');
  };
  const okFirst = await pinpointField({
    goal: parseGoal('hp'),
    fields: fieldsForOffset(0x20),
    shapes: shapes3,
    program,
    scanAccess: failOnSecondScan,
  });
  assert.equal(okFirst.changeSites.length, 1);

  await pinpointField({
    goal: parseGoal('hp'),
    fields: fieldsForOffset(0x80),
    shapes: shapes3,
    program,
    scanAccess: failOnSecondScan,
  });
  assert.equal(supCalls, 2);

  // Subsequent call for already-cached 0x20 still returns its cached sites without calling worker again
  const stillCached = await pinpointField({
    goal: parseGoal('hp'),
    fields: fieldsForOffset(0x20),
    shapes: shapes3,
    program,
    scanAccess: failOnSecondScan,
  });
  assert.equal(supCalls, 2, 'failed burst must not hammer worker again');
  assert.equal(stillCached.changeSites.length, 1, 'previously scanned groups remain available after supplemental failure');
});

// ── T5-P1-6: compileGoal() aligned with parseGoal() (avoid & hit >= 2) ──
test('T5-P1-6: compileGoal() aligns with parseGoal() on avoid spans and hit >= 2 threshold', () => {
  const hc = compileGoal('healthCheck');
  assert.equal(hc.goal.id, 'free');
  assert.equal(hc.entity.goal, null, 'avoided healthCheck must not map to hp');

  const fr = compileGoal('frameRate');
  assert.equal(fr.goal.id, 'free');
  assert.equal(fr.entity.goal, null, 'avoided frameRate must not map to gacha');

  const weakOnly = compileGoal('price');
  assert.equal(weakOnly.goal.id, 'free');
  assert.equal(weakOnly.entity.goal, null, 'single weak match (hit=1 < 2) must not map to preset goal');

  const hp = compileGoal('HPが増える');
  assert.equal(hp.goal.id, 'hp');
  assert.equal(hp.entity.goal, 'hp');

  const xp = compileGoal('戦闘終了時にXPが増える場所');
  assert.equal(xp.entity.goal, 'level', 'ENTITY_EXTRA still resolves XP to level');
});

// ── T5-P2-1: symbols.renames BigInt / hex / decimal key normalization ──
test('T5-P2-1: rankCandidates normalizes BigInt, hex string, and decimal keys in symbols.renames', () => {
  const goal = makeGoal('hp');
  const a1 = 0x1000n;
  const a2 = 0x2000n;
  const a3 = 0x3000n;
  const renames = new Map([
    [a1, 'updatePlayerHealth'],        // BigInt key overriding old non-matching symbol
    ['0x2000', 'healCharacterHp'],     // Hex string key overriding old non-matching symbol
    [a3.toString(), 'boostHealthValue'],   // Decimal string key (standalone)
  ]);

  const symbols = {
    symbolCount: 2,
    functionCount: 3,
    addrs: [a1, a2],
    names: ['sub_1000', 'sub_2000'],
    renames,
    nameAt: (a) => (a === a1 ? 'sub_1000' : a === a2 ? 'sub_2000' : null),
    functionStartAt: (a) => a,
  };

  const res = rankCandidates({ goal, strings: [], program: null, symbols, limit: 20 });
  const byAddr = new Map(res.candidates.map((c) => [c.addr, c]));
  assert.equal(byAddr.get(a1)?.name, 'updatePlayerHealth', 'BigInt rename key must resolve');
  assert.equal(byAddr.get(a2)?.name, 'healCharacterHp', 'hex string rename key must resolve');
  assert.equal(byAddr.get(a3)?.name, 'boostHealthValue', 'decimal string rename key must resolve');
});

// ── T5-P2-2: classesReferencingGoalStrings uses UTF-8 byte length ──
test('T5-P2-2: classesReferencingGoalStrings passes UTF-8 byte span (or s.byteLength) to functionsReferencing', async () => {
  const observedSpans = [];
  const fields = new FieldIndex({
    classes: [{
      name: 'BattleUnit',
      addr: 1n,
      superName: null,
      instanceSize: 0x40,
      ivars: [{ name: '_hp', offset: 0x8, size: 4, type: INT4 }],
      properties: [],
      methods: [{ sel: 'takeDamage', addr: BASE }],
      classMethods: [],
    }],
  });
  const program = {
    functionsReferencing: (_addr, span) => {
      observedSpans.push(span);
      return [{ addr: BASE, site: BASE + 4n, kind: 'adrp-add' }];
    },
  };
  const strings = [
    { addr: 0x5000n, text: '体力が減る' }, // 5 UTF-16 code units, 15 UTF-8 bytes
    { addr: 0x6000n, text: '体力回復', byteLength: 24 },
  ];

  await pinpointField({
    goal: makeGoal('hp'),
    fields,
    program,
    strings,
  });

  assert.ok(observedSpans.includes(15n), `expected UTF-8 byte span 15n, got ${observedSpans.map(String)}`);
  assert.ok(observedSpans.includes(24n), `expected explicit byteLength 24n, got ${observedSpans.map(String)}`);
});

// ── T5-P2-3: resultLimit(value, fallback) canonical contract across all pinpoint entrypoints ──
test('T5-P2-3: resultLimit honors explicit 0 and falls back on malformed values across facade & legacy', async () => {
  const fields = new FieldIndex({
    classes: [{
      name: 'Hero',
      addr: 1n,
      superName: null,
      instanceSize: 0x40,
      ivars: [
        { name: '_hp', offset: 0x8, size: 4, type: INT4 },
        { name: '_maxHp', offset: 0xc, size: 4, type: INT4 },
      ],
      properties: [],
      methods: [],
      classMethods: [],
    }],
  });
  const shapes = makeShapes([0x20, 0x24]);
  const ranked = [
    { addr: BASE, name: 'updateHp', reasons: [{ code: 'name-match', points: 25 }] },
    { addr: BASE + 0x40n, name: 'healHp', reasons: [{ code: 'name-match', points: 20 }] },
  ];

  for (const fn of [pinpointField, legacyPinpointField]) {
    const z = await fn({ goal: makeGoal('hp'), fields, limit: 0 });
    assert.equal(z.candidates.length, 0, 'limit: 0 must return 0 candidates');
    const neg = await fn({ goal: makeGoal('hp'), fields, limit: -1 });
    assert.equal(neg.candidates.length, 2, 'negative limit must fall back to default');
    const one = await fn({ goal: makeGoal('hp'), fields, limit: 1 });
    assert.equal(one.candidates.length, 1, 'positive integer limit must be respected');
  }

  for (const fn of [pinpointLocation, legacyPinpointLocation]) {
    const z = await fn({ goal: makeGoal('hp'), shapes, limit: 0 });
    assert.equal(z.candidates.length, 0, 'location limit: 0 must return 0 candidates');
    const bad = await fn({ goal: makeGoal('hp'), shapes, limit: NaN });
    assert.equal(bad.candidates.length, 2, 'location NaN limit must fall back to default');
  }

  for (const fn of [pinpointFunction, legacyPinpointFunction]) {
    const z = await fn({ goal: makeGoal('hp'), ranked, limit: 0 });
    assert.equal(z.candidates.length, 0, 'function limit: 0 must return 0 candidates');
    const frac = await fn({ goal: makeGoal('hp'), ranked, limit: 1.5 });
    assert.equal(frac.candidates.length, 2, 'function non-integer limit must fall back to default');
  }
});

// ── T5-P2-4: wordSequenceMatches scans all occurrences past avoid spans ──
test('T5-P2-4: matchField scans all word sequence occurrences when earlier occurrence is in an avoid span', () => {
  const goal = parseGoal('health');
  // "_healthCheckHealth" -> norm = "health check health"
  // "health check" is in hp.avoid (span [0, 12]), second "health" at index 13 is unblocked!
  const hit = matchField(goal, '_healthCheckHealth');
  assert.ok(hit, 'second unblocked occurrence of "health" must match');
  assert.equal(hit.literal, true, 'must match as literal sequence on the unblocked occurrence');
  assert.equal(hit.sequence, true);

  // Purely avoided name still does not match
  const avoided = matchField(goal, '_healthCheck');
  assert.equal(avoided, null, 'purely avoided field name must stay rejected');
});

// ── T5-P2-6: verifyFormula restricts movz/ccmp/ccmn to maxImmIdx=1 and skips movn ──
test('T5-P2-6: verifyFormula ignores movz shift, ccmp/ccmn nzcv, and movn inverted immediates', async () => {
  const goal = { ...makeGoal('damage'), expects: { numeric: true } };
  const makeCand = () => [{
    addr: BASE,
    name: 'calcDamage',
    reasons: [{ code: 'string-ref', points: 20 }],
    strings: [{ text: 'Damage = base * 16 + 12 + 100', users: 1, score: 1 }],
  }];

  const runWithInsns = async (instructions) => pinpointFunction({
    goal,
    ranked: makeCand(),
    functionCount: 1000,
    program: { functionRange: () => ({ start: BASE, end: BASE + 0x20n }) },
    analyze: async () => ({ instructions }),
  });

  // 1. movz shift operand (#16 at idx 2) must NOT match wanted 16
  const movzShiftOnly = await runWithInsns([
    { mnemonic: 'movz', ops: [{ k: 'reg', cls: 'gp', num: 0 }, { k: 'imm', value: 1 }, { k: 'imm', value: 16 }] },
  ]);
  assert.equal(
    movzShiftOnly.top.evidence.some((e) => e.code === 'fn-formula-verified'),
    false,
    'movz shift operand at idx 2 must not trigger fn-formula-verified'
  );

  // 2. movz primary imm (#100 at idx 1) MUST still match wanted 100
  const movzPrimary = await runWithInsns([
    { mnemonic: 'movz', ops: [{ k: 'reg', cls: 'gp', num: 0 }, { k: 'imm', value: 100 }, { k: 'imm', value: 16 }] },
  ]);
  assert.equal(
    movzPrimary.top.evidence.some((e) => e.code === 'fn-formula-verified'),
    true,
    'movz primary immediate at idx 1 should still verify'
  );

  // 3. ccmp/ccmn #nzcv operand (#12 at idx 2) must NOT match wanted 12
  const ccmpNzcvOnly = await runWithInsns([
    { mnemonic: 'ccmp', ops: [{ k: 'reg', cls: 'gp', num: 8 }, { k: 'imm', value: 5 }, { k: 'imm', value: 12 }] },
    { mnemonic: 'ccmn', ops: [{ k: 'reg', cls: 'gp', num: 8 }, { k: 'imm', value: 5 }, { k: 'imm', value: 12 }] },
  ]);
  assert.equal(
    ccmpNzcvOnly.top.evidence.some((e) => e.code === 'fn-formula-verified'),
    false,
    'ccmp/ccmn #nzcv operand at idx 2 must not trigger fn-formula-verified'
  );

  // 4. ccmp primary imm (#12 at idx 1) MUST still match wanted 12
  const ccmpPrimary = await runWithInsns([
    { mnemonic: 'ccmp', ops: [{ k: 'reg', cls: 'gp', num: 8 }, { k: 'imm', value: 12 }, { k: 'imm', value: 4 }] },
  ]);
  assert.equal(
    ccmpPrimary.top.evidence.some((e) => e.code === 'fn-formula-verified'),
    true,
    'ccmp primary immediate at idx 1 should still verify'
  );

  // 5. movn (#100 is bitwise inverted ~100) must be skipped completely
  const movnOnly = await runWithInsns([
    { mnemonic: 'movn', ops: [{ k: 'reg', cls: 'gp', num: 0 }, { k: 'imm', value: 100 }] },
  ]);
  assert.equal(
    movnOnly.top.evidence.some((e) => e.code === 'fn-formula-verified'),
    false,
    'movn inverted immediate must not trigger fn-formula-verified'
  );
});
