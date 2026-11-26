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
