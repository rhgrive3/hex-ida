import assert from 'node:assert/strict';
import { autoAnalyze } from '../js/auto.js';
import { GOALS } from '../js/goals.js';

const fakeProgram = {
  functionRange: (addr) => ({ start: addr, end: addr + 4n }),
  statsOf: () => ({ total: 1, numeric: 0, store: 0, load: 0, cmp: 0 }),
  callCountOf: () => 0,
  functionsReferencing: () => Object.assign([], { complete: true }),
  callCount: 0, refCount: 0, statsComplete: true, callsCapped: false, refsCapped: false,
};
const fakeSymbols = {
  functionCount: 2, funcs: [0x1000n, 0x2000n],
  functionAt: (a) => ({ start: a, end: a + 4n }), nameAt: () => null,
};

let cancelCalls = 0;
const isCancelled = () => ++cancelCalls > GOALS.length;

const report = await autoAnalyze({
  strings: [], program: fakeProgram, symbols: fakeSymbols,
  region: { vmAddr: 0x1000n, size: 0x2000n },
  deepLimit: 0, isCancelled, analyze: async () => null,
});

assert.ok(report.notes.includes('pin-cancelled'), 'pinpoint loop must record pin-cancelled');
assert.equal(report.unexamined.length, GOALS.length,
  'cancelled pinpoint must record every remaining goal as unexamined');
assert.deepEqual(report.unexamined.map((g) => g.id).sort(), GOALS.map((g) => g.id).sort(),
  'unexamined set must equal the full goal order when cancel hits the first pinpoint iteration');
assert.equal(report.stats.goalsExamined, 0,
  'goalsExamined must count only goals actually pinpointed, not cancelled-away ones');

console.log('issue #5109 pinpoint cancel coverage: PASS');
