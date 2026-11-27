import assert from 'node:assert/strict';
import test from 'node:test';

import { goalFromPreset, parseGoal } from '../js/goals.js';
import { rankCandidates, REASON } from '../js/rank.js';

function makeProgram(overrides = {}) {
  return {
    callsCapped: false,
    functionsReferencing: () => {
      const arr = [];
      arr.complete = true;
      return arr;
    },
    functionRange: (addr) => ({ start: addr, end: addr + 0x40n }),
    calleesOf: () => [],
    callersOf: () => [],
    statsOf: () => ({ total: 10, numeric: 0, store: 0, cmp: 0, mul: 0, div: 0, fmul: 0, farith: 0, covered: true }),
    callCountOf: () => 0,
    ...overrides,
  };
}

test('matchedStrings precomputes diagFactor/effectiveScore, deduplicates addr:text, and sorts deterministically', () => {
  const goal = goalFromPreset('damage');
  const strings = [
    { addr: 0x3000n, text: 'Error: damage failed' },
    { addr: 0x2000n, text: 'damage dealt to enemy' },
    { addr: 0x1000n, text: 'damage dealt' },
    { addr: 0x1000n, text: 'damage dealt' }, // duplicate addr:text
    { addr: 0x1800n, text: 'damage dealt' }, // same text, higher addr
  ];
  const res = rankCandidates({ goal, strings, program: null, symbols: null });
  assert.equal(res.matchedStrings.length, 4, 'duplicate addr:text must be removed');
  assert.equal(res.matchedStrings[0].addr, 0x1000n, 'non-diagnostic shorter string at lower addr comes first');
  assert.equal(res.matchedStrings[1].addr, 0x1800n, 'same text breaks tie by ascending addr');
  assert.equal(res.matchedStrings[2].addr, 0x2000n, 'longer non-diagnostic string follows shorter');
  assert.equal(res.matchedStrings[3].addr, 0x3000n, 'diagnostic string is ranked below non-diagnostic');
  assert.equal(res.matchedStrings[0].diagFactor, 1);
  assert.equal(res.matchedStrings[3].diagFactor, 0.45);
  assert.equal(res.matchedStrings[3].effectiveScore, res.matchedStrings[3].score * 0.45);
});

test('string xref span uses s.byteLength when valid and falls back to UTF-8 byte length (clamped to 256)', () => {
  const goal = parseGoal('攻撃力');
  const seenSpans = new Map();
  const program = makeProgram({
    functionsReferencing: (addr, span) => {
      seenSpans.set(addr, span);
      const arr = [];
      arr.complete = true;
      return arr;
    },
  });
  const strings = [
    { addr: 0x1000n, text: '攻撃力' }, // 3 chars, 9 UTF-8 bytes
    { addr: 0x2000n, text: '攻撃力', byteLength: 16 }, // explicit s.byteLength takes precedence
    { addr: 0x3000n, text: '攻撃力', byteLength: 500 }, // clamped to 256
  ];
  rankCandidates({ goal, strings, program, symbols: null });
  assert.equal(seenSpans.get(0x1000n), 9n);
  assert.equal(seenSpans.get(0x2000n), 16n);
  assert.equal(seenSpans.get(0x3000n), 256n);
});

test('hasProgram === false keeps matchedStringsComplete true without sampling note even above 1200 matches', () => {
  const goal = goalFromPreset('hp');
  const strings = [];
  for (let i = 0; i < 1300; i++) {
    strings.push({ addr: 0x10000n + BigInt(i * 16), text: `player health ${i}` });
  }
  const noProg = rankCandidates({ goal, strings, program: null, symbols: null });
  assert.equal(noProg.matchedStrings.length, 1300);
  assert.equal(noProg.matchedStringsComplete, true);
  assert.equal(noProg.notes.some((n) => n.startsWith('string-matches-sampled')), false);

  const withProg = rankCandidates({ goal, strings, program: makeProgram(), symbols: null });
  assert.equal(withProg.matchedStringsComplete, false);
  assert.ok(withProg.notes.includes('string-matches-sampled:1200/1300'));
});

test('symbols.renames integrates when symbolCount === 0, overrides old names, guards BigInt keys, and respects region', () => {
  const goal = goalFromPreset('damage');

  // 1. symbolCount === 0 with only renames
  const renameOnlySymbols = {
    symbolCount: 0,
    functionCount: 0,
    addrs: [],
    names: [],
    renames: new Map([
      [String(0x1000n), 'applyDamage'],
      ['not-a-bigint', 'applyDamage'],
      ['', 'applyDamage'],
      ['   ', 'applyDamage'],
      ['-1', 'applyDamage'],
      [String(0x9000n), 'applyDamage'], // outside region
    ]),
    nameAt: () => null,
  };
  const r1 = rankCandidates({
    goal,
    strings: [],
    program: null,
    symbols: renameOnlySymbols,
    region: { vmAddr: 0x1000n, size: 0x1000n },
  });
  assert.equal(r1.candidates.length, 1);
  assert.equal(r1.candidates[0].addr, 0x1000n);
  assert.equal(r1.candidates[0].name, 'applyDamage');

  // 2. User rename overrides old symbol name at same address
  const overrideSymbols = {
    symbolCount: 2,
    functionCount: 2,
    addrs: [0x1000n, 0x2000n],
    names: ['oldDamageCalc', 'sub_2000'],
    renames: new Map([
      [String(0x1000n), 'unrelatedHelper'], // replaces matching old name with non-matching
      [String(0x2000n), 'calcDamage'], // replaces non-matching old name with matching
    ]),
    isFunctionStart: () => true,
    nameAt: (a) => (a === 0x1000n ? 'unrelatedHelper' : a === 0x2000n ? 'calcDamage' : null),
  };
  const r2 = rankCandidates({ goal, strings: [], program: null, symbols: overrideSymbols });
  assert.deepEqual(r2.candidates.map((c) => c.addr), [0x2000n]);
  assert.equal(r2.candidates[0].name, 'calcDamage');

  // 3. matcher === null still runs matchName fallback (does not skip symbol scan)
  const noMatcherGoal = {
    id: 'custom-empty',
    strong: [],
    weak: [],
    extraTerms: [],
    expects: {},
    terms: [],
  };
  const r3 = rankCandidates({ goal: noMatcherGoal, strings: [], program: null, symbols: overrideSymbols });
  assert.equal(r3.candidates.length, 0);
});

test('non-function-start symbols normalize via functionStartAt and aggregate to best effective score per candidate', () => {
  const goal = goalFromPreset('damage');
  const symbols = {
    symbolCount: 3,
    functionCount: 1,
    addrs: [0x1000n, 0x1010n, 0x1020n],
    names: ['isDamageEnabled', 'damageLabel', 'getDamage'],
    functionStartAt: (a) => (a >= 0x1000n && a < 0x1040n ? 0x1000n : null),
    isFunctionStart: (a) => a === 0x1000n,
    nameAt: (a) => (a === 0x1000n ? 'isDamageEnabled' : null),
  };
  const res = rankCandidates({ goal, strings: [], program: null, symbols });
  assert.equal(res.candidates.length, 1);
  assert.equal(res.candidates[0].addr, 0x1000n);
  const nameReasons = res.candidates[0].reasons.filter((r) => r.code === REASON.NAME);
  assert.equal(nameReasons.length, 1, 'should aggregate to one NAME reason per candidate address');
  assert.equal(nameReasons[0].detail.name, 'getDamage', 'should keep highest effective score match');
});

test('400-match cap prioritizes non-vendor matches, effScore/roleRank/codepoint tie-breakers, and exempts existing byAddr candidates', () => {
  const goal = goalFromPreset('money');
  const addrs = [];
  const names = [];
  // 405 vendor-conflicting matches (Firebase conflicts with game money; 'F' < 'g' in codepoint order)
  for (let i = 0; i < 405; i++) {
    addrs.push(0x10000n + BigInt(i * 0x10));
    names.push(`FirebaseMoneyTracker_${String(i).padStart(3, '0')}`);
  }
  // 402 non-vendor matches
  for (let i = 0; i < 402; i++) {
    addrs.push(0x20000n + BigInt(i * 0x10));
    names.push(`getMoney_${String(i).padStart(3, '0')}`);
  }
  // One low-ranked non-value match that is already in byAddr via string ref
  const existingAddr = 0x30000n;
  addrs.push(existingAddr);
  names.push('isMoneyValid');

  const symbols = {
    symbolCount: addrs.length,
    functionCount: addrs.length,
    addrs,
    names,
    isFunctionStart: () => true,
    nameAt: (a) => {
      const idx = addrs.indexOf(a);
      return idx >= 0 ? names[idx] : null;
    },
  };
  const program = makeProgram({
    functionsReferencing: () => {
      const arr = [{ addr: existingAddr, site: existingAddr + 4n, kind: 0 }];
      arr.complete = true;
      return arr;
    },
  });
  const res = rankCandidates({
    goal,
    strings: [{ addr: 0x90000n, text: 'not enough coins' }],
    program,
    symbols,
    limit: 500,
  });
  assert.ok(res.notes.includes('name-matches-capped'));
  const existingCand = res.candidates.find((c) => c.addr === existingAddr);
  assert.ok(existingCand, 'existing byAddr candidate must be present');
  assert.ok(
    existingCand.reasons.some((r) => r.code === REASON.NAME && r.detail.name === 'isMoneyValid'),
    'existing byAddr candidate must be exempt from 400-match cap',
  );
  // Non-vendor matches should beat vendor matches for the 400 cap slots
  const nonVendorWithName = res.candidates.filter((c) => c.name?.startsWith('getMoney_'));
  assert.equal(nonVendorWithName.length, 400);
});

test('tainted uses vendorOfCandidate (including string-based vendor), excludes self-recursion, and snapshots baseScore', () => {
  const goal = goalFromPreset('money');
  const UNNAMED_VENDOR = 0x1000n; // no name, but references Firebase string
  const UNNAMED_CALLEE = 0x1100n;
  const SELF_REC = 0x2000n;       // calls itself
  const LOW_SEED = 0x3000n;       // baseScore < 20, boosted during loop by CALLEE_NAME
  const BOOST_CALLEE = 0x3100n;   // matching name that boosts LOW_SEED
  const DOWNSTREAM = 0x3200n;     // caller of LOW_SEED; must NOT get CALLS_MATCH because LOW_SEED baseScore < 20

  const namesByAddr = new Map([
    [SELF_REC, 'getMoney'],
    [LOW_SEED, 'isMoneyValid'], // non-value => roleMult 0.4 => 10 points (< 20)
    [BOOST_CALLEE, 'addMoney'],
  ]);
  const symbols = {
    symbolCount: namesByAddr.size,
    functionCount: 6,
    addrs: Array.from(namesByAddr.keys()),
    names: Array.from(namesByAddr.values()),
    isFunctionStart: () => true,
    nameAt: (a) => namesByAddr.get(a) || null,
  };
  const strings = [
    { addr: 0x8000n, text: 'https://firebase.googleapis.com/coins' },
    { addr: 0x8100n, text: 'not enough coins' },
  ];
  const program = makeProgram({
    functionsReferencing: (addr) => {
      const arr = addr === 0x8000n || addr === 0x8100n
        ? [{ addr: UNNAMED_VENDOR, site: UNNAMED_VENDOR + 4n, kind: 0 }]
        : [];
      arr.complete = true;
      return arr;
    },
    calleesOf: (start) => {
      if (start === UNNAMED_VENDOR) return [{ addr: UNNAMED_CALLEE, site: start + 8n }];
      if (start === SELF_REC) return [{ addr: SELF_REC, site: start + 8n }];
      if (start === LOW_SEED) return [{ addr: BOOST_CALLEE, site: start + 8n }];
      return [];
    },
    callersOf: (addr) => {
      if (addr === SELF_REC) return [{ addr: SELF_REC, site: SELF_REC + 8n }];
      if (addr === LOW_SEED) return [{ addr: DOWNSTREAM, site: DOWNSTREAM + 4n }];
      return [];
    },
  });

  const res = rankCandidates({ goal, strings, program, symbols, limit: 20 });
  const byAddr = new Map(res.candidates.map((c) => [c.addr, c]));

  // String-tainted unnamed vendor must not propagate CALLED_BY_MATCH
  assert.equal(byAddr.has(UNNAMED_CALLEE), false, 'vendor-string-tainted seed must not propagate');

  // Self-recursion must not add CALLEE_NAME or CALLER_NAME to itself
  const selfCand = byAddr.get(SELF_REC);
  assert.ok(selfCand);
  assert.equal(selfCand.reasons.some((r) => r.code === REASON.CALLEE_NAME || r.code === REASON.CALLER_NAME), false);

  // baseScore snapshot prevents mid-loop boosted seed from propagating CALLS_MATCH
  const lowCand = byAddr.get(LOW_SEED);
  assert.ok(lowCand);
  assert.ok(lowCand.score >= 20, 'LOW_SEED was boosted >= 20 during loop via CALLEE_NAME');
  assert.equal(byAddr.has(DOWNSTREAM), false, 'LOW_SEED must not propagate based on post-boost score');
});

test('callCountOf (REASON.POPULAR) runs even when range.end is null or stats.total is 0', () => {
  const goal = goalFromPreset('hp');
  const A = 0x1000n;
  const B = 0x2000n;
  const symbols = {
    symbolCount: 2,
    functionCount: 2,
    addrs: [A, B],
    names: ['getHealth', 'setHealth'],
    isFunctionStart: () => true,
    nameAt: (a) => (a === A ? 'getHealth' : a === B ? 'setHealth' : null),
  };
  const program = makeProgram({
    functionRange: (a) => (a === A ? { start: A, end: null } : { start: B, end: B + 0x20n }),
    statsOf: () => ({ total: 0, numeric: 0, store: 0, cmp: 0, mul: 0, div: 0, fmul: 0, farith: 0, covered: true }),
    callCountOf: () => 5,
  });
  const res = rankCandidates({ goal, strings: [], program, symbols });
  assert.equal(res.candidates.length, 2);
  for (const c of res.candidates) {
    assert.equal(c.calledCount, 5);
    assert.ok(c.reasons.some((r) => r.code === REASON.POPULAR));
  }
});

test('addReason ignores non-finite or zero points and out.sort handles equal scores deterministically', () => {
  const goal = goalFromPreset('damage');
  const A = 0x1000n;
  const B = 0x2000n;
  const symbols = {
    symbolCount: 2,
    functionCount: 2,
    addrs: [B, A],
    names: ['calcDamage', 'calcDamage'],
    isFunctionStart: () => true,
    nameAt: () => 'calcDamage',
  };
  const program = makeProgram({
    statsOf: () => ({ total: 10, numeric: NaN, store: 0, cmp: 0, mul: 0, div: 0, fmul: 0, farith: 0, covered: true }),
  });
  const res = rankCandidates({ goal, strings: [], program, symbols });
  assert.equal(res.candidates.length, 2);
  assert.equal(res.candidates[0].addr, A);
  assert.equal(res.candidates[1].addr, B);
  for (const c of res.candidates) {
    assert.ok(Number.isFinite(c.score));
    assert.equal(c.reasons.some((r) => !Number.isFinite(r.points) || r.points === 0), false);
  }
});
