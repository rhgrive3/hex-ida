import assert from 'node:assert/strict';
import { fingerprintFunctionFast } from '../js/fingerprint/index.js';
import { matchFunctionsFast } from '../js/recognition/matcher.js';

function makeFunctions(count, addressBase) {
  return Array.from({ length: count }, (_unused, index) => fingerprintFunctionFast({
    address: BigInt(addressBase) + BigInt(index * 4),
    architecture: 'arm64',
    size: 4,
    bytes: Uint8Array.from([0xc0, 0x03, 0x5f, 0xd6]),
    instructions: ['ret'],
    cfg: { blocks: 1, edges: 0, exits: 1, loops: 0, calls: 0 },
    strings: [`postprocess-budget-${index}`],
    imports: [],
    calls: [],
    constants: [],
    semantic: { operations: ['return'] },
  }));
}

const before = makeFunctions(8, 0x1000);
const after = makeFunctions(8, 0x10000);

// Solver output is already deterministic in (before index, after index) order;
// post-processing must retain that order without a comparator search.
const complete = matchFunctionsFast(before, after, {
  matchBudget: { maxPostprocessWork: 10_000, maxWallMs: 10_000 },
});
assert.equal(complete.truncated, false);
assert.deepEqual(complete.matches.map((match) => match.before.address), before.map((fn) => fn.address));
assert.deepEqual(complete.matches.map((match) => match.after.address), after.map((fn) => fn.address));
assert.ok(complete.matching.budget.postprocessWork > 0);

// Wall-clock expiry is checked even when the post-processing loop is shorter
// than the coarse-grained checks used by candidate generation.
let wallNowCalls = 0;
const wallLimited = matchFunctionsFast(before, after, {
  matchBudget: {
    maxPostprocessWork: 10_000,
    maxWallMs: 10,
    now: () => {
      wallNowCalls++;
      return wallNowCalls <= 43 ? 0 : 100;
    },
  },
});
assert.equal(wallLimited.truncated, true);
assert.equal(wallLimited.matching.postprocessingIncomplete, true);
assert.equal(wallLimited.matches.length, 0);
assert.match(wallLimited.matching.budget.reason, /match post-processing exceeded 10 ms/);

// A post-processing work cap must not leak a prefix of apparently valid
// matches. The result is fail-closed and identifies the incomplete stage.
const workLimited = matchFunctionsFast(before, after, {
  matchBudget: { maxPostprocessWork: 1, maxWallMs: 10_000 },
});
assert.equal(workLimited.truncated, true);
assert.equal(workLimited.ambiguous, true);
assert.equal(workLimited.matching.postprocessingIncomplete, true);
assert.equal(workLimited.matches.length, 0);
assert.equal(workLimited.deleted.length, before.length);
assert.equal(workLimited.new.length, after.length);
assert.match(workLimited.matching.budget.reason, /post-processing work exceeded 1/);

// Abort is checked during post-processing, after candidate generation and
// solving have already succeeded.
const controller = new AbortController();
let nowCalls = 0;
const aborted = matchFunctionsFast(before, after, {
  matchBudget: {
    maxPostprocessWork: 10_000,
    maxWallMs: 10_000,
    signal: controller.signal,
    now: () => {
      nowCalls++;
      // This fixture reaches the post-processing wall check after the
      // preprocessing, candidate, and solver checks above it.
      if (nowCalls === 43) controller.abort();
      return 0;
    },
  },
});
assert.equal(aborted.truncated, true);
assert.equal(aborted.matching.postprocessingIncomplete, true);
assert.equal(aborted.matches.length, 0);
assert.match(aborted.matching.budget.reason, /post-processing aborted/);

console.log('issue #4527 matcher post-process budget: PASS');
