import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EVIDENCE,
  FAMILY,
  evidence,
  exclusiveLR,
  fuse,
} from '../js/evidence.js';
import { compileGoal } from '../js/goalc.js';
import { goalFromPreset, parseGoal } from '../js/goals.js';
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
  pinpointLocation as legacyPinpointLocation,
} from '../js/pinpoint-legacy.js';

const INT4 = { kind: 'int', bytes: 4, signed: true, enc: 'i' };
const BASE = 0x100000000n;

function makeShapes(entries) {
  const n = entries.length;
  return foldShapes({
    count: n,
    capped: false,
    disp: Int32Array.from(entries.map((e) => e.offset)),
    size: Uint8Array.from(entries.map((e) => e.size ?? 4)),
    flags: Uint8Array.from(entries.map((e) => e.flags ?? (SHAPE.DECREASE | SHAPE.CROSS | SHAPE.CLAMP_ZERO))),
    amtKind: Uint8Array.from(entries.map(() => AMOUNT.FIELD)),
    amtDisp: Int32Array.from(entries.map(() => 0x30)),
    addr: BigUint64Array.from(entries.map((e, i) => e.addr ?? (BASE + BigInt((i + 1) * 0x20)))),
    span: Int32Array.from(entries.map((e) => e.span ?? 0x100)),
    amtSize: Uint8Array.from(entries.map(() => 4)),
    amtSpan: Int32Array.from(entries.map(() => 0x100)),
  });
}

// ── Fix 1 [P1]: High-LR single evidence not silently truncated by FAMILY_CAP ──
test('W1-T5-1: FAMILY_CAP preserves role-verb-selector(80), role-accessor-metadata(70), role-accessor-match(80) and separates field-name-asked from contains(58)', () => {
  const asked = fuse([evidence('field-name-asked')], { candidates: 200 });
  const askedItem = asked.items.find((it) => it.code === 'field-name-asked');
  assert.ok(Math.abs(askedItem.applied - Math.log(120)) < 1e-12, 'field-name-asked reaches NAME cap of 120');

  const contains = fuse([evidence('field-name-contains')], { candidates: 200 });
  const containsItem = contains.items.find((it) => it.code === 'field-name-contains');
  assert.ok(askedItem.applied > containsItem.applied + Math.log(2), 'asked stays >2x stronger than contains(58)');

  const accMeta = fuse([evidence('role-accessor-metadata')], { candidates: 200 });
  const accMetaItem = accMeta.items.find((it) => it.code === 'role-accessor-metadata');
  assert.ok(Math.abs(accMetaItem.applied - Math.log(70)) < 1e-12, 'role-accessor-metadata keeps full ln(70)');

  const accMatch = fuse([evidence('role-accessor-match')], { candidates: 200 });
  const accMatchItem = accMatch.items.find((it) => it.code === 'role-accessor-match');
  assert.ok(Math.abs(accMatchItem.applied - Math.log(80)) < 1e-12, 'role-accessor-match keeps full ln(80)');

  // role-verb-selector is non-identifying (corroborating); with strong id (>= ln(10)) scale = 1
  const verbSel = fuse([evidence('field-name-asked'), evidence('role-verb-selector')], { candidates: 200 });
  const verbSelItem = verbSel.items.find((it) => it.code === 'role-verb-selector');
  assert.ok(Math.abs(verbSelItem.applied - Math.log(80)) < 1e-12, 'role-verb-selector keeps full ln(80) instead of truncating at 30');

  // Guardrails: stacking NAME evidence stays bounded by FAMILY_CAP[NAME] = 120
  const stackedOnAsked = fuse([
    evidence('field-name-asked'),
    evidence('field-name-contains'),
    evidence('field-name-exact'),
    evidence('property-name'),
  ], { candidates: 200 });
  assert.ok(Math.abs(stackedOnAsked.byFamily[FAMILY.NAME] - Math.log(120)) < 1e-12, 'NAME stacking stays capped at 120');

  // Guardrails: custom LR override cannot exceed FAMILY_CAP
  const inflatedType = fuse([evidence('field-name-asked'), evidence('type-declared', 1, {}, 100)], { candidates: 200 });
  assert.ok(Math.abs(inflatedType.byFamily[FAMILY.TYPE] - Math.log(6)) < 1e-12, 'custom LR on type-declared still caps at FAMILY_CAP[TYPE]=6');
});

// ── Fix 2 [P1]: exclusiveLR() and pinpointFunction guard users <= 0 ──
test('W1-T5-2: exclusiveLR returns 0 when total > 0 and users <= 0, and pinpointFunction skips users <= 0 strings', async () => {
  assert.equal(exclusiveLR(1000, 0, 1, 'damage %d'), 0);
  assert.equal(exclusiveLR(1_000_000, 0, 1, 'damage %d'), 0);
  assert.equal(exclusiveLR(1000, -0, 1, 'damage %d'), 0);
  assert.equal(exclusiveLR(1000, -1, 1, 'damage %d'), 0);
  // Existing (0, 0) legacy boundary preserved
  assert.equal(exclusiveLR(0, 0, 1, 'damage %d'), 1);
  // Valid users === 1 still computes normal exclusive LR
  assert.equal(exclusiveLR(1000, 1, 1, 'damage %d'), 250);

  const resZeroOnly = await pinpointFunction({
    goal: goalFromPreset('damage'),
    functionCount: 100_000,
    ranked: [{
      addr: BASE,
      name: 'sub_1000',
      reasons: [{ code: 'string-ref', points: 20 }],
      strings: [{ text: 'Damage dealt: %d', users: 0, score: 1 }],
    }],
  });
  assert.equal(
    resZeroOnly.candidates[0].evidence.some((e) => e.code === 'fn-string-exclusive'),
    false,
    'users === 0 must not emit fn-string-exclusive',
  );

  // A users: 0 entry must not poison seenText and block a valid users: 1 entry with the same text
  const resZeroThenOne = await pinpointFunction({
    goal: goalFromPreset('damage'),
    functionCount: 1000,
    ranked: [{
      addr: BASE,
      name: 'sub_1000',
      reasons: [{ code: 'string-ref', points: 20 }],
      strings: [
        { text: 'Damage dealt: %d', users: 0, score: 1 },
        { text: 'Damage dealt: %d', users: 1, score: 1 },
      ],
    }],
  });
  assert.equal(
    resZeroThenOne.candidates[0].evidence.some((e) => e.code === 'fn-string-exclusive'),
    true,
    'valid users === 1 entry after users === 0 must still be accepted',
  );
});

// ── Fix 3 [P1]: compileGoal() reflects ENTITY_EXTRA entityGoal, entityTerms, and expects into query.goal ──
test('W1-T5-3: compileGoal reflects ENTITY_EXTRA entityGoal, entityTerms, and expects into query.goal', () => {
  const xp = compileGoal('戦闘終了時にXPが増える場所');
  assert.equal(xp.entity.goal, 'level');
  assert.equal(xp.goal.id, 'level', 'query.goal must resolve to preset level instead of free');
  assert.equal(xp.goal.free, false);
  assert.equal(xp.goal.expects.numeric, true);
  assert.equal(xp.goal.expects.store, true);
  assert.equal(xp.goal.expects.compare, true);
  const xpWords = new Set(xp.goal.extraTerms.map((t) => t.word.toLowerCase()));
  assert.ok(xpWords.has('xp') && xpWords.has('exp') && xpWords.has('experience'), 'entityTerms merged into query.goal.extraTerms');

  const rarity = compileGoal('レア度を決める場所');
  assert.equal(rarity.entity.goal, 'gacha');
  assert.equal(rarity.goal.id, 'gacha');
  assert.equal(rarity.goal.free, false);
  assert.equal(rarity.goal.expects.call, true);
  assert.equal(rarity.goal.expects.compare, true);
  assert.equal(rarity.goal.expects.store, true);

  const stock = compileGoal('所持数が増える');
  assert.equal(stock.entity.goal, 'item');
  assert.equal(stock.goal.id, 'item');
  assert.equal(stock.goal.free, false);
  assert.equal(stock.goal.expects.numeric, true);
  assert.equal(stock.goal.expects.store, true);

  // ENTITY_EXTRA with goal: null still reflects entityTerms and action expects
  const cd = compileGoal('クールダウンが減る');
  assert.equal(cd.entity.goal, null);
  assert.equal(cd.goal.id, 'free');
  assert.equal(cd.goal.free, true);
  assert.equal(cd.goal.expects.numeric, true);
  assert.equal(cd.goal.expects.store, true);
  assert.equal(cd.goal.expects.compare, true);
  const cdWords = new Set(cd.goal.extraTerms.map((t) => t.word.toLowerCase()));
  assert.ok(cdWords.has('cooldown') && cdWords.has('recast') && cdWords.has('interval'));

  // Empty text stays null
  assert.equal(compileGoal('').goal, null);
});

// ── Fix 4 [P2]: deferAccessScan / cancel preserves shape-derived sites & siteCount; real 0-hit scan sets 0 ──
test('W1-T5-4: pinpointLocation preserves shape-derived sites/siteCount on deferAccessScan and cancel, but applies real 0-hit scan', async () => {
  const shapes = makeShapes([
    { offset: 0x20, size: 4, addr: BASE + 0x10n },
    { offset: 0x20, size: 4, addr: BASE + 0x20n },
    { offset: 0x40, size: 4, addr: BASE + 0x30n },
    { offset: 0x40, size: 4, addr: BASE + 0x40n },
  ]);
  const program = {
    functionRange: (a) => ({ start: a & ~0xfffn, end: (a & ~0xfffn) + 0x100n }),
    functionStartOf: (a) => a & ~0xfffn,
  };

  // 1. deferAccessScan: slow scan is deferred; both top and non-top shape candidates retain sites & siteCount
  let releaseDeferred = null;
  const deferredScan = () => new Promise((resolve) => {
    releaseDeferred = () => resolve(new Map());
  });
  const deferredRes = await pinpointLocation({
    goal: goalFromPreset('hp'),
    shapes,
    program,
    deferAccessScan: true,
    scanAccess: deferredScan,
  });
  assert.ok(deferredRes.candidates.length >= 2);
  for (const c of deferredRes.candidates) {
    assert.ok(c.siteCount > 0, `deferred scan must preserve shape siteCount for offset ${c.offset}`);
    assert.ok(c.sites.length > 0, `deferred scan must preserve shape sites for offset ${c.offset}`);
  }
  releaseDeferred?.();

  // 2. Mid-scan abort preserves shape-derived sites & siteCount
  const shapes2 = makeShapes([
    { offset: 0x20, size: 4, addr: BASE + 0x10n },
    { offset: 0x40, size: 4, addr: BASE + 0x30n },
  ]);
  const ac = new AbortController();
  const abortingScan = (_req, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    setTimeout(() => ac.abort('user-cancel'), 5);
  });
  const abortedRes = await pinpointLocation({
    goal: goalFromPreset('hp'),
    shapes: shapes2,
    program,
    signal: ac.signal,
    scanAccess: abortingScan,
  });
  assert.ok(abortedRes.candidates.length >= 2);
  for (const c of abortedRes.candidates) {
    assert.ok(c.siteCount > 0, `aborted scan must preserve shape siteCount for offset ${c.offset}`);
    assert.ok(c.sites.length > 0, `aborted scan must preserve shape sites for offset ${c.offset}`);
  }

  // 3. Real completed scan returning 0 hits for 0x40 sets siteCount=0, sites=[]
  const shapes3 = makeShapes([
    { offset: 0x20, size: 4, addr: BASE + 0x10n },
    { offset: 0x40, size: 4, addr: BASE + 0x30n },
  ]);
  const realZeroScan = async () => new Map([
    ['32', [{ addr: BASE + 0x100n, kind: 'store', size: 4 }]],
    // 64 (0x40) scanned with 0 hits
  ]);
  const realRes = await pinpointLocation({
    goal: goalFromPreset('hp'),
    shapes: shapes3,
    program,
    scanAccess: realZeroScan,
  });
  const c20 = realRes.candidates.find((c) => c.offset === 0x20n);
  const c40 = realRes.candidates.find((c) => c.offset === 0x40n);
  assert.equal(c20.siteCount, 1);
  assert.equal(c40.siteCount, 0, 'genuinely scanned 0-hit offset must record siteCount = 0');
  assert.deepEqual(c40.sites, [], 'genuinely scanned 0-hit offset must record empty sites');
});

// ── Fix 5 [P2]: pinpoint() inter-phase cancellation + non-batched scanAccess timeout/AbortSignal ──
test('W1-T5-5: pinpoint() stops between phases on cancel and non-batched scanAccess enforces timeout & AbortSignal', async () => {
  // 1. Inter-phase cancellation in facade pinpoint() and legacyPinpoint()
  for (const runPinpoint of [pinpoint, legacyPinpoint]) {
    let cancelFlag = false;
    let analyzeCalls = 0;
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
    const res = await runPinpoint({
      goal: parseGoal('hp'),
      fields,
      ranked: [{ addr: BASE + 0x100n, name: 'updateHp', reasons: [{ code: 'name-match', points: 25 }] }],
      program: { functionRange: (a) => ({ start: a, end: a + 0x20n }) },
      isCancelled: () => cancelFlag,
      analyze: async () => {
        analyzeCalls++;
        cancelFlag = true; // Cancel during pinpointField verification
        return null;
      },
    });
    assert.equal(res.function, null, 'cancelled pinpoint() must skip pinpointFunction phase');
    assert.equal(analyzeCalls, 1, 'no further analyze calls after cancellation');
  }

  // 2. Pre-aborted signal skips location fallback and function phase in pinpoint()
  const preAborted = new AbortController();
  preAborted.abort('already-cancelled');
  const preRes = await pinpoint({
    goal: goalFromPreset('hp'),
    fields: null,
    shapes: makeShapes([{ offset: 0x20, size: 4 }]),
    ranked: [{ addr: BASE, name: 'updateHp', reasons: [{ code: 'name-match', points: 25 }] }],
    signal: preAborted.signal,
  });
  assert.equal(preRes.field.kind, 'field', 'pre-aborted pinpoint() must not enter pinpointLocation fallback');
  assert.equal(preRes.function, null, 'pre-aborted pinpoint() must not enter pinpointFunction');

  // 3. Non-batched scanAccess (no shapes) propagates AbortSignal and enforces accessScanTimeoutMs + cancel()
  const fields = new FieldIndex({
    classes: [{
      name: 'Hero',
      addr: 1n,
      superName: null,
      instanceSize: 0x40,
      ivars: [{ name: '_hp', offset: 0x8, size: 4, type: INT4 }],
      properties: [],
      methods: [],
      classMethods: [],
    }],
  });
  let observedSignal = null;
  let cancelCalled = false;
  const hangingNonBatchedScan = (_req, opts) => {
    observedSignal = opts?.signal ?? null;
    const p = new Promise(() => {});
    p.cancel = () => { cancelCalled = true; };
    return p;
  };
  const t0 = Date.now();
  const timedOutRes = await pinpointField({
    goal: parseGoal('hp'),
    fields,
    accessScanTimeoutMs: 25,
    scanAccess: hangingNonBatchedScan,
  });
  assert.ok(Date.now() - t0 < 2000, 'non-batched scanAccess must time out promptly');
  assert.ok(observedSignal, 'non-batched scanAccess must receive AbortSignal');
  assert.equal(observedSignal.aborted, true, 'non-batched scanAccess signal must be aborted on timeout');
  assert.equal(cancelCalled, true, 'non-batched scanAccess must invoke operation.cancel() on timeout');
  assert.deepEqual(timedOutRes.changeSites, []);

  // 4. Non-batched scanAccess (forceAccessScan: true) propagates parent signal abort
  const parentAc = new AbortController();
  let childSignal = null;
  const abortableNonBatched = (_req, opts) => {
    childSignal = opts?.signal ?? null;
    setTimeout(() => parentAc.abort('stop-now'), 10);
    return new Promise((_resolve, reject) => {
      opts?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  };
  const locAborted = await pinpointLocation({
    goal: goalFromPreset('hp'),
    shapes: makeShapes([{ offset: 0x20, size: 4 }]),
    forceAccessScan: true,
    signal: parentAc.signal,
    scanAccess: abortableNonBatched,
  });
  assert.ok(childSignal?.aborted, 'parent AbortSignal must propagate to non-batched scanAccess');
  assert.ok(locAborted.top.siteCount > 0, 'aborted non-batched scanAccess preserves shape siteCount');
});

// ── Fix 6 [P2]: Same-offset different-size requests do not collide or overwrite each other ──
test('W1-T5-6: batchedScanAccess and pinpointLocation separate same-offset different-size requests', async () => {
  const fnA = BASE + 0x1000n;
  const fnB = BASE + 0x2000n;
  const fnC = BASE + 0x3000n;
  const program = {
    functionRange: (a) => ({ start: a, end: a + 0x40n }),
    functionStartOf: (a) => a & ~0xfffn,
  };
  const makeModel = (size, storeAddr) => ({
    instructions: [
      { address: storeAddr - 8n, mnemonic: 'ldr', memory: { kind: 'load', base: 'x0', disp: 0x20n, size, stack: false } },
      { address: storeAddr - 4n, mnemonic: 'sub', ops: [{ k: 'reg', cls: 'gp', num: 8 }, { k: 'reg', cls: 'gp', num: 8 }, { k: 'imm', value: 1 }] },
      { address: storeAddr, mnemonic: 'str', memory: { kind: 'store', base: 'x0', disp: 0x20n, size, stack: false } },
    ],
    loads: [],
    stores: [],
    updates: [],
    // Minimal model consumed by findValueUpdates: use two distinct base registers/identities via shapes
  });

  // Two distinct shape entries at the SAME offset (0x20) with different sizes (4 vs 2) and identities
  const shapes = new Map([
    ['idA@32', {
      offset: 0x20, size: 4, identity: 'UnitA', identityKnown: true,
      events: 2, inBigObject: 2, decreases: 2, increases: 0, clamped: 1, crossObject: 1, usedAsAmount: 0,
      sites: [{ addr: fnA + 4n }],
    }],
    ['idB@32', {
      offset: 0x20, size: 2, identity: 'UnitB', identityKnown: true,
      events: 2, inBigObject: 2, decreases: 2, increases: 0, clamped: 1, crossObject: 1, usedAsAmount: 0,
      sites: [{ addr: fnB + 4n }],
    }],
  ]);

  const mixedSizeScan = async () => new Map([
    ['32', [
      { addr: fnA + 4n, kind: 'store', size: 4 },
      { addr: fnB + 4n, kind: 'store', size: 4 },
      { addr: fnC + 4n, kind: 'store', size: 2 },
    ]],
  ]);

  // Batched path (pinpoint.js facade)
  const batchedRes = await pinpointLocation({
    goal: goalFromPreset('hp'),
    shapes,
    program,
    scanAccess: mixedSizeScan,
  });
  const b4 = batchedRes.candidates.find((c) => c.identity === 'UnitA');
  const b2 = batchedRes.candidates.find((c) => c.identity === 'UnitB');
  assert.ok(b4 && b2, 'both same-offset different-size candidates must be present');
  assert.equal(b4.siteCount, 2, '4-byte candidate must receive only the 2 four-byte sites');
  assert.equal(b2.siteCount, 1, '2-byte candidate must receive only the 1 two-byte site');

  // Direct legacy / non-batched path
  const legacyRes = await legacyPinpointLocation({
    goal: goalFromPreset('hp'),
    shapes,
    program,
    scanAccess: mixedSizeScan,
  });
  const l4 = legacyRes.candidates.find((c) => c.identity === 'UnitA');
  const l2 = legacyRes.candidates.find((c) => c.identity === 'UnitB');
  assert.equal(l4.siteCount, 2, 'legacy 4-byte candidate must receive only the 2 four-byte sites');
  assert.equal(l2.siteCount, 1, 'legacy 2-byte candidate must receive only the 1 two-byte site');

  // Keep makeModel reference clean
  assert.ok(makeModel(4, fnA + 8n).instructions.length === 3);
});

// ── Fix 7 [P1]: compileGoal() promotes existing expandTerms() entries to weight 1 for ENTITY_EXTRA tokens ──
test('W1-T5-7: compileGoal promotes ENTITY_EXTRA tokens from weight 0.6 to 1 for field-name-strong and fn-string-exclusive', async () => {
  const cases = [
    { query: 'XP increases', token: 'xp', fieldName: '_playerXp', str: '獲得XP: %d' },
    { query: 'cooldown decreases', token: 'cooldown', fieldName: '_skillCooldown', str: 'クールタイム cooldown: %d' },
    { query: 'rarity decides', token: 'rarity', fieldName: '_dropRarity', str: '排出 rarity: %d' },
    { query: 'ticket decreases', token: 'ticket', fieldName: '_eventTicket', str: '消費 ticket: %d' },
    { query: 'stock decreases', token: 'stock', fieldName: '_shopStock', str: '残り stock: %d' },
    { query: 'heart decreases', token: 'heart', fieldName: '_playerHeart', str: '残り heart: %d' },
  ];

  for (const c of cases) {
    const compiled = compileGoal(c.query);
    const matching = compiled.goal.extraTerms.filter((t) => t.word.toLowerCase() === c.token);
    assert.equal(matching.length, 1, `${c.query}: no duplicate extraTerms for ${c.token}`);
    assert.equal(matching[0].weight, 1, `${c.query}: ${c.token} must be promoted to weight 1`);

    const fields = new FieldIndex({
      classes: [{
        name: 'Player',
        addr: 1n,
        superName: null,
        instanceSize: 0x40,
        ivars: [{ name: c.fieldName, offset: 0x8, size: 4, type: INT4 }],
        properties: [],
        methods: [],
        classMethods: [],
      }],
    });
    const fieldRes = await pinpointField({ goal: compiled.goal, fields });
    assert.equal(
      fieldRes.top.evidence.some((e) => e.code === 'field-name-strong'),
      true,
      `${c.query}: ${c.fieldName} must emit field-name-strong`,
    );

    const fnRes = await pinpointFunction({
      goal: compiled.goal,
      functionCount: 1000,
      ranked: [{
        addr: BASE,
        name: 'sub_1000',
        reasons: [{ code: 'string-ref', points: 20 }],
        strings: [{ text: c.str, users: 1, score: 1 }],
      }],
    });
    assert.equal(
      fnRes.candidates[0].evidence.some((e) => e.code === 'fn-string-exclusive'),
      true,
      `${c.query}: "${c.str}" must pass EXCLUSIVE_MIN_SCORE and emit fn-string-exclusive`,
    );
  }
});
