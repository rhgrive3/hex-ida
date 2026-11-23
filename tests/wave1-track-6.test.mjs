import test from 'node:test';
import assert from 'node:assert/strict';

import { findings, autoAnalyze } from '../js/auto.js';
import { buildStringMap } from '../js/appmap.js';
import { matchFunctions } from '../js/recognition/matcher.js';
import { diffFunctions } from '../js/diff/index.js';
import { stringLookup } from '../js/role.js';
import { classFromSymbol } from '../js/vendors.js';
import { factText, oneLiner, actionPhrase } from '../js/narrate.js';
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

/* ── #1 [P1]: auto.js findings() & appmap.js buildStringMap() BigInt addr guard ── */
test('[W1-T6-#1] findings() and buildStringMap() normalize valid addresses to BigInt and skip invalid ones without TypeError', () => {
  const calls = [];
  const program = {
    functionsReferencing(addr, span, limit) {
      assert.equal(typeof addr, 'bigint', `Expected bigint addr, got ${typeof addr}: ${String(addr)}`);
      assert.ok(addr >= 0n, `Expected non-negative addr, got ${addr}`);
      assert.equal(typeof span, 'bigint');
      calls.push({ addr, span, limit });
      const res = [{ addr: 0x100001000n, site: 0x100001010n }];
      res.complete = true;
      return res;
    },
  };
  const symbols = { nameAt: (a) => (a === 0x100001000n ? 'CheckJailbreak' : null) };

  const strings = [
    { text: 'https://api.example.com/v1/purchase', addr: 0x2000n },
    { text: 'https://api.example.com/v2/purchase', addr: 0x3000 },
    { text: 'https://api.example.com/v3/purchase', addr: '0x4000' },
    { text: 'https://api.example.com/v4/purchase', addr: null },
    { text: 'https://api.example.com/v5/purchase', addr: undefined },
    { text: 'https://api.example.com/v6/purchase', addr: 'not-an-address' },
    { text: 'https://api.example.com/v7/purchase', addr: -1n },
    { text: 'https://api.example.com/v8/purchase', addr: 1.5 },
    { text: 'https://api.example.com/v9/purchase', addr: { bad: true } },
  ];

  const found = findings(strings, program, symbols);
  assert.equal(found.length, strings.length);
  const referenced = found.filter((f) => f.actionable);
  const unreferenced = found.filter((f) => !f.actionable);
  assert.equal(referenced.length, 3);
  assert.equal(unreferenced.length, 6);
  for (const r of referenced) {
    assert.equal(typeof r.addr, 'bigint');
    assert.equal(r.status, 'referenced');
  }
  for (const u of unreferenced) {
    assert.equal(u.status, 'unreferenced');
    assert.equal(u.xrefsComplete, false);
  }
  assert.deepEqual(
    calls.map((c) => c.addr),
    [0x2000n, 0x3000n, 0x4000n],
  );

  calls.length = 0;
  const map = buildStringMap({
    program,
    symbols,
    strings: [
      { text: 'shop_purchase_item', addr: 0x5000n },
      { text: 'shop_purchase_gold', addr: 0x6000 },
      { text: 'shop_purchase_pack', addr: '0x7000' },
      { text: 'shop_purchase_bad1', addr: null },
      { text: 'shop_purchase_bad2', addr: 'invalid' },
      { text: 'shop_purchase_bad3', addr: -10n },
      { text: 'shop_purchase_bad4', addr: Number.NaN },
    ],
  });
  assert.equal(map.byStrings, true);
  assert.ok(map.subsystems.some((s) => s.id === 'purchase'));
  assert.deepEqual(
    calls.map((c) => c.addr),
    [0x5000n, 0x6000n, 0x7000n],
  );
});

/* ── #2 [P1]: auto.js pinpointPerGoal shared budget across all 3 phases ── */
test('[W1-T6-#2] autoAnalyze shares pinpointPerGoal budget across field, location, and function phases', async () => {
  // Build enough candidate functions and class methods so field, location, and
  // function phases all request analysis budget within the same goal.
  const fnAddrs = [];
  for (let i = 0; i < 12; i++) fnAddrs.push(0x100001000n + BigInt(i * 0x100));

  const classes = new Map();
  classes.set('PlayerStats', {
    name: 'PlayerStats',
    ivars: [
      { name: '_hp', offset: 0x10n, size: 4, type: 'int' },
      { name: '_attack', offset: 0x14n, size: 4, type: 'int' },
    ],
    methods: fnAddrs.slice(0, 6).map((addr, i) => ({
      sel: `updateHp${i}:`,
      addr,
      className: 'PlayerStats',
    })),
    classMethods: [],
  });
  const fields = {
    classes,
    classCount: 1,
    fieldCount: 2,
    byClass: (name) => classes.get(name) || null,
    ownerOf: (addr) => {
      const idx = fnAddrs.indexOf(addr);
      return idx >= 0 && idx < 6 ? { className: 'PlayerStats', sel: `updateHp${idx}:` } : null;
    },
    fieldsOf: () => classes.get('PlayerStats').ivars,
    fieldAt: (_cls, off) => classes.get('PlayerStats').ivars.find((v) => v.offset === off) || null,
  };

  const strings = fnAddrs.map((addr, i) => ({
    addr: 0x200000000n + BigInt(i * 0x40),
    text: `player_hp_damage_${i}`,
    byteLength: `player_hp_damage_${i}`.length,
  }));

  const program = {
    functionCount: fnAddrs.length,
    functions: fnAddrs,
    callCount: 0,
    refCount: strings.length,
    statsComplete: true,
    callsCapped: false,
    refsCapped: false,
    callCountOf: () => 0,
    statsOf: () => ({ insns: 10, calls: 0, loads: 2, stores: 2 }),
    functionRange: (a) => ({ start: a, end: a + 0x80n }),
    callersOf: () => [],
    calleesOf: () => [],
    refsFrom: () => [],
    functionsReferencing: (addr) => {
      const idx = Number((addr - 0x200000000n) / 0x40n);
      const target = fnAddrs[idx];
      const res = target ? [{ addr: target, site: target + 4n }] : [];
      res.complete = true;
      return res;
    },
  };
  const symbols = {
    functionCount: fnAddrs.length,
    nameAt: (a) => {
      const idx = fnAddrs.indexOf(a);
      return idx >= 0 ? `-[PlayerStats updateHp${idx}:]` : null;
    },
  };
  const region = { vmAddr: 0x100000000n, size: 0x100000n };

  let analyzeCalls = 0;
  const analyze = async (addr) => {
    analyzeCalls++;
    return {
      startAddress: addr,
      instructions: [],
      calls: [],
      updates: [],
      facts: { instructionCount: 10, calls: 0, calledNames: [], stringRefs: [] },
    };
  };

  const perGoal = 5;
  const report = await autoAnalyze({
    strings,
    program,
    symbols,
    fields,
    region,
    analyze,
    pinpointBudget: 100,
    pinpointPerGoal: perGoal,
    pinpointFieldBudget: 4,
    pinpointLocationBudget: 4,
    pinpointFunctionBudget: 4,
    deepLimit: 0,
  });

  // With a single set of 12 distinct functions memoized across goals, check
  // directly that pinpointUsed never exceeds perGoal * goalsExamined, and
  // specifically for a single goal budget cap (pinpointBudget = 100, perGoal = 5)
  // verify that a single goal with only 1 matching preset spends <= perGoal.
  assert.ok(report.stats.pinpointUsed <= perGoal * report.stats.goalsExamined,
    `pinpointUsed (${report.stats.pinpointUsed}) exceeded perGoal * goalsExamined`);

  // Now isolate a single goal by setting pinpointBudget large and using a
  // unique non-memoized counter per call to confirm a single goal never exceeds perGoal.
  const perGoalCalls = [];
  let currentGoalCalls = 0;
  const reportSingle = await autoAnalyze({
    strings: strings.slice(0, 8),
    program,
    symbols,
    fields,
    region,
    analyze: async (addr) => {
      currentGoalCalls++;
      return {
        startAddress: addr,
        instructions: [],
        calls: [],
        updates: [],
        facts: { instructionCount: 10, calls: 0, calledNames: [], stringRefs: [] },
      };
    },
    onProgress: (p) => {
      if (p.phase === 'pinpoint') {
        if (currentGoalCalls > 0) perGoalCalls.push(currentGoalCalls);
        currentGoalCalls = 0;
      }
    },
    pinpointBudget: 500,
    pinpointPerGoal: 3,
    pinpointFieldBudget: 3,
    pinpointLocationBudget: 3,
    pinpointFunctionBudget: 3,
    deepLimit: 0,
  });
  if (currentGoalCalls > 0) perGoalCalls.push(currentGoalCalls);
  assert.ok(perGoalCalls.length >= 1, 'Expected at least one pinpoint goal to invoke analyze');
  for (const used of perGoalCalls) {
    assert.ok(used <= 3, `Single goal spent ${used} analyze calls, exceeding pinpointPerGoal=3`);
  }
  assert.ok(analyzeCalls > 0);
  assert.ok(reportSingle.stats.pinpointUsed <= 3 * reportSingle.stats.goalsExamined);
});

/* ── #3 [P1]: matcher.js admission cutoff sets candidateGraphIncomplete and keeps all nodes unresolved ── */
test('[W1-T6-#3] matchFunctions propagates candidateGraphIncomplete and preserves all unresolved nodes on admission cutoff', () => {
  const makeFn = (addr, seed) => ({
    address: addr,
    architecture: 'arm64',
    size: 16,
    bytes: new Uint8Array([seed, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]),
    instructions: [`mov x0, #${seed}`, 'add x0, x0, #1', 'ret'],
    cfg: { blocks: 1, edges: 0, exits: 1, loops: 0, calls: 0 },
    strings: [`unique_str_${seed}`],
    imports: [`imp_${seed}`],
    calls: [],
    constants: [seed * 17],
    relocationOffsets: [],
    semantic: { operations: ['add', 'return'] },
  });

  const before = [makeFn(0x1000n, 10), makeFn(0x2000n, 20), makeFn(0x3000n, 30)];
  const after = [makeFn(0x11000n, 10), makeFn(0x12000n, 20), makeFn(0x13000n, 30)];

  // Candidate generation succeeds (3 edges <= maxCandidateEdges: 100),
  // but solveCandidateMatching admission truncates at maxCandidateAdmission: 1.
  const result = matchFunctions(before, after, {
    matchBudget: {
      maxCandidateEvaluations: 100,
      maxCandidateEdges: 100,
      maxCandidateAdmission: 1,
      maxWallMs: 10_000,
    },
  });

  assert.equal(result.truncated, true);
  assert.equal(result.ambiguous, true);
  assert.equal(result.matching.candidateGraphIncomplete, true);
  assert.equal(result.matches.length, 0);
  assert.equal(result.unresolvedBefore.length, 3, 'All before functions must be unresolved, not dropped');
  assert.equal(result.unresolvedAfter.length, 3, 'All after functions must be unresolved, not dropped');
  assert.equal(result.matching.ambiguousBefore, 3);
  assert.equal(result.matching.ambiguousAfter, 3);

  const diff = diffFunctions(before, after, {
    matchBudget: {
      maxCandidateEvaluations: 100,
      maxCandidateEdges: 100,
      maxCandidateAdmission: 1,
      maxWallMs: 10_000,
    },
  });
  assert.equal(diff.complete, false);
  assert.equal(diff.matching.candidateGraphIncomplete, true);
  assert.equal(diff.deleted.length, 0);
  assert.equal(diff.new.length, 0);
  assert.equal(diff.unresolved.length, 6);
});

/* ── #4 [P1]: matcher.js neighborhood iterations propagate newly anchored matches ── */
test('[W1-T6-#4] matchFunctions propagates 2-hop call-neighborhood anchors across iterations', () => {
  // Chain: A -> B -> C.
  // A is an exact match (initial anchor).
  // B is moderately strong (~0.78-0.84) with A as caller: iter 0 boosts B and promotes B to anchor.
  // C has B as its only caller: iter 0 gives C no bonus; iter 1 sees B in anchors and boosts C.
  const fnA1 = {
    address: 0x1000n,
    architecture: 'arm64',
    size: 16,
    bytes: new Uint8Array([0x10, 0x20, 0x30, 0x40, 0x50, 0x60, 0x70, 0x80, 1, 2, 3, 4, 5, 6, 7, 8]),
    instructions: ['stp x29, x30, [sp, #-16]!', 'bl #0x2000', 'ldp x29, x30, [sp], #16', 'ret'],
    cfg: { blocks: 1, edges: 0, exits: 1, loops: 0, calls: 1 },
    strings: ['anchor_root_alpha'],
    imports: ['alpha_imp'],
    callers: [],
    callees: [0x2000n],
    constants: [111],
    relocationOffsets: [],
    semantic: { operations: ['call', 'return'] },
  };
  const fnA2 = {
    ...fnA1,
    address: 0x9000n,
    callees: [0xa000n],
  };

  const fnB1 = {
    address: 0x2000n,
    architecture: 'arm64',
    size: 16,
    bytes: new Uint8Array([0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 9, 10, 11, 12, 13, 14, 15, 16]),
    instructions: ['mov x0, #1', 'add x0, x0, #2', 'bl #0x3000', 'ret'],
    cfg: { blocks: 2, edges: 1, exits: 1, loops: 0, calls: 1 },
    strings: ['hop1_middle_beta', 'hop1_extra_before'],
    imports: ['beta_imp'],
    callers: [0x1000n],
    callees: [0x3000n],
    constants: [222, 223],
    relocationOffsets: [],
    semantic: { operations: ['add', 'call', 'return'] },
  };
  const fnB2 = {
    ...fnB1,
    address: 0xa000n,
    bytes: new Uint8Array([0x99, 0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 99, 98, 97, 96, 95, 94, 93, 92]),
    strings: ['hop1_middle_beta', 'hop1_extra_after'],
    imports: ['beta_imp'],
    callers: [0x9000n],
    callees: [0xb000n],
    constants: [222, 999],
    semantic: { operations: ['add', 'call', 'return', 'cmp'] },
  };

  const fnC1 = {
    address: 0x3000n,
    architecture: 'arm64',
    size: 16,
    bytes: new Uint8Array([0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 17, 18, 19, 20, 21, 22, 23, 24]),
    instructions: ['mov x0, #5', 'sub x0, x0, #1', 'ret'],
    cfg: { blocks: 1, edges: 0, exits: 1, loops: 0, calls: 0 },
    strings: ['hop2_leaf_gamma', 'hop2_before_only'],
    imports: ['gamma_imp'],
    callers: [0x2000n],
    callees: [],
    constants: [333, 334],
    relocationOffsets: [],
    semantic: { operations: ['sub', 'return'] },
  };
  const fnC2 = {
    ...fnC1,
    address: 0xb000n,
    bytes: new Uint8Array([0xaa, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 17, 18, 19, 20, 21, 22, 23, 25]),
    strings: ['hop2_leaf_gamma', 'hop2_after_only'],
    callers: [0xa000n],
    callees: [],
    constants: [333, 335],
    semantic: { operations: ['sub', 'return', 'cmp'] },
  };

  const iter1 = matchFunctions([fnA1, fnB1, fnC1], [fnA2, fnB2, fnC2], { neighborhoodIterations: 1 });
  const iter2 = matchFunctions([fnA1, fnB1, fnC1], [fnA2, fnB2, fnC2], { neighborhoodIterations: 2 });

  const cMatch1 = iter1.matches.find((m) => m.before.address === 0x3000n);
  const cMatch2 = iter2.matches.find((m) => m.before.address === 0x3000n);
  assert.ok(cMatch1 && cMatch2, 'Expected leaf function C to match in both runs');
  assert.equal(cMatch1.reasons.includes('call-neighborhood'), false,
    '1 iteration cannot reach 2-hop leaf C before B is promoted to anchor');
  assert.equal(cMatch2.reasons.includes('call-neighborhood'), true,
    '2nd iteration must see newly promoted anchor B and boost 2-hop leaf C');
  assert.ok(cMatch2.confidence > cMatch1.confidence,
    `Expected iter2 confidence (${cMatch2.confidence}) > iter1 confidence (${cMatch1.confidence})`);
});

/* ── #5 [P2]: role.js stringLookup BigInt safety & byteLength consistency ── */
test('[W1-T6-#5] stringLookup handles non-BigInt addresses safely and validates byteLength against text', () => {
  const list = [
    { addr: 0x1000n, text: 'hi', byteLength: 50000 }, // forged oversized byteLength
    { addr: 0x2000, text: 'hello', byteLength: 1 },   // forged undersized byteLength
    { addr: '0x3000', text: 'a\\nb', byteLength: 3 }, // valid escaped control (raw 3 bytes)
    { addr: null, text: 'ignored_null' },
    { addr: undefined, text: 'ignored_undef' },
    { addr: 'not-an-addr', text: 'ignored_str' },
    { addr: -5n, text: 'ignored_neg' },
    { addr: 1.5, text: 'ignored_float' },
    { addr: {}, text: 'ignored_obj' },
  ];

  const lookup = stringLookup(list);

  // Valid lookups with bigint, number, and hex string queries
  assert.equal(lookup(0x1000n)?.text, 'hi');
  assert.equal(lookup(0x1002n)?.text, 'hi'); // NUL terminator at +2
  assert.equal(lookup(0x1003n), null, 'Forged byteLength=50000 must not extend match past real text length');
  assert.equal(lookup(0x1050n), null);

  assert.equal(lookup(0x2000)?.text, 'hello');
  assert.equal(lookup(0x2004n)?.text, 'hello', 'Forged byteLength=1 must fall back to real text length');
  assert.equal(lookup(0x2006n), null);

  assert.equal(lookup('0x3000')?.text, 'a\\nb');
  assert.equal(lookup(0x3003n)?.text, 'a\\nb'); // raw 3 + NUL
  assert.equal(lookup(0x3004n), null);

  // Invalid query addresses never throw TypeError
  assert.equal(lookup(null), null);
  assert.equal(lookup(undefined), null);
  assert.equal(lookup('invalid'), null);
  assert.equal(lookup(-1n), null);
  assert.equal(lookup(1.5), null);
  assert.equal(lookup({}), null);
});

/* ── #6 [P2]: vendors.js itaniumOwnerOf C++ operator overloads ── */
test('[W1-T6-#6] classFromSymbol preserves class name for Itanium C++ operator overloads', () => {
  assert.equal(classFromSymbol('_ZN2ns3ClsclEv'), 'ns::Cls');
  assert.equal(classFromSymbol('_ZN3ClsclEv'), 'Cls');
  assert.equal(classFromSymbol('_ZN2ns3ClseqERKS0_'), 'ns::Cls');
  assert.equal(classFromSymbol('_ZN2ns3ClsplERKS0_'), 'ns::Cls');
  assert.equal(classFromSymbol('_ZN2ns3ClsixEm'), 'ns::Cls');
  assert.equal(classFromSymbol('_ZN2ns3ClsaSERKS0_'), 'ns::Cls');
  assert.equal(classFromSymbol('_ZN2ns3ClscvN2ns3BarEEv'), 'ns::Cls');
  assert.equal(classFromSymbol('_ZN2ns3ClsI3IntEclEv'), 'ns::Cls');
  assert.equal(classFromSymbol('__ZN2ns3ClspLEi'), 'ns::Cls');

  // Regular methods & constructors still work as before
  assert.equal(classFromSymbol('_ZN2ns3Cls2fnEv'), 'ns::Cls');
  assert.equal(classFromSymbol('_ZN2ns3ClsC1Ev'), 'ns::Cls');
  assert.equal(classFromSymbol('_ZN2ns3ClsD1Ev'), 'ns::Cls');
});

/* ── #7 [P2]: narrate.js English locale i18n separators & parentheses ── */
test('[W1-T6-#7] narrate.js uses English separators and ASCII parentheses under en locale', () => {
  const enNumeric = withLang('en', () => factText({ code: 'numeric', detail: { mul: 2, div: 1, fmul: 3 } }));
  assert.equal(enNumeric.includes('・'), false, `Unexpected Japanese middot in en: ${enNumeric}`);
  assert.ok(enNumeric.includes(', '));

  const jaNumeric = withLang('ja', () => factText({ code: 'numeric', detail: { mul: 2, div: 1 } }));
  assert.ok(jaNumeric.includes('・'));

  const enOneLiner2 = withLang('en', () => oneLiner({
    inferences: [{ code: 'purpose-feature', detail: { features: ['network', 'storage'] } }],
  }));
  assert.equal(enOneLiner2.includes('と'), false, `Unexpected Japanese particle in en: ${enOneLiner2}`);
  assert.ok(enOneLiner2.includes(' and '));

  const enOneLiner3 = withLang('en', () => oneLiner({
    inferences: [{ code: 'purpose-feature', detail: { features: ['network', 'storage', 'security'] } }],
  }));
  assert.equal(enOneLiner3.includes('と'), false, `Unexpected Japanese particle in en: ${enOneLiner3}`);
  assert.ok(enOneLiner3.includes(', and '));

  const jaOneLiner = withLang('ja', () => oneLiner({
    inferences: [{ code: 'purpose-feature', detail: { features: ['network', 'storage'] } }],
  }));
  assert.ok(jaOneLiner.includes('と'));

  const enAmount = withLang('en', () => actionPhrase('increase', 4096n));
  assert.equal(enAmount.includes('（'), false, `Unexpected fullwidth paren in en: ${enAmount}`);
  assert.equal(enAmount.includes('）'), false, `Unexpected fullwidth paren in en: ${enAmount}`);
  assert.ok(enAmount.includes('4096 (0x1000)'), `Expected ASCII hex parens in en, got: ${enAmount}`);

  const jaAmount = withLang('ja', () => actionPhrase('increase', 4096n));
  assert.ok(jaAmount.includes('4096（0x1000）'));
});
