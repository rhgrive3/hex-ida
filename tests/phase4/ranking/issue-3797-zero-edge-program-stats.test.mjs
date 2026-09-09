import assert from 'node:assert/strict';

import { goalFromPreset } from '../../../js/goals.js';
import { rankCandidates, REASON } from '../../../js/rank.js';

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

function program({ callCount = 0, refCount = 0 } = {}) {
  return {
    callCount,
    refCount,
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

{
  const result = rankCandidates({
    goal: goalFromPreset('hp'),
    strings: [],
    program: program(),
    symbols: symbols(),
  });
  assert.equal(result.notes.includes('no-program-index'), false);
  assert.equal(result.candidates.length, 1);
  const codes = result.candidates[0].reasons.map((reason) => reason.code);
  assert.ok(codes.includes(REASON.NAME), codes.join(','));
  assert.ok(codes.includes(REASON.NUMERIC), codes.join(','));
  assert.ok(codes.includes(REASON.STORE), codes.join(','));
  assert.ok(codes.includes(REASON.COMPARE), codes.join(','));
  assert.deepEqual(result.candidates[0].stats, {
    total: 3, numeric: 1, store: 1, cmp: 1,
    mul: 0, div: 0, fmul: 0, farith: 0, covered: true,
  });
}

{
  const result = rankCandidates({
    goal: goalFromPreset('hp'),
    strings: [],
    program: null,
    symbols: symbols(),
  });
  assert.equal(result.notes.includes('no-program-index'), true);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].reasons.some((reason) => reason.code === REASON.NUMERIC), false);
}

{
  const result = rankCandidates({
    goal: goalFromPreset('hp'),
    strings: [],
    program: program({ callCount: 1 }),
    symbols: symbols(),
  });
  const codes = result.candidates[0].reasons.map((reason) => reason.code);
  assert.equal(result.notes.includes('no-program-index'), false);
  assert.ok(codes.includes(REASON.NUMERIC));
  assert.ok(codes.includes(REASON.STORE));
  assert.ok(codes.includes(REASON.COMPARE));
}

console.log('issue-3797 zero-edge ProgramIndex stats: PASS');
