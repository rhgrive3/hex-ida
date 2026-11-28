import test from 'node:test';
import assert from 'node:assert/strict';

import { autoAnalyze } from '../js/auto.js';
import { goalById, matchText } from '../js/goals.js';
import { rankCandidates, REASON } from '../js/rank.js';
import { ProgramIndex } from '../js/program.js';

function makeRealProgram(refs, funcStarts, { callersByTarget = new Map() } = {}) {
  const refFrom = BigUint64Array.from(refs.map((r) => r.from));
  const refTo = BigUint64Array.from(refs.map((r) => r.to));
  const refKind = Uint8Array.from(refs.map((r) => r.kind ?? 1));
  const symbols = {
    addrs: BigUint64Array.from(funcStarts),
    names: funcStarts.map((a) => `fn_${a.toString(16)}`),
    symbolCount: funcStarts.length,
    functionStarts: BigUint64Array.from(funcStarts),
    functionCount: funcStarts.length,
    nameAt: (addr) => {
      assert.notEqual(typeof addr, 'object', 'nameAt must receive an address, not a caller object');
      const idx = funcStarts.findIndex((s) => s === addr);
      return idx >= 0 ? `fn_${addr.toString(16)}` : null;
    },
    functionAt: (addr) => {
      let best = null;
      for (const s of funcStarts) {
        if (s <= addr) best = s;
      }
      return best != null ? { start: best, name: `fn_${best.toString(16)}` } : null;
    },
    functionStartAt: (addr) => {
      let best = null;
      for (const s of funcStarts) {
        if (s <= addr) best = s;
      }
      return best;
    },
    functionsInRange: () => [],
  };
  const program = new ProgramIndex({
    callFrom: new BigUint64Array(0),
    callTo: new BigUint64Array(0),
    refFrom,
    refTo,
    refKind,
    callsCapped: false,
    refsCapped: false,
    statsComplete: true,
  }, symbols, null);
  if (callersByTarget.size > 0) {
    program.callersOf = (target) => callersByTarget.get(target) || [];
  }
  return { program, symbols };
}

test('auto.js: callersOf extracts a.addr for symbols.nameAt and filters null/empty names', async () => {
  const targetAddr = 0x100000n;
  const callerNamed = 0x100200n;
  const callerUnnamed = 0x100300n;
  const seenNameAtArgs = [];

  const callersByTarget = new Map([
    [targetAddr, [
      { addr: callerNamed, site: 0x100210n, count: 2 },
      { addr: callerUnnamed, site: 0x100310n, count: 1 },
      { addr: null, site: 0x100410n, count: 1 },
    ]],
  ]);
  const { program, symbols } = makeRealProgram(
    [{ from: 0x100010n, to: 0x200000n, kind: 1 }],
    [targetAddr, callerNamed],
    { callersByTarget },
  );
  const origNameAt = symbols.nameAt;
  symbols.nameAt = (addr) => {
    seenNameAtArgs.push(addr);
    if (addr === callerNamed) return 'GameBattleController::onDamage';
    if (addr === callerUnnamed) return null;
    return origNameAt(addr);
  };

  const report = await autoAnalyze({
    program,
    symbols,
    strings: [{ addr: 0x200000n, text: 'player_hp_damage_formula', byteLength: 24 }],
    analyze: async () => ({
      facts: {
        instructionCount: 18,
        calls: 2,
        stores: 1,
        conditionals: 1,
        strings: ['player_hp_damage_formula'],
        calledNames: [],
        apis: [],
      },
      calls: [],
      writes: [],
      reads: [],
      compares: [],
    }),
  });

  assert.ok(seenNameAtArgs.includes(callerNamed), 'callerNamed addr must be passed to symbols.nameAt');
  assert.ok(seenNameAtArgs.includes(callerUnnamed), 'callerUnnamed addr must be passed to symbols.nameAt');
  for (const arg of seenNameAtArgs) {
    assert.notEqual(typeof arg, 'object', 'symbols.nameAt must never receive caller descriptor object');
  }
  assert.ok(Array.isArray(report.deep));
});

test('auto.js: report.findings is stably sorted by actionable desc then level rank (high < medium=normal < low < unknown)', async () => {
  const fnAddr = 0x100000n;
  const { program, symbols } = makeRealProgram(
    [
      { from: 0x100010n, to: 0x200000n, kind: 1 }, // path (low, actionable)
      { from: 0x100014n, to: 0x200100n, kind: 1 }, // ads (normal, actionable)
      { from: 0x100018n, to: 0x200200n, kind: 1 }, // endpoint (high, actionable)
      { from: 0x10001cn, to: 0x300000n, kind: 1 }, // crypto constant (high, actionable)
    ],
    [fnAddr],
  );

  const report = await autoAnalyze({
    program,
    symbols,
    strings: [
      { addr: 0x200000n, text: '/Users/dev/build/game.cpp', byteLength: 25 },          // low, actionable
      { addr: 0x200100n, text: 'admob_rewarded_video_unit', byteLength: 25 },          // normal, actionable
      { addr: 0x200200n, text: 'https://api.example.com/v1/login', byteLength: 32 },   // high, actionable
      { addr: 0x200300n, text: '/var/mobile/unreferenced/log.txt', byteLength: 32 },   // low, unreferenced
      { addr: 0x200400n, text: 'unityads_interstitial_placement', byteLength: 31 },    // normal, unreferenced
    ],
    cryptoConstants: [
      { id: 'aes_sbox', name: 'AES S-box', address: 0x300000n, length: 256 },          // high, actionable
      { id: 'sha256_k', name: 'SHA-256 K', address: 0x301000n, length: 256 },          // high, unreferenced
    ],
    highEntropyWindows: [
      { kind: 'encrypted-or-packed', entropy: 7.95, address: 0x400000n, section: '__DATA' }, // medium, unreferenced
    ],
  });

  const list = report.findings;
  assert.ok(list.length >= 6);

  // Actionable items must all precede non-actionable items
  const firstNonActionable = list.findIndex((f) => f.actionable !== true);
  assert.ok(firstNonActionable > 0);
  for (let i = 0; i < firstNonActionable; i++) {
    assert.equal(list[i].actionable, true);
  }
  for (let i = firstNonActionable; i < list.length; i++) {
    assert.notEqual(list[i].actionable, true);
  }

  // Within actionable group: high (endpoint, aes_sbox) -> normal (ads) -> low (path)
  const actionableLevels = list.slice(0, firstNonActionable).map((f) => f.level);
  const rank = { high: 0, medium: 1, normal: 1, low: 2 };
  for (let i = 1; i < actionableLevels.length; i++) {
    assert.ok(rank[actionableLevels[i - 1]] <= rank[actionableLevels[i]],
      `actionable findings out of order: ${actionableLevels.join(', ')}`);
  }

  // Within non-actionable group: high (sha256_k) -> normal (unityads) / medium (packed) -> low (path)
  const nonActionable = list.slice(firstNonActionable);
  const nonActionableLevels = nonActionable.map((f) => f.level);
  for (let i = 1; i < nonActionableLevels.length; i++) {
    assert.ok(rank[nonActionableLevels[i - 1]] <= rank[nonActionableLevels[i]],
      `non-actionable findings out of order: ${nonActionableLevels.join(', ')}`);
  }
  // Verify 'normal' is ranked strictly above 'low' (not fallen into unknown rank 3)
  const normalIdx = nonActionable.findIndex((f) => f.level === 'normal');
  const lowIdx = nonActionable.findIndex((f) => f.level === 'low');
  assert.ok(normalIdx >= 0 && lowIdx >= 0 && normalIdx < lowIdx,
    'level "normal" must sort ahead of level "low"');
});

test('goals.js: avoid regexes run in linear time (<50ms) on 50KB repetitive inputs, cover 220+ char symbols, and preserve local spans & word order', () => {
  const gacha = goalById('gacha');
  const level = goalById('level');
  const item = goalById('item');

  // 1. Worst-case 50KB repetitive inputs must complete in linear time (<50ms each)
  const worstAdUnit = 'AdUnit'.repeat(8334);
  const worstAdError = 'AdError '.repeat(6250);
  for (const [label, re, input] of [
    ['gacha avoid[4]', gacha.avoid[4], worstAdUnit],
    ['item avoid[4]', item.avoid[4], worstAdUnit],
    ['level avoid[1]', level.avoid[1], worstAdError],
  ]) {
    const t0 = performance.now();
    assert.equal(re.test(input), false);
    const elapsed = performance.now() - t0;
    assert.ok(elapsed < 50, `${label} took too long (${elapsed.toFixed(2)}ms)`);
  }
  assert.equal(matchText(gacha, worstAdUnit), null);
  assert.equal(matchText(item, worstAdUnit), null);
  assert.equal(matchText(level, worstAdError), null);

  // 2. 220+ char demangled symbol with ad prefix is still avoided
  const pad225 = 'Namespace::SubModule::'.repeat(10) + 'Detail_';
  assert.ok(pad225.length > 220);
  assert.equal(matchText(gacha, `AdUnit_${pad225}draw`), null);
  assert.equal(matchText(level, `AdError_${pad225}level`), null);
  assert.equal(matchText(item, `AdSlot_${pad225}inventory`), null);

  // 3. inventory\b word boundary: avoids "inventory" but not "inventorying"
  assert.equal(matchText(item, 'AdUnit_inventory'), null);
  assert.ok(matchText(item, 'AdUnit_inventorying') !== null);

  // 4. Local span preservation: legitimate prefix before "AdUnit draw" is NOT wiped out
  const localSpanMatch = matchText(gacha, 'gacha_summon AdUnit draw');
  assert.ok(localSpanMatch !== null, 'prefix "gacha_summon" must not be erased by local avoid span');

  // 5. Left-to-right order & word boundary preservation
  assert.ok(matchText(item, 'player_inventory AdSlot') !== null, 'reverse order must not falsely avoid player_inventory');
  assert.ok(matchText(level, 'player level: loadError') !== null, '"loadError" must not match \\bAd...Error');
  assert.ok(matchText(level, 'level up dialogError') !== null, '"dialogError" must not match \\bLog...Error');
});

test('rank.js: safeBigInt guards invalid addresses, fallback key deduplicates missing hit.id, decay [1,0.5,0.25,0] applies, and region BigInt/Number mix works', () => {
  const { program, symbols } = makeRealProgram(
    [
      { from: 0x100010n, to: 0x200004n, kind: 1 },
      { from: 0x100014n, to: 0x200104n, kind: 1 },
      { from: 0x100018n, to: 0x200204n, kind: 1 },
      { from: 0x10001cn, to: 0x200304n, kind: 1 },
      { from: 0x100020n, to: 0x200404n, kind: 1 },
    ],
    [0x100000n],
  );

  // Invalid / malformed addresses must be silently skipped without throwing
  const res = rankCandidates({
    goal: { id: 'crypto', text: 'crypto', expects: { crypto: true } },
    strings: [],
    program,
    symbols,
    region: { vmAddr: 0x100000n, size: 0x10000 }, // BigInt vmAddr + Number size
    cryptoConstants: [
      { id: 'bad_empty', name: 'Empty', address: '', length: 16 },
      { id: 'bad_ws', name: 'Whitespace', address: '   ', length: 16 },
      { id: 'bad_neg_bi', name: 'NegBigInt', address: -1n, length: 16 },
      { id: 'bad_neg_num', name: 'NegNum', address: -16, length: 16 },
      { id: 'bad_neg_str', name: 'NegStr', address: '-0x10', length: 16 },
      { id: 'bad_float', name: 'Float', address: 1.5, length: 16 },
      { id: 'bad_unsafe', name: 'UnsafeInt', address: Number.MAX_SAFE_INTEGER + 2, length: 16 },
      { id: 'bad_nan', name: 'NaN', address: Number.NaN, length: 16 },
      { id: 'bad_str', name: 'Garbage', address: 'not-a-hex', length: 16 },
      { id: 'bad_obj', name: 'Obj', address: {}, length: 16 },
      // Valid hits:
      // 1st (weight 1 -> 32): hex string address
      { id: 'aes_sbox', name: 'AES S-box', address: '0x200000', length: 32 },
      // Duplicate hit.id: must be deduplicated (0 points, does not consume decay slot)
      { id: 'aes_sbox', name: 'AES S-box dup', address: 0x200000n, length: 32 },
      // 2nd (weight 0.5 -> 16): missing hit.id uses fallback key `${addr}:${name}`
      { name: 'CustomTable', address: 0x200100, length: 32 },
      // Duplicate missing hit.id with same addr+name: deduplicated
      { name: 'CustomTable', address: 0x200100n, length: 32 },
      // 3rd (weight 0.25 -> 8): distinct addr with missing hit.id
      { name: 'CustomTable2', address: '2097664', length: 32 }, // 0x200200
      // 4th (weight 0 -> not added): exceeds 3-hit decay cap
      { id: 'chacha20', name: 'ChaCha20', address: 0x200300n, length: 32 },
      // 5th (weight 0 -> not added)
      { id: 'sha256', name: 'SHA-256', address: 0x200400n, length: 32 },
    ],
  });

  const cands = res?.candidates || res || [];
  assert.equal(cands.length, 1);
  const cryptoReasons = cands[0].reasons.filter((r) => r.code === REASON.CRYPTO_CONST);
  assert.equal(cryptoReasons.length, 3, 'exactly 3 distinct decayed crypto-const reasons should be added');
  assert.deepEqual(
    cryptoReasons.map((r) => r.points),
    [32, 16, 8],
    'decay weights [1, 0.5, 0.25] applied to POINTS[CRYPTO_CONST]=32',
  );
  assert.equal(cands[0].score, 32 + 16 + 8);

  // Region with invalid/missing size must not throw when scanning symbol names
  const symRes = rankCandidates({
    goal: goalById('hp'),
    strings: [],
    program,
    symbols: {
      addrs: BigUint64Array.from([0x100000n]),
      names: ['Player::setHP'],
      symbolCount: 1,
      functionCount: 1,
      nameAt: () => 'Player::setHP',
      functionStartAt: (a) => a,
    },
    region: { vmAddr: 0x100000n, size: undefined },
  });
  assert.ok((symRes?.candidates || []).length >= 1);
});
