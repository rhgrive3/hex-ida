import assert from 'node:assert/strict';
import { autoAnalyze } from '../js/auto.js';
import { GOALS } from '../js/goals.js';

// Issue #5109: the pinpoint loop records remaining goals into
// `report.unexamined` on budget exhaustion but not on cancellation, so
// `stats.goalsExamined = goalOrder.length - unexamined.length` counts
// cancelled, never-examined goals as examined.

const fakeProgram = {
  functionRange: (addr) => ({ start: addr, end: addr + 4n }),
  statsOf: () => ({ total: 1, numeric: 0, store: 0, load: 0, cmp: 0 }),
  callCountOf: () => 0,
  functionsReferencing: () => Object.assign([], { complete: true }),
  callCount: 0,
  refCount: 0,
  statsComplete: true,
  callsCapped: false,
  refsCapped: false,
};
const fakeSymbols = { functionCount: 2, funcs: [0x1000n, 0x2000n], functionAt: (a) => ({ start: a, end: a + 4n }), nameAt: () => null };

// Cancel exactly at pinpoint start: the ranking loop calls isCancelled()
// once per goal, so the first pinpoint check is call GOALS.length + 1.
{
  let calls = 0;
  const report = await autoAnalyze({
    strings: [],
    program: fakeProgram,
    symbols: fakeSymbols,
    region: { vmAddr: 0x1000n, size: 0x2000n },
    deepLimit: 0,
    analyze: async () => null,
    isCancelled: () => (++calls > GOALS.length),
  });
  assert.ok(report.notes.includes('pin-cancelled'), 'cancellation must be recorded in notes');
  assert.equal(report.unexamined.length, GOALS.length, 'every unprocessed goal must be recorded as unexamined on cancel');
  assert.equal(report.stats.goalsExamined, 0, 'goalsExamined must count only actually examined goals');
}

// Without cancellation the examined count still covers every goal.
{
  const report = await autoAnalyze({
    strings: [],
    program: fakeProgram,
    symbols: fakeSymbols,
    region: { vmAddr: 0x1000n, size: 0x2000n },
    deepLimit: 0,
    analyze: async () => null,
    isCancelled: () => false,
  });
  assert.ok(!report.notes.includes('pin-cancelled'));
  assert.equal(report.unexamined.length, 0);
  assert.equal(report.stats.goalsExamined, GOALS.length, 'no cancel must keep the full examined count');
}

console.log('issue #5109 pinpoint cancel coverage: PASS');
