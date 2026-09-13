import assert from 'node:assert/strict';

import { goalFromPreset } from '../../../js/goals.js';
import { rankCandidates } from '../../../js/rank.js';

const START = 0x1000n;
const END = 0x100cn;

function symbols() {
  return {
    symbolCount: 1,
    functionCount: 1,
    addrs: [START],
    names: ['hp'],
    isFunctionStart(address) { return address === START; },
    nameAt(address) { return address === START ? 'hp' : null; },
  };
}

function program() {
  return {
    callCount: 0,
    refCount: 0,
    callsCapped: false,
    functionRange(address) { return address === START ? { start: START, end: END } : null; },
    statsOf(start, end) {
      assert.equal(start, START);
      assert.equal(end, END);
      return { total: 3, numeric: 1, store: 1, cmp: 1, mul: 0, div: 0, fmul: 0, farith: 0, covered: true };
    },
    callCountOf() { return 0; },
    callersOf() { return []; },
    calleesOf() { return []; },
    functionsReferencing() { return []; },
  };
}

function rank(limit) {
  return rankCandidates({
    goal: goalFromPreset('hp'),
    strings: [],
    program: program(),
    symbols: symbols(),
    limit,
  });
}

{
  const full = rank(undefined);
  assert.equal(full.candidates.length, 1, 'default limit keeps full coverage');
  const with40 = rank(40);
  assert.equal(with40.total, full.total);
  assert.deepEqual(with40.candidates.map((c) => [String(c.addr), c.score, c.reasons.length]),
    full.candidates.map((c) => [String(c.addr), c.score, c.reasons.length]),
    'valid numeric limit must not change scoring');
  assert.equal(rank(1).candidates.length, 1, 'valid number limit 1 keeps one candidate');
  assert.equal(rank(2).candidates.length, 1, 'valid number limit above coverage keeps everything');
}

{
  assert.equal(rank(0).candidates.length, 0, 'limit 0 selects no candidates');
  assert.equal(rank(-1).candidates.length, 0, 'negative limit fails closed to zero coverage');
  assert.equal(rank(0.5).candidates.length, 0, 'fractional positive limit keeps existing floor policy');
  assert.equal(rank(NaN).candidates.length, 0, 'NaN limit fails closed');
  assert.equal(rank(Infinity).candidates.length, 0, 'Infinity limit fails closed');
  assert.equal(rank(null).candidates.length, 0, 'null limit keeps the invalid-to-zero policy');
}

{
  const structuredLimits = [['1'], '1', ['2', '3'], true, '2', {}, [], { valueOf: () => 1 }];
  for (const limit of structuredLimits) {
    const result = rank(limit);
    assert.equal(result.candidates.length, 0,
      `structured limit ${JSON.stringify(limit)} must not be promoted to a coverage budget`);
  }
}

console.log('issue-4347 structured ranking limit fail-closed: PASS');
