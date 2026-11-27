import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pinpointField,
  pinpointFunction,
  pinpointLocation,
  pinpoint,
  pickMethodsToRead,
} from '../js/pinpoint-legacy.js';
import { goalFromPreset, parseGoal } from '../js/goals.js';
import { buildSemanticModel } from '../js/blocks.js';
import { AMOUNT, SHAPE, foldShapes } from '../js/shapes.js';
import { CxxMemberIndex } from '../js/analysis/cxx/member-index.js';
import { createCppReceiverEvidence, createCppMemberEvidence } from '../js/analysis/cxx/object-evidence.js';

const INT4 = { kind: 'int', bytes: 4, signed: true };
const PTR8 = { kind: 'pointer', bytes: 8 };
const BOOL1 = { kind: 'bool', bytes: 1 };
const BASE = 0x100000000n;

function modelOf(lines, base = BASE) {
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

function makeFields(classes) {
  const map = new Map();
  const byAddr = new Map();
  for (const c of classes) {
    const cls = {
      name: c.name,
      superName: c.superName || null,
      instanceSize: c.instanceSize || 64,
      ivars: c.ivars || [],
      methods: c.methods || [],
      source: c.source,
      classIdentity: c.classIdentity,
    };
    map.set(cls.name, cls);
    for (const m of cls.methods) {
      if (m.addr != null) {
        byAddr.set(m.addr.toString(), { className: cls.name, sel: m.sel, addr: m.addr });
      }
    }
  }
  return {
    classCount: map.size,
    classes: map,
    classInfo: (name) => map.get(name) || null,
    ownerOf: (addr) => (addr != null ? byAddr.get(addr.toString()) || null : null),
  };
}

function makeInsn(mnemonic, ops = [], extra = {}) {
  return {
    address: extra.address || BASE,
    row: extra.row ?? 0,
    mnemonic,
    ops,
    operands: extra.operands || '',
    reads: extra.reads || [],
    writes: extra.writes || [],
    memory: extra.memory || null,
  };
}

function reg(name, num, cls = 'gp', bits = 64) {
  return { k: 'reg', text: name, name, cls, num, bits };
}

function imm(value) {
  return { k: 'imm', value };
}

/* ── 1. verifyFormula ─────────────────────────────────────────────────── */

test('verifyFormula: skipped when !goal.expects?.numeric', async () => {
  const goal = goalFromPreset('login'); // expects.numeric is falsy
  const res = await pinpointFunction({
    goal,
    ranked: [{
      addr: 0x1000n,
      name: 'loginCheck',
      strings: [{ text: 'rate = %d * 100 / 50', addr: 0x2000n, users: 1, score: 1 }],
      reasons: [],
    }],
    analyze: async () => ({
      instructions: [makeInsn('mov', [reg('w0', 0, 'gp', 32), imm(100)])],
    }),
  });
  assert.ok(!res.top.evidence.some((e) => e.code === 'fn-formula-verified'));
});

test('verifyFormula: accepts real formula with arithmetic/compare/move imm and rejects non-formula strings & non-formula insns', async () => {
  const goal = goalFromPreset('damage'); // expects.numeric = true

  // Positive: Japanese formula string + arithmetic/compare immediate 100
  const pos = await pinpointFunction({
    goal,
    ranked: [{
      addr: 0x1000n,
      name: 'calcDamage',
      strings: [{ text: '攻撃力アップ:%d 基ダ×(100+%d+[コンボ:%d])÷100', addr: 0x2000n, users: 1, score: 1 }],
      reasons: [],
    }],
    analyze: async () => ({
      instructions: [
        makeInsn('add', [reg('w8', 8, 'gp', 32), reg('w8', 8, 'gp', 32), imm(100)]),
        makeInsn('cmp', [reg('w8', 8, 'gp', 32), imm(100)]),
      ],
    }),
  });
  assert.ok(pos.top.evidence.some((e) => e.code === 'fn-formula-verified' && e.detail.value === 100));

  // Negative strings: RTTI, int32_t/int64_t/s64p, asset path, [TAG] log, C++ sig, decimal fraction
  const badStrings = [
    '_ZN12BattleEngine10calcDamageEi',
    'int32_t int64_t s64p',
    'assets/stage_100.png',
    'ui/icon_%d_100.webp',
    '[BATTLE] damage = 100',
    'void Battle::calcDamage(int32_t x = 100)',
    'ratio = 1.50 + 10.25',
  ];
  for (const text of badStrings) {
    const neg = await pinpointFunction({
      goal,
      ranked: [{
        addr: 0x1000n,
        name: 'fn',
        strings: [{ text, addr: 0x2000n, users: 1, score: 1 }],
        reasons: [],
      }],
      analyze: async () => ({
        instructions: [
          makeInsn('mov', [reg('w0', 0, 'gp', 32), imm(100)]),
          makeInsn('mov', [reg('w1', 1, 'gp', 32), imm(32)]),
          makeInsn('mov', [reg('w2', 2, 'gp', 32), imm(64)]),
          makeInsn('mov', [reg('w3', 3, 'gp', 32), imm(50)]),
          makeInsn('mov', [reg('w4', 4, 'gp', 32), imm(25)]),
          makeInsn('mov', [reg('w5', 5, 'gp', 32), imm(12)]),
          makeInsn('mov', [reg('w6', 6, 'gp', 32), imm(10)]),
        ],
      }),
    });
    assert.ok(!neg.top.evidence.some((e) => e.code === 'fn-formula-verified'), `should reject non-formula string: ${text}`);
  }

  // Negative instructions: memory offset, stack adjustment, shift amount, adrp page add
  const negInsn = await pinpointFunction({
    goal,
    ranked: [{
      addr: 0x1000n,
      name: 'fn',
      strings: [{ text: 'dmg = atk * 100 / 16', addr: 0x2000n, users: 1, score: 1 }],
      reasons: [],
    }],
    analyze: async () => ({
      instructions: [
        makeInsn('ldr', [reg('w0', 0, 'gp', 32), imm(100)], { memory: { kind: 'load', base: 'x0', disp: 100n } }),
        makeInsn('sub', [reg('sp', 31, 'sp', 64), reg('sp', 31, 'sp', 64), imm(100)]),
        makeInsn('lsl', [reg('w0', 0, 'gp', 32), reg('w1', 1, 'gp', 32), imm(16)]),
        makeInsn('movk', [reg('w0', 0, 'gp', 32), imm(1), imm(16)]),
        makeInsn('adrp', [reg('x8', 8, 'gp', 64), imm(0x100000)]),
        makeInsn('add', [reg('x8', 8, 'gp', 64), reg('x8', 8, 'gp', 64), imm(100)]),
      ],
    }),
  });
  assert.ok(!negInsn.top.evidence.some((e) => e.code === 'fn-formula-verified'));
});

/* ── 2. pinpointFunction & verifyFunctionCandidate ────────────────────── */

test('pinpointFunction: calls-match/called-by-match mapping, vendor conflict suppresses fn-string-exclusive, fn-numeric dedup, Itanium leaf', async () => {
  const goal = goalFromPreset('hp');

  const res = await pinpointFunction({
    goal,
    functionCount: 2000,
    ranked: [
      {
        addr: 0x1000n,
        name: '_ZN6Player2hpEv',
        reasons: [
          { code: 'calls-match', points: 10, detail: { callee: 'foo' } },
          { code: 'called-by-match', points: 10, detail: { caller: 'bar' } },
          { code: 'numeric', points: 12, detail: {} },
        ],
        strings: [{ text: 'HP %d / 100', addr: 0x5000n, users: 1, score: 1 }],
      },
      {
        addr: 0x2000n,
        name: '-[GADRewardedAd hp]',
        vendor: { vendor: 'Google AdMob', kind: 'ads', confidence: 'high' },
        reasons: [{ code: 'vendor', points: -25, detail: { vendor: 'Google AdMob' } }],
        strings: [{ text: 'HP %d / 100', addr: 0x5000n, users: 1, score: 1 }],
      },
    ],
    analyze: async () => ({
      instructions: [
        makeInsn('mul', [reg('w0', 0, 'gp', 32), reg('w1', 1, 'gp', 32), reg('w2', 2, 'gp', 32)]),
      ],
    }),
  });

  const gameFn = res.candidates.find((c) => c.addr === 0x1000n);
  const sdkFn = res.candidates.find((c) => c.addr === 0x2000n);

  // calls-match -> fn-callee-match, called-by-match -> fn-caller-match
  const calleeEv = gameFn.evidence.find((e) => e.code === 'fn-callee-match');
  const callerEv = gameFn.evidence.find((e) => e.code === 'fn-caller-match');
  assert.equal(calleeEv?.detail?.callee, 'foo');
  assert.equal(callerEv?.detail?.caller, 'bar');

  // Itanium mangled name gets fn-name-exact via extractCallableLeaf
  assert.ok(gameFn.evidence.some((e) => e.code === 'fn-name-exact'));

  // No duplicate fn-numeric
  assert.equal(gameFn.evidence.filter((e) => e.code === 'fn-numeric').length, 1);

  // Vendor conflict suppresses fn-string-exclusive
  assert.ok(gameFn.evidence.some((e) => e.code === 'fn-string-exclusive'));
  assert.ok(!sdkFn.evidence.some((e) => e.code === 'fn-string-exclusive'));
});

test('verifyFunctionCandidate: owner class mismatch suppresses fn-writes-field/fn-touches-field', async () => {
  const goal = goalFromPreset('hp');
  const fields = makeFields([
    { name: 'Player', ivars: [{ name: '_hp', offset: 0x20, size: 4, type: INT4 }], methods: [{ sel: 'takeDamage:', addr: 0x1000n }] },
    { name: 'Enemy', ivars: [{ name: '_armor', offset: 0x20, size: 4, type: INT4 }], methods: [{ sel: 'takeDamage:', addr: 0x2000n }] },
  ]);
  const writeModel = modelOf([
    'ldr w8, [x0, #0x20]',
    'sub w8, w8, #1',
    'str w8, [x0, #0x20]',
    'ret',
  ]);

  const res = await pinpointFunction({
    goal,
    fields,
    field: { offset: 0x20, className: 'Player', plain: 'hp', name: '_hp' },
    ranked: [
      { addr: 0x1000n, name: '-[Player takeDamage:]', reasons: [] },
      { addr: 0x2000n, name: '-[Enemy takeDamage:]', reasons: [] },
    ],
    analyze: async () => writeModel,
  });

  const playerFn = res.candidates.find((c) => c.addr === 0x1000n);
  const enemyFn = res.candidates.find((c) => c.addr === 0x2000n);
  assert.ok(playerFn.evidence.some((e) => e.code === 'fn-writes-field'));
  assert.ok(!enemyFn.evidence.some((e) => e.code === 'fn-writes-field' || e.code === 'fn-touches-field'));
});

test('verifyFunctionCandidate: expects.numeric exact-anchored mul/div and pure add/sub filtering', async () => {
  const goal = goalFromPreset('damage');

  // Non-arithmetic instructions only (should NOT get fn-numeric)
  const nonArith = await pinpointFunction({
    goal,
    ranked: [{ addr: 0x1000n, name: 'prologueOnly', reasons: [] }],
    analyze: async () => ({
      instructions: [
        makeInsn('muls', [reg('w0', 0, 'gp', 32), reg('w1', 1, 'gp', 32)]), // not exact-anchored
        makeInsn('subs', [reg('xzr', 31, 'zr', 64), reg('x8', 8, 'gp', 64), imm(0)]), // cmp alias
        makeInsn('adds', [reg('wzr', 31, 'zr', 32), reg('w8', 8, 'gp', 32), imm(1)]), // cmn alias
        makeInsn('sub', [reg('sp', 31, 'sp', 64), reg('sp', 31, 'sp', 64), imm(0x40)]), // sp adjust
        makeInsn('add', [reg('x29', 29, 'gp', 64), reg('sp', 31, 'sp', 64), imm(0x10)]), // fp setup
        makeInsn('sub', [reg('fp', 29, 'gp', 64), reg('fp', 29, 'gp', 64), imm(0x10)]), // fp op
        makeInsn('adrp', [reg('x8', 8, 'gp', 64), imm(0x100000)]),
        makeInsn('mov', [reg('w9', 9, 'gp', 32), imm(1)]),
        makeInsn('add', [reg('x8', 8, 'gp', 64), reg('x8', 8, 'gp', 64), imm(0x240)]), // adrp page add
      ],
    }),
  });
  assert.ok(!nonArith.top.evidence.some((e) => e.code === 'fn-numeric'));

  // Pure arithmetic instructions (should get fn-numeric with exact count)
  const pureArith = await pinpointFunction({
    goal,
    ranked: [{ addr: 0x1000n, name: 'pureMath', reasons: [] }],
    analyze: async () => ({
      instructions: [
        makeInsn('add', [reg('w8', 8, 'gp', 32), reg('w8', 8, 'gp', 32), reg('w9', 9, 'gp', 32)]),
        makeInsn('sub', [reg('w0', 0, 'gp', 32), reg('w0', 0, 'gp', 32), imm(10)]),
        makeInsn('fadd', [reg('s0', 0, 'fp', 32), reg('s0', 0, 'fp', 32), reg('s1', 1, 'fp', 32)]),
        makeInsn('mul', [reg('w0', 0, 'gp', 32), reg('w0', 0, 'gp', 32), reg('w1', 1, 'gp', 32)]),
      ],
    }),
  });
  const numEv = pureArith.top.evidence.find((e) => e.code === 'fn-numeric');
  assert.ok(numEv);
  assert.equal(numEv.detail.n, 4);
});

test('pinpoint(): null-safe field.top?.field?.name when falling back to pinpointLocation', async () => {
  const goal = goalFromPreset('hp');
  const rmwModel = modelOf([
    'ldr w8, [x0, #0x20]',
    'sub w8, w8, #5',
    'cmp w8, #0',
    'str w8, [x0, #0x20]',
    'ret',
  ]);
  const res = await pinpoint({
    goal,
    fields: null,
    ranked: [{ addr: BASE, name: 'applyDamage', strings: [{ text: 'damage', users: 1, score: 1 }], reasons: [] }],
    analyze: async () => rmwModel,
  });
  assert.equal(res.field.kind, 'location');
  assert.ok(res.field.top);
  assert.ok(res.function);
});

/* ── 3. pinpointField & verifyCandidate ───────────────────────────────── */

test('pinpointField: propHit propagates to name evidence, askedByName, and siblings; narrowed matches universe', async () => {
  const goal = parseGoal('playerHealth');
  const otherIvars = Array.from({ length: 48 }, (_, i) => ({
    name: `_unrelated${i}`, offset: 0x100 + i * 4, size: 4, type: INT4,
  }));
  const fields = makeFields([
    {
      name: 'Hero',
      ivars: [
        { name: '_a1', offset: 0x10, size: 4, type: INT4, property: { name: 'playerHealth', type: INT4 } },
        { name: '_a2', offset: 0x14, size: 4, type: INT4, property: { name: 'maxPlayerHealth', type: INT4 } },
      ],
    },
    { name: 'Noise', ivars: otherIvars },
  ]);

  const res = await pinpointField({ goal, fields });
  assert.equal(res.top.field.name, '_a1');
  assert.equal(res.top.askedByName, true);
  assert.ok(res.top.evidence.some((e) => e.code === 'field-name-asked'));
  assert.ok(res.top.evidence.some((e) => e.code === 'sibling-fields'));
  // universe = 50, narrowed to 1 exact match -> priorCandidates = 1 -> prior = 1 / (1 + 40) = 1/41 (not 1/90)
  assert.ok(Math.abs(res.top.fusion.prior - (1 / 41)) < 1e-6, `expected narrowed prior 1/41, got ${res.top.fusion.prior}`);
});

test('pinpointField: no size-fits on conflict/pointer types and no unconditional access-verified on anonymous C++', async () => {
  const goal = goalFromPreset('hp');
  const cxxFields = new CxxMemberIndex();
  const receiver = createCppReceiverEvidence({
    functionId: 'fn_0x1000',
    functionAddress: 0x1000n,
    canonicalValueId: 'arg0',
    receiverRole: 'this',
    classIdentity: { kind: 'named', className: 'HealthManager' },
    nonStaticProof: { rule: 'vtable-slot', isStatic: false },
    abiBinding: { architecture: 'arm64', register: 'x0', argumentIndex: 0 },
    snapshotId: 'test-binary:0',
    completeness: 'complete',
  });
  cxxFields.publish({
    receiver,
    members: [createCppMemberEvidence({
      functionId: receiver.functionId,
      receiverDigest: receiver.digest,
      snapshotId: receiver.snapshotId,
      offsetBytes: 0x20n,
      sizeBytes: 4,
      category: 'int32',
      typeLabel: 'int32_t',
      rule: 'width-32',
      readCount: 3,
      writeCount: 2,
    })],
  });
  const fields = makeFields([
    {
      name: 'Player',
      ivars: [
        { name: '_hp', offset: 0x10, size: 4, type: INT4 },
        { name: '_hpPtr', offset: 0x18, size: 8, type: PTR8 },
        { name: '_hpFlag', offset: 0x20, size: 1, type: BOOL1 },
      ],
    },
  ]);

  const res = await pinpointField({ goal, fields, cxxFields, limit: 20 });
  const hpInt = res.candidates.find((c) => c.field.name === '_hp');
  const hpPtr = res.candidates.find((c) => c.field.name === '_hpPtr');
  const hpFlag = res.candidates.find((c) => c.field.name === '_hpFlag');
  const cxxCand = res.candidates.find((c) => c.source === 'cxx');

  assert.ok(hpInt.evidence.some((e) => e.code === 'size-fits'));
  assert.ok(!hpPtr.evidence.some((e) => e.code === 'size-fits'));
  assert.ok(!hpFlag.evidence.some((e) => e.code === 'size-fits'));
  assert.ok(cxxCand && cxxCand.anonymous);
  assert.ok(!cxxCand.evidence.some((e) => e.code === 'access-verified'));
});

test('findAccessors & verifyCandidate: explicit getter/setter priority, step 2 excludes accessors, no duplicate size-fits, pickMethodsToRead anchor', async () => {
  const goal = goalFromPreset('hp');
  const getterAddr = 0x1000n;
  const inferredAddr = 0x1010n;
  const mutatorAddr = 0x2000n;
  const analyzed = [];

  const fields = makeFields([
    {
      name: 'Player',
      ivars: [{
        name: '_hp', offset: 0x20, size: 4, type: INT4,
        property: { name: 'hp', getter: 'currentHp', setter: 'applyHp:', type: INT4 },
      }],
      methods: [
        { sel: 'hp', addr: inferredAddr },         // appears BEFORE explicit getter!
        { sel: 'currentHp', addr: getterAddr },    // explicit getter must win
        { sel: 'initWithCoder:', addr: 0x3000n },
        { sel: 'copyWithZone:', addr: 0x3010n },
        { sel: 'encodeWithCoder:', addr: 0x3020n },
        { sel: 'takeDamage:', addr: mutatorAddr },
      ],
    },
  ]);

  const getterModel = modelOf([
    'ldr w0, [x0, #0x20]',
    'ret',
  ], getterAddr);
  const mutatorModel = modelOf([
    'ldr w8, [x0, #0x20]',
    'sub w8, w8, w2',
    'str w8, [x0, #0x20]',
    'ret',
  ], mutatorAddr);

  const res = await pinpointField({
    goal,
    fields,
    analyze: async (addr) => {
      analyzed.push(addr);
      if (addr === getterAddr) return getterModel;
      if (addr === mutatorAddr) return mutatorModel;
      return modelOf(['ret'], addr);
    },
  });

  // Explicit getter chosen over earlier inferred 'hp'
  assert.equal(res.top.accessors.getter.sel, 'currentHp');
  assert.equal(res.top.accessors.getter.addr, getterAddr);

  // Step 2 must NOT re-analyze getterAddr
  assert.equal(analyzed.filter((a) => a === getterAddr).length, 1);

  // No duplicate size-fits (upgraded to measured: true)
  const sizeFits = res.top.evidence.filter((e) => e.code === 'size-fits');
  assert.equal(sizeFits.length, 1);
  assert.equal(sizeFits[0].detail.measured, true);

  // pickMethodsToRead penalizes initWithCoder:/copyWithZone:/encodeWithCoder:
  const picked = pickMethodsToRead([
    { sel: 'initWithCoder:', addr: 1n },
    { sel: 'copyWithZone:', addr: 2n },
    { sel: 'encodeWithCoder:', addr: 3n },
    { sel: 'takeDamage:', addr: 4n },
  ], goal, 4);
  assert.equal(picked[0].sel, 'takeDamage:');
});

/* ── 4. pinpointLocation ──────────────────────────────────────────────── */

test('pinpointLocation: deprioritizes vendorConflicts, no loc-guard on non-RMW, preserves 9+ scanAccess sites, shapeMatchCount guard, mergeByOffset identity & goalStringRefs', async () => {
  const goal = goalFromPreset('hp');

  // 4a. vendorConflicts excluded from top 8
  const analyzedAddrs = [];
  const vendorRanked = Array.from({ length: 8 }, (_, i) => ({
    addr: BASE + BigInt(i * 0x100),
    name: `-[GADBannerView m${i}]`,
    vendor: { vendor: 'Google AdMob', kind: 'ads', confidence: 'high' },
    strings: [{ text: 'hp', users: 1, score: 1 }],
  }));
  const gameAddr = BASE + 0x2000n;
  vendorRanked.push({
    addr: gameAddr,
    name: 'applyDamage',
    strings: [{ text: 'hp', users: 1, score: 1 }],
  });

  // Model with ONE RMW at +0x20 and ONE non-RMW direct write at +0x28 plus a compare
  const mixedModel = modelOf([
    'ldr w8, [x0, #0x20]',
    'sub w8, w8, #5',
    'cmp w8, #0',
    'str w8, [x0, #0x20]',
    'str w1, [x0, #0x28]',
    'ret',
  ], gameAddr);

  const locRes = await pinpointLocation({
    goal,
    ranked: vendorRanked,
    analyze: async (addr) => {
      analyzedAddrs.push(addr);
      return mixedModel;
    },
  });

  assert.deepEqual(analyzedAddrs, [gameAddr], 'vendor-conflicting functions must not consume top-8 budget');
  const rmwCand = locRes.candidates.find((c) => c.offset === 0x20n);
  const writeOnlyCand = locRes.candidates.find((c) => c.offset === 0x28n);
  assert.ok(rmwCand.evidence.some((e) => e.code === 'loc-guard'));
  assert.ok(!writeOnlyCand.evidence.some((e) => e.code === 'loc-guard'));

  // 4b. scanAccess 8-item cap does not overwrite 9th+ candidate's sites/siteCount
  const shapes10 = foldShapes({
    count: 10,
    disp: [0x80, 0x84, 0x88, 0x8c, 0x90, 0x94, 0x98, 0x9c, 0xa0, 0xa4],
    size: Array(10).fill(4),
    flags: Array(10).fill(SHAPE.DECREASE | SHAPE.CLAMPED | SHAPE.CROSS),
    amtKind: Array(10).fill(AMOUNT.CALL),
    amtDisp: Array(10).fill(0),
    addr: Array.from({ length: 10 }, (_, i) => BASE + BigInt(i * 4)),
  });
  const tenOffsetsModel = modelOf([
    ...Array.from({ length: 9 }, (_, i) => [
      `ldr w8, [x0, #${0x40 + i * 4}]`,
      'sub w8, w8, #1',
      `str w8, [x0, #${0x40 + i * 4}]`,
    ]).flat(),
    'ret',
  ]);
  const capRes = await pinpointLocation({
    goal,
    ranked: [{ addr: BASE, name: 'many', strings: [] }],
    shapes: shapes10,
    analyze: async () => tenOffsetsModel,
    scanAccess: async (req) => {
      assert.ok(req.length <= 8);
      return new Map();
    },
    limit: 20,
  });
  const shapeCand = capRes.candidates.find((c) => c.fromShape && c.offset === 0x80n);
  assert.ok(shapeCand, 'shape candidate beyond scanAccess cap should exist');
  assert.ok(shapeCand.siteCount > 0, '9th+ candidate siteCount must not be overwritten to 0');
  assert.ok(shapeCand.sites.length > 0, '9th+ candidate sites must not be overwritten to []');

  // 4c. mergeByOffset: distinct known classes at same offset stay separate; same fn via 2 regs dedups goalStringRefs
  const fields = makeFields([
    { name: 'Player', methods: [{ sel: 'hit', addr: 0x5000n }] },
    { name: 'Enemy', methods: [{ sel: 'hit', addr: 0x6000n }] },
  ]);
  const singleOffsetModel = modelOf([
    'ldr w8, [x0, #0x20]',
    'sub w8, w8, #5',
    'str w8, [x0, #0x20]',
    'ret',
  ], 0x5000n);
  const mergeRes = await pinpointLocation({
    goal,
    fields,
    ranked: [
      { addr: 0x5000n, name: '-[Player hit]', strings: [{ text: 'hp', users: 1, score: 1 }] },
      { addr: 0x6000n, name: '-[Enemy hit]', strings: [{ text: 'hp', users: 1, score: 1 }] },
    ],
    analyze: async () => singleOffsetModel,
  });
  const at20 = mergeRes.candidates.filter((c) => c.offset === 0x20n);
  assert.equal(at20.length, 2, 'distinct known classes at same offset must not be merged');

  const dualRegModel = modelOf([
    'ldr w8, [x0, #0x20]',
    'sub w8, w8, #1',
    'str w8, [x0, #0x20]',
    'ldr w9, [x1, #0x20]',
    'sub w9, w9, #1',
    'str w9, [x1, #0x20]',
    'ret',
  ], 0x7000n);
  const dedupRes = await pinpointLocation({
    goal,
    ranked: [{ addr: 0x7000n, name: 'fn', strings: [{ text: 'hp', users: 1, score: 1 }] }],
    analyze: async () => dualRegModel,
  });
  const merged = dedupRes.candidates.find((c) => c.offset === 0x20n);
  assert.equal(merged.goalStringRefs, 1, 'same function via two base regs must not double-count goalStringRefs');

  // 4d. shapeMatchCount guard: non-SHAPE_CODES preserved even when rarityLR(2, 2) returns 0
  const allMatchingShapes = foldShapes({
    count: 2,
    disp: [0x20, 0x24],
    size: [4, 4],
    flags: [SHAPE.DECREASE | SHAPE.CLAMPED | SHAPE.CROSS, SHAPE.DECREASE | SHAPE.CLAMPED | SHAPE.CROSS],
    amtKind: [AMOUNT.CALL, AMOUNT.CALL],
    amtDisp: [0, 0],
    addr: [BASE, BASE + 4n],
  });
  const guardRes = await pinpointLocation({
    goal,
    ranked: [{ addr: 0x7000n, name: 'fn', strings: [{ text: 'hp', users: 1, score: 1 }] }],
    shapes: allMatchingShapes,
    analyze: async () => singleOffsetModel,
  });
  const cand = guardRes.candidates.find((c) => c.offset === 0x20n);
  assert.ok(!cand.evidence.some((e) => e.code === 'loc-resource-drain'));
  assert.ok(cand.evidence.some((e) => e.code === 'loc-object-identity-unknown'));
});
