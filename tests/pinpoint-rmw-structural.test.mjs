import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectFieldRmwPatterns, pinpointFunction } from '../js/pinpoint-legacy.js';
import { compileGoal } from '../js/goalc.js';
import { goalFromPreset } from '../js/goals.js';
import { rankCandidates, REASON } from '../js/rank.js';
import { foldShapes, byGoal, evidenceFor, SHAPE, AMOUNT } from '../js/shapes.js';
import { EVIDENCE } from '../js/evidence.js';
import { roleProofText, reasonText } from '../js/narrate.js';
import { setLang, lang as getLang } from '../js/i18n.js';

function makeShapeScan(events) {
  const n = events.length;
  const disp = new Int32Array(n);
  const size = new Uint8Array(n);
  const flags = new Uint8Array(n);
  const amtKind = new Uint8Array(n);
  const amtDisp = new Int32Array(n);
  const addr = new BigUint64Array(n);
  const span = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    const e = events[i];
    disp[i] = e.disp ?? 0;
    size[i] = e.size ?? 4;
    flags[i] = e.flags ?? 0;
    amtKind[i] = e.amtKind ?? AMOUNT.NONE;
    amtDisp[i] = e.amtDisp ?? 0;
    addr[i] = BigInt(e.addr ?? (0x10000 + i * 4));
    span[i] = e.span ?? 0x100;
  }
  return { count: n, disp, size, flags, amtKind, amtDisp, addr, span };
}

test('detectFieldRmwPatterns detects ARM64 object-field subtract + zero-clamp RMW', () => {
  const insns = [
    { address: 0x1000n, mnemonic: 'ldr', operands: 'w8, [x0, #0x48]' },
    { address: 0x1004n, mnemonic: 'subs', operands: 'w8, w8, w1' },
    { address: 0x1008n, mnemonic: 'csel', operands: 'w8, wzr, w8, lt' },
    { address: 0x100cn, mnemonic: 'str', operands: 'w8, [x0, #0x48]' },
    { address: 0x1010n, mnemonic: 'ret', operands: '' },
  ];
  const res = detectFieldRmwPatterns(insns);
  assert.equal(res.rmwCount, 1);
  assert.equal(res.subRmwCount, 1);
  assert.equal(res.clampedRmwCount, 1);
  assert.equal(res.fields[0].base, 'x0');
  assert.equal(res.fields[0].offset, '0x48');
  assert.equal(res.fields[0].kind, 'sub');
  assert.equal(res.fields[0].clamped, true);
});

test('detectFieldRmwPatterns reads insn.memory.disp (not collapsing to 0) and falls back to offset', () => {
  const insns = [
    { address: 0x1800n, mnemonic: 'ldr', memory: { kind: 'load', stack: false, base: 'x0', disp: 0x54 } },
    { address: 0x1804n, mnemonic: 'subs', operands: 'w8, w8, w1' },
    { address: 0x1808n, mnemonic: 'csel', operands: 'w8, wzr, w8, lt' },
    { address: 0x180cn, mnemonic: 'str', memory: { kind: 'store', stack: false, base: 'x0', disp: 0x54 } },
    // Different disp must NOT pair with 0x54, and disp: 0x60 pairs with offset: 0x60
    { address: 0x1810n, mnemonic: 'ldr', memory: { kind: 'load', stack: false, base: 'x0', disp: 0x60 } },
    { address: 0x1814n, mnemonic: 'add', operands: 'w9, w9, #1' },
    { address: 0x1818n, mnemonic: 'str', memory: { kind: 'store', stack: false, base: 'x0', offset: 0x60 } },
    // Mismatched disp (0x70 load vs 0x74 store) must NOT falsely match as RMW
    { address: 0x181cn, mnemonic: 'ldr', memory: { kind: 'load', stack: false, base: 'x0', disp: 0x70 } },
    { address: 0x1820n, mnemonic: 'sub', operands: 'w10, w10, #1' },
    { address: 0x1824n, mnemonic: 'str', memory: { kind: 'store', stack: false, base: 'x0', disp: 0x74 } },
  ];
  const res = detectFieldRmwPatterns(insns);
  assert.equal(res.rmwCount, 2, 'only matching disp/offset pairs should count as RMW');
  assert.equal(res.subRmwCount, 1);
  assert.equal(res.addRmwCount, 1);
  assert.equal(res.clampedRmwCount, 1);
  assert.equal(res.fields[0].offset, String(0x54));
  assert.equal(res.fields[1].offset, String(0x60));
});

test('detectFieldRmwPatterns detects x86-64 load-op-cmov-store and direct memory RMW', () => {
  const insns = [
    { address: 0x2000n, mnemonic: 'mov', operands: 'eax, [rdi+0x20]' },
    { address: 0x2004n, mnemonic: 'sub', operands: 'eax, esi' },
    { address: 0x2006n, mnemonic: 'cmovs', operands: 'eax, edx' },
    { address: 0x2009n, mnemonic: 'mov', operands: '[rdi+0x20], eax' },
    { address: 0x200cn, mnemonic: 'add', operands: 'dword ptr [rdi+0x24], 1' },
    { address: 0x2010n, mnemonic: 'ret', operands: '' },
  ];
  const res = detectFieldRmwPatterns(insns);
  assert.equal(res.rmwCount, 2);
  assert.equal(res.subRmwCount, 1);
  assert.equal(res.addRmwCount, 1);
  assert.equal(res.clampedRmwCount, 1);
});

test('detectFieldRmwPatterns excludes stack/frame spills and resets across calls or base clobber', () => {
  const insns = [
    // Stack spill (must be ignored)
    { address: 0x3000n, mnemonic: 'ldr', operands: 'w8, [sp, #0x10]' },
    { address: 0x3004n, mnemonic: 'add', operands: 'w8, w8, #1' },
    { address: 0x3008n, mnemonic: 'str', operands: 'w8, [sp, #0x10]' },
    // Frame spill (must be ignored)
    { address: 0x300cn, mnemonic: 'mov', operands: 'eax, [rbp-0x8]' },
    { address: 0x3010n, mnemonic: 'sub', operands: 'eax, 1' },
    { address: 0x3014n, mnemonic: 'mov', operands: '[rbp-0x8], eax' },
    // Interrupted by function call (must be ignored)
    { address: 0x3018n, mnemonic: 'ldr', operands: 'w8, [x0, #0x10]' },
    { address: 0x301cn, mnemonic: 'bl', operands: '#0x4000' },
    { address: 0x3020n, mnemonic: 'sub', operands: 'w8, w8, #1' },
    { address: 0x3024n, mnemonic: 'str', operands: 'w8, [x0, #0x10]' },
  ];
  const res = detectFieldRmwPatterns(insns);
  assert.equal(res.rmwCount, 0);
});

test('shapes.js: pure clamped drain fallback activates only without primary and separates money (increases > 0)', () => {
  // Case 1: No primary (cross/call) candidate -> pure clamped drain (+0x40) matches hp, while money (+0x80, increases > 0) stays excluded.
  const foldedFallback = foldShapes(makeShapeScan([
    { disp: 0x40, flags: SHAPE.DECREASE | SHAPE.CLAMP, addr: 0x1000n },
    { disp: 0x40, flags: SHAPE.DECREASE | SHAPE.CLAMP, addr: 0x1004n },
    { disp: 0x80, flags: SHAPE.DECREASE | SHAPE.CLAMP, addr: 0x2000n },
    { disp: 0x80, flags: SHAPE.DECREASE | SHAPE.CLAMP, addr: 0x2004n },
    { disp: 0x80, flags: SHAPE.INCREASE, addr: 0x2008n },
  ]));
  const hpFallback = byGoal(foldedFallback, 'hp');
  assert.deepEqual(hpFallback.map((e) => e.offset), [0x40]);
  assert.ok(evidenceFor(foldedFallback, 0x40, 'hp').codes.some((c) => c.code === 'loc-resource-drain'));
  assert.ok(!evidenceFor(foldedFallback, 0x80, 'hp').codes.some((c) => c.code === 'loc-resource-drain'),
    'money-like field with increases > 0 must never be classified as hp drain');
  assert.ok(evidenceFor(foldedFallback, 0x80, 'money').codes.some((c) => c.code === 'loc-self-resource'));

  // Cooldown picks clamped decreasing fields.
  const cdShapes = byGoal(foldedFallback, 'cooldown');
  assert.ok(cdShapes.some((e) => e.offset === 0x40));
  assert.ok(evidenceFor(foldedFallback, 0x40, 'cooldown').codes.some((c) => c.code === 'loc-self-resource'));

  // Case 2: Primary (cross-object) candidate (+0x2c) exists -> pure clamped drain (+0x40) is NOT included in hp primary results.
  const foldedPrimary = foldShapes(makeShapeScan([
    { disp: 0x2c, flags: SHAPE.DECREASE | SHAPE.CLAMP | SHAPE.CROSS, amtKind: AMOUNT.FIELD, amtDisp: 0x18, addr: 0x3000n },
    { disp: 0x2c, flags: SHAPE.DECREASE | SHAPE.CLAMP | SHAPE.CROSS, amtKind: AMOUNT.FIELD, amtDisp: 0x18, addr: 0x3004n },
    { disp: 0x40, flags: SHAPE.DECREASE | SHAPE.CLAMP, addr: 0x1000n },
    { disp: 0x40, flags: SHAPE.DECREASE | SHAPE.CLAMP, addr: 0x1004n },
  ]));
  const hpPrimary = byGoal(foldedPrimary, 'hp');
  assert.deepEqual(hpPrimary.map((e) => e.offset), [0x2c]);
  assert.ok(evidenceFor(foldedPrimary, 0x2c, 'hp').codes.some((c) => c.code === 'loc-resource-drain'));
  assert.ok(!evidenceFor(foldedPrimary, 0x40, 'hp').codes.some((c) => c.code === 'loc-resource-drain'));
});

test('pinpointFunction: zero-string shape seed via shapes / shapesByGoal emits fn-shape-site and verifies RMW', async () => {
  const goal = goalFromPreset('hp');
  const folded = foldShapes(makeShapeScan([
    { disp: 0x48, flags: SHAPE.DECREASE | SHAPE.CLAMP, addr: 0x4008n },
    { disp: 0x48, flags: SHAPE.DECREASE | SHAPE.CLAMP, addr: 0x400cn },
  ]));
  const program = {
    functionRange: (a) => (BigInt(a) >= 0x4000n && BigInt(a) < 0x4040n ? { start: 0x4000n, end: 0x4040n } : null),
    callersOf: () => [],
  };
  const analyze = async (addr) => (BigInt(addr) === 0x4000n ? {
    instructions: [
      { address: 0x4000n, mnemonic: 'ldr', memory: { kind: 'load', stack: false, base: 'x0', disp: 0x48 } },
      { address: 0x4004n, mnemonic: 'subs', operands: 'w8, w8, w1' },
      { address: 0x4008n, mnemonic: 'csel', operands: 'w8, wzr, w8, lt' },
      { address: 0x400cn, mnemonic: 'str', memory: { kind: 'store', stack: false, base: 'x0', disp: 0x48 } },
      { address: 0x4010n, mnemonic: 'ret', operands: '' },
    ],
  } : { instructions: [] });

  const pin = await pinpointFunction({
    goal,
    ranked: [],
    shapes: folded,
    program,
    analyze,
    functionCount: 200,
  });
  assert.equal(pin.candidates.length, 1);
  assert.equal(pin.candidates[0].addr, 0x4000n);
  assert.ok(pin.candidates[0].evidence.some((e) => e.code === 'fn-shape-site'), 'must emit fn-shape-site');
  assert.ok(pin.candidates[0].evidence.some((e) => e.code === 'fn-field-rmw-clamped'), 'must verify RMW on shape-seeded function');
  assert.ok((pin.candidates[0].fusion?.identifying || 0) > 0, 'fn-shape-site must count as identifying');
});

test('pinpointFunction: 1-hop stripped caller RMW expansion verifies caller without breaking existing ranking', async () => {
  const goal = goalFromPreset('hp');
  const program = {
    functionRange: (a) => ({ start: BigInt(a), end: BigInt(a) + 0x40n }),
    callersOf: (addr) => (BigInt(addr) === 0x5000n ? [{ addr: 0x5100n, site: 0x5110n }] : []),
  };
  const symbols = {
    functionCount: 100,
    nameAt: (a) => (BigInt(a) === 0x5000n ? 'logHpWrapper' : ''),
  };
  const ranked = [{
    addr: 0x5000n,
    name: 'logHpWrapper',
    score: 20,
    reasons: [{ code: 'string-ref', points: 20, detail: { text: 'hp %d' } }],
    strings: [{ addr: 0x9000n, text: 'hp %d', users: 1, score: 1 }],
  }];
  const analyze = async (addr) => {
    if (BigInt(addr) === 0x5100n) {
      return {
        instructions: [
          { address: 0x5100n, mnemonic: 'ldr', memory: { kind: 'load', stack: false, base: 'x0', disp: 0x30 } },
          { address: 0x5104n, mnemonic: 'subs', operands: 'w8, w8, w1' },
          { address: 0x5108n, mnemonic: 'csel', operands: 'w8, wzr, w8, lt' },
          { address: 0x510cn, mnemonic: 'str', memory: { kind: 'store', stack: false, base: 'x0', disp: 0x30 } },
          { address: 0x5110n, mnemonic: 'ret', operands: '' },
        ],
      };
    }
    return { instructions: [{ address: 0x5000n, mnemonic: 'ret', operands: '' }] };
  };

  const pin = await pinpointFunction({ goal, ranked, program, symbols, analyze });
  const caller = pin.candidates.find((c) => c.addr === 0x5100n);
  assert.ok(caller, 'stripped 1-hop caller 0x5100 should be expanded');
  assert.ok(caller.evidence.some((e) => e.code === 'fn-field-rmw-clamped'), 'expanded caller should receive RMW verification');
});

test('narrate: all 5 Track 9 evidence codes + crypto-const narrate cleanly in JP and EN without null/undefined leakage', () => {
  const codes = [
    ['fn-shape-site', { offset: 0x48, goal: 'hp', sites: 2 }],
    ['fn-field-rmw', { count: 2, fields: [] }],
    ['fn-field-rmw-clamped', { count: 1, fields: [] }],
    ['fn-crypto-bitwise', { bitwiseCount: 18, hasXorLoop: true }],
    ['fn-crypto-hw-insn', { hwCryptoCount: 4 }],
  ];
  const prevLang = getLang();
  try {
    for (const lang of ['ja', 'en']) {
      setLang(lang);
      for (const [code, detail] of codes) {
        assert.ok(Object.hasOwn(EVIDENCE, code), `${code} must be registered in EVIDENCE`);
        const full = roleProofText({ code, detail, count: 1, factor: 2 });
        const empty = roleProofText({ code, detail: {}, count: 1, factor: 2 });
        assert.ok(full.length > 0, `${code} (${lang}) narration must be non-empty`);
        assert.ok(empty.length > 0, `${code} (${lang}) narration with empty detail must be non-empty`);
        assert.ok(!/\b(?:null|undefined|NaN)\b/.test(full), `${code} (${lang}) leaked null/undefined: ${full}`);
        assert.ok(!/\b(?:null|undefined|NaN)\b/.test(empty), `${code} (${lang}) empty leaked null/undefined: ${empty}`);
      }
      const cryptoReason = reasonText({ code: REASON.CRYPTO_CONST, detail: { name: 'AES S-box', algo: 'aes' } });
      assert.ok(cryptoReason.length > 0 && !/\b(?:null|undefined)\b/.test(cryptoReason));
    }
  } finally {
    setLang(prevLang);
  }
});

test('rank.js: dampens name-match + string-ref double counting and short comparison asserts', () => {
  const goal = goalFromPreset('hp');
  const addrs = [0x1000n, 0x2000n];
  const names = ['updateHp', 'otherFunc'];
  const symbols = {
    symbolCount: 2,
    functionCount: 100,
    addrs,
    names,
    renames: new Map(),
    nameAt: (a) => (a === 0x1000n ? 'updateHp' : a === 0x2000n ? 'otherFunc' : null),
    isFunctionStart: () => true,
  };
  const strings = [
    { addr: 0x8000n, text: 'hp %d', byteLength: 5 },
    { addr: 0x8100n, text: 'hp>0', byteLength: 4 },
  ];
  const refMap = new Map([
    [0x8000n, [{ addr: 0x1000n, site: 0x1004n, kind: 0 }]],
    [0x8100n, [{ addr: 0x2000n, site: 0x2004n, kind: 0 }]],
  ]);
  const program = {
    functionsReferencing: (a) => {
      const u = refMap.get(a) || [];
      u.complete = true;
      return u;
    },
    functionRange: (a) => ({ start: a, end: a + 0x20n }),
    calleesOf: () => [],
    callersOf: () => [],
    statsOf: () => ({ total: 5, numeric: 0, store: 0, cmp: 0, covered: true }),
    callCountOf: () => 0,
  };
  const res = rankCandidates({ goal, strings, program, symbols, limit: 10 });
  const c1 = res.candidates.find((c) => c.addr === 0x1000n);
  const c2 = res.candidates.find((c) => c.addr === 0x2000n);
  assert.ok(c1 && c2);
  const strReason1 = c1.reasons.find((r) => r.code === REASON.STRING_REF);
  assert.ok(strReason1 && strReason1.points <= 10, 'string-ref on name-matched symbol should be damped to prevent double counting');
  const strReason2 = c2.reasons.find((r) => r.code === REASON.STRING_REF);
  assert.ok(strReason2 && strReason2.points <= 6, 'short comparison assert hp>0 should be gently attenuated');
});

test('stripped binary: 1-hop propagation + fn-field-rmw-clamped ranks RMW helper above read-only peer', async () => {
  const compiled = compileGoal('HPを書き換える処理');
  const goal = compiled.goal;

  // Stripped binary: 0x1000 is anchor with bare identifier "unit_hp",
  // 0x1100 is a stripped callee that performs clamped HP subtraction,
  // 0x1200 is a stripped read-only callee.
  const symbols = {
    symbolCount: 0,
    functionCount: 3,
    addrs: [],
    names: [],
    renames: new Map(),
    nameAt: () => '',
    functionStartAt: (a) => BigInt(a),
  };
  const strings = [{ addr: 0x5000n, text: 'unit_hp', byteLength: 7 }];
  const program = {
    functionsReferencing: (a) => (BigInt(a) === 0x5000n ? [{ addr: 0x1000n, site: 0x1004n, kind: 'adrp-add' }] : []),
    calleesOf: (start) => (BigInt(start) === 0x1000n
      ? [{ addr: 0x1100n, site: 0x1010n }, { addr: 0x1200n, site: 0x1014n }]
      : []),
    callersOf: () => [],
    callCountOf: () => 2,
    functionRange: (a) => ({ start: BigInt(a), end: BigInt(a) + 0x40n }),
    statsOf: (start) => (BigInt(start) === 0x1100n
      ? { total: 10, numeric: 2, store: 2, cmp: 1, covered: true }
      : { total: 10, numeric: 0, store: 0, cmp: 0, covered: true }),
  };

  const ranked = rankCandidates({ goal, strings, program, symbols, limit: 10 });
  const addrs = ranked.candidates.map((c) => c.addr);
  assert.ok(addrs.includes(0x1100n), 'stripped callee 0x1100 should be discovered via 1-hop propagation');

  const disasmByAddr = new Map([
    [0x1000n, [{ address: 0x1000n, mnemonic: 'ret', operands: '' }]],
    [0x1100n, [
      { address: 0x1100n, mnemonic: 'ldr', operands: 'w8, [x0, #0x48]' },
      { address: 0x1104n, mnemonic: 'subs', operands: 'w8, w8, w1' },
      { address: 0x1108n, mnemonic: 'csel', operands: 'w8, wzr, w8, lt' },
      { address: 0x110cn, mnemonic: 'str', operands: 'w8, [x0, #0x48]' },
      { address: 0x1110n, mnemonic: 'ret', operands: '' },
    ]],
    [0x1200n, [
      { address: 0x1200n, mnemonic: 'ldr', operands: 'w0, [x0, #0x48]' },
      { address: 0x1204n, mnemonic: 'ret', operands: '' },
    ]],
  ]);

  const pin = await pinpointFunction({
    goal,
    ranked: ranked.candidates,
    symbols,
    program,
    deep: true,
    analyze: async (a) => ({ instructions: disasmByAddr.get(BigInt(a)) || [] }),
  });
  const c1100 = pin.candidates.find((c) => c.addr === 0x1100n);
  const c1200 = pin.candidates.find((c) => c.addr === 0x1200n);
  assert.ok(c1100, '0x1100 present in pinpoint candidates');
  assert.ok(c1100.evidence.some((e) => e.code === 'fn-field-rmw-clamped'), '0x1100 has fn-field-rmw-clamped');
  assert.ok(!c1200?.evidence?.some((e) => e.code === 'fn-field-rmw-clamped'), 'read-only 0x1200 has no RMW');
  assert.ok((c1100.fusion?.rawLogOdds ?? 0) > (c1200?.fusion?.rawLogOdds ?? -999), 'RMW+clamp callee outranks read-only peer');
});
