import assert from 'node:assert/strict';
import fs from 'node:fs';

import { fingerprintFunctionFast } from '../../../js/fingerprint/index.js';
import { matchFunctionsFast } from '../../../js/recognition/matcher.js';

const MATCH_COUNT = 1_000;
const POSTPROCESSING_START_CLOCK_CALL = 6_004;

function fingerprints(count, addressBase) {
  return Array.from({ length: count }, (_, index) => fingerprintFunctionFast({
    address: BigInt(addressBase + index * 4),
    architecture: 'arm64',
    size: 16,
    bytes: Uint8Array.from([
      0xc0, 0x03, 0x5f, 0xd6,
      index & 0xff, (index >> 8) & 0xff, (index >> 16) & 0xff, (index >> 24) & 0xff,
      1, 2, 3, 4, 5, 6, 7, 8,
    ]),
    instructions: ['ret'],
    cfg: { blocks: 1, edges: 0, exits: 1, loops: 0, calls: 0 },
    strings: [`issue-4527-unique-${index}`],
    imports: [],
    calls: [],
    constants: [],
    semantic: { operations: ['return'] },
  }));
}

const before = fingerprints(MATCH_COUNT, 0x100000);
const after = fingerprints(MATCH_COUNT, 0x900000);

// The public result remains deterministic and ordered by the solver's original
// before index, without exposing the internal ordering key.
const complete = matchFunctionsFast(before, after, { matchBudget: { maxWallMs: 10_000 } });
assert.equal(complete.truncated, false);
assert.equal(complete.matches.length, MATCH_COUNT);
assert.deepEqual(
  complete.matches.map(({ before: item }) => String(item.address)),
  before.map((item) => String(item.address)),
);

// A synthetic budget clock expires immediately after the candidate/solver
// work. Post-processing must observe it and fail closed instead of publishing
// a complete result.
let wallClockCalls = 0;
const wallExpired = matchFunctionsFast(before, after, {
  matchBudget: {
    maxWallMs: 1,
    now: () => {
      wallClockCalls++;
      return wallClockCalls > POSTPROCESSING_START_CLOCK_CALL ? 2 : 0;
    },
  },
});
assert.equal(wallExpired.truncated, true);
assert.equal(wallExpired.matching.postprocessingIncomplete, true);
assert.equal(wallExpired.matches.length, 0);
assert.match(wallExpired.matching.budget.reason, /match post-processing/);

// Abort is checked at the same post-solver boundary, not only while building
// the candidate graph or solving components.
let abortClockCalls = 0;
const abortSignal = {
  get aborted() {
    return abortClockCalls >= POSTPROCESSING_START_CLOCK_CALL;
  },
};
const aborted = matchFunctionsFast(before, after, {
  signal: abortSignal,
  matchBudget: {
    maxWallMs: 30_000,
    now: () => {
      abortClockCalls++;
      return 0;
    },
  },
});
assert.equal(aborted.truncated, true);
assert.equal(aborted.matching.postprocessingIncomplete, true);
assert.equal(aborted.matches.length, 0);
assert.match(aborted.matching.budget.reason, /match post-processing aborted/);

// Solver truncation must not short-circuit the independent post-processing
// deadline check. The original solver reason remains the first truncation
// authority while post-processing fails closed rather than publishing a
// seemingly completed partial result.
let solverTruncatedWallCalls = 0;
const solverTruncatedThenTimedOut = matchFunctionsFast(before.slice(0, 1), after.slice(0, 1), {
  matchBudget: {
    maxSolverRelaxations: 1,
    maxWallMs: 1,
    now: () => {
      solverTruncatedWallCalls++;
      return solverTruncatedWallCalls >= 9 ? 2 : 0;
    },
  },
});
assert.equal(solverTruncatedThenTimedOut.truncated, true);
assert.equal(solverTruncatedThenTimedOut.matching.postprocessingIncomplete, true);
assert.equal(solverTruncatedThenTimedOut.matches.length, 0);
assert.equal(solverTruncatedThenTimedOut.unresolvedBefore.length, 1);
assert.equal(solverTruncatedThenTimedOut.unresolvedAfter.length, 1);
assert.match(solverTruncatedThenTimedOut.matching.budget.reason, /solver relaxations exceeded 1/);
assert.ok(solverTruncatedWallCalls >= 9, 'post-processing must sample the wall clock after solver truncation');

// The same independence is required for cancellation. Before this regression,
// solverBudgetTruncated short-circuited the signal read at every later stage.
let solverTruncatedAbortReads = 0;
const lateAbortSignal = {
  get aborted() {
    solverTruncatedAbortReads++;
    return solverTruncatedAbortReads >= 8;
  },
};
const solverTruncatedThenAborted = matchFunctionsFast(before.slice(0, 1), after.slice(0, 1), {
  signal: lateAbortSignal,
  matchBudget: {
    maxSolverRelaxations: 1,
    maxWallMs: 30_000,
    now: () => 0,
  },
});
assert.equal(solverTruncatedThenAborted.truncated, true);
assert.equal(solverTruncatedThenAborted.matching.postprocessingIncomplete, true);
assert.equal(solverTruncatedThenAborted.matches.length, 0);
assert.equal(solverTruncatedThenAborted.unresolvedBefore.length, 1);
assert.equal(solverTruncatedThenAborted.unresolvedAfter.length, 1);
assert.match(solverTruncatedThenAborted.matching.budget.reason, /solver relaxations exceeded 1/);
assert.ok(solverTruncatedAbortReads >= 8, 'post-processing must sample AbortSignal after solver truncation');

// Keep the regression tied to the expensive boundary: the old comparator
// re-scanned the complete before array for every comparison.
const matcherSource = fs.readFileSync(new URL('../../../js/recognition/matcher.js', import.meta.url), 'utf8');
assert.doesNotMatch(matcherSource, /before\.findIndex/);
assert.match(matcherSource, /beforeIndex/);

console.log('issue #4527 matcher post-processing budget/order regressions: PASS');
