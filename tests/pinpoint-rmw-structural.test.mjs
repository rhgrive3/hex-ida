import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectFieldRmwPatterns, pinpointFunction } from '../js/pinpoint-legacy.js';
import { compileGoal } from '../js/goalc.js';
import { rankCandidates } from '../js/rank.js';

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

import { foldShapes, byGoal as shapesByGoal, evidenceFor as shapeEvidenceFor, SHAPE, AMOUNT } from '../js/shapes.js';
import { goalFromPreset, matchText } from '../js/goals.js';

test('detectFieldRmwPatterns uses insn.memory.disp (BigInt/number) so distinct ARM64 offsets never collide', () => {
  const insns = [
    { address: 0x5000n, mnemonic: 'ldr', operands: 'w8, [x28, #0x48]', memory: { base: 'x28', disp: 0x48n, kind: 'load', stack: false } },
    { address: 0x5004n, mnemonic: 'subs', operands: 'w8, w8, #1' },
    { address: 0x5008n, mnemonic: 'b.lt', operands: '#0x5010' },
    { address: 0x500cn, mnemonic: 'str', operands: 'w8, [x28, #0x48]', memory: { base: 'x28', disp: 0x48n, kind: 'store', stack: false } },
    // Different offset 0x5c must NOT pair with a load from 0x48
    { address: 0x5010n, mnemonic: 'ldr', operands: 'w9, [x28, #0x48]', memory: { base: 'x28', disp: 0x48n, kind: 'load', stack: false } },
    { address: 0x5014n, mnemonic: 'add', operands: 'w9, w9, #1' },
    { address: 0x5018n, mnemonic: 'str', operands: 'w9, [x28, #0x5c]', memory: { base: 'x28', disp: 0x5cn, kind: 'store', stack: false } },
  ];
  const res = detectFieldRmwPatterns(insns);
  assert.equal(res.rmwCount, 1);
  assert.equal(res.clampedRmwCount, 1);
  assert.equal(res.fields[0].base, 'x28');
  assert.equal(res.fields[0].offset, '0x48');
});

test('shapes.js surfaces clamped-decrease resources for hp/stamina and pure decrement-to-zero for cooldown', () => {
  const scan = {
    count: 5,
    disp: new Uint32Array([0x30c, 0x30c, 0x30c, 0x374, 0x374]),
    size: new Uint8Array([4, 4, 4, 4, 4]),
    flags: new Uint8Array([
      SHAPE.DECREASE | SHAPE.CLAMP,
      SHAPE.DECREASE | SHAPE.CLAMP,
      SHAPE.INCREASE,
      SHAPE.DECREASE | SHAPE.CLAMP,
      SHAPE.DECREASE | SHAPE.CLAMP,
    ]),
    amtKind: new Uint8Array([AMOUNT.NONE, AMOUNT.NONE, AMOUNT.NONE, AMOUNT.NONE, AMOUNT.NONE]),
    amtDisp: new Uint32Array([0, 0, 0, 0, 0]),
    addr: [0x1000n, 0x1020n, 0x1040n, 0x2000n, 0x2020n],
    span: new Uint32Array([0x340, 0x340, 0x340, 0x380, 0x380]),
  };
  const shapes = foldShapes(scan);
  const hpShapes = shapesByGoal(shapes, 'hp', 4);
  // 0x30c has increases > 0 and cross=0 (money/self-resource), so only pure clamped drain 0x374 is surfaced for hp
  assert.equal(hpShapes.length, 1);
  assert.equal(hpShapes[0].offset, 0x374);
  const cdShapes = shapesByGoal(shapes, 'cooldown', 4);
  assert.equal(cdShapes.length, 1);
  assert.equal(cdShapes[0].offset, 0x374);
  const moneyEv = shapeEvidenceFor(shapes, 0x30c, 'hp');
  assert.ok(!moneyEv.codes.some((c) => c.code === 'loc-resource-drain'));
  const hpEv = shapeEvidenceFor(shapes, 0x374, 'hp');
  assert.ok(hpEv.codes.some((c) => c.code === 'loc-resource-drain'));
  const cdEv = shapeEvidenceFor(shapes, 0x374, 'cooldown');
  assert.ok(cdEv.codes.some((c) => c.code === 'loc-resource-drain'));
});

test('pinpointFunction discovers stringless shape-seeded and 1-hop stripped RMW callers', async () => {
  const goal = goalFromPreset('hp');
  const scan = {
    count: 2,
    disp: new Uint32Array([0x30c, 0x30c]),
    size: new Uint8Array([4, 4]),
    flags: new Uint8Array([SHAPE.DECREASE | SHAPE.CLAMP, SHAPE.DECREASE | SHAPE.CLAMP]),
    amtKind: new Uint8Array([AMOUNT.NONE, AMOUNT.NONE]),
    amtDisp: new Uint32Array([0, 0]),
    addr: [0x8010n, 0x8020n],
    span: new Uint32Array([0x340, 0x340]),
  };
  const shapes = foldShapes(scan);
  const symbols = {
    functionCount: 200,
    functionStartAt: (a) => (a >= 0x8000n && a < 0x8100n ? 0x8000n : null),
    nameAt: () => null,
  };
  const analyze = async (addr) => {
    if (addr === 0x8000n) {
      return {
        instructions: [
          { address: 0x8008n, mnemonic: 'ldr', operands: 'w8, [x0, #0x30c]', memory: { base: 'x0', disp: 0x30cn, kind: 'load', stack: false } },
          { address: 0x800cn, mnemonic: 'subs', operands: 'w8, w8, w1' },
          { address: 0x8010n, mnemonic: 'csel', operands: 'w8, wzr, w8, lt' },
          { address: 0x8014n, mnemonic: 'str', operands: 'w8, [x0, #0x30c]', memory: { base: 'x0', disp: 0x30cn, kind: 'store', stack: false } },
          { address: 0x8018n, mnemonic: 'ret', operands: '' },
        ],
      };
    }
    return null;
  };
  const res = await pinpointFunction({
    goal, ranked: [], shapes, symbols, analyze, functionCount: 200, budget: { left: 8 },
  });
  assert.ok(res.top, 'expected stringless shape-seeded candidate');
  assert.equal(res.top.addr, 0x8000n);
  assert.ok(res.top.evidence.some((e) => e.code === 'fn-shape-site'));
  assert.ok(res.top.evidence.some((e) => e.code === 'fn-field-rmw-clamped'));
});

test('general-purpose avoids & rank deduplication eliminate SDK/crypto/mutex/asset/assert false positives', () => {
  assert.equal(matchText(goalFromPreset('level'), '-[IronSourceSdk setLevelPlayRewardedVideoManualDelegate:]'), null);
  assert.equal(matchText(goalFromPreset('score'), 'ECGroup::CreateECPoint: Failed to create point'), null);
  assert.equal(matchText(goalFromPreset('anticheat'), 'detected illegal recursion into Mutex code'), null);
  assert.equal(matchText(goalFromPreset('anticheat'), 'detected illegal recursion in Mutex code'), null);
  assert.equal(matchText(goalFromPreset('network'), 'See http://go/deadlock'), null);
  assert.equal(matchText(goalFromPreset('network'), 'Could not create a request. Webview url is null'), null);
  const imgcut = matchText(goalFromPreset('item'), 'equipment_grade.imgcut');
  const realItem = matchText(goalFromPreset('item'), 'equipmentNum');
  assert.ok(imgcut && realItem && imgcut.score < realItem.score);
  const btnJs = matchText(goalFromPreset('gacha'), "if (typeof setVisible === 'function') setVisible('button_gacha', true)");
  const realGacha = matchText(goalFromPreset('gacha'), 'EventGacha');
  assert.ok(btnJs && realGacha && btnJs.score < realGacha.score);
});
