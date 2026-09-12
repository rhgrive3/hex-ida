import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SYMMETRIC_MATCH_BUDGET } from '../js/diff/symmetric-workspace-runtime.js';
import { createMatchBudget } from '../js/recognition/match-budget.js';

// #5452: the symmetric workspace runtime widens the matcher budget for full
// symmetric diffs. It passed `maxEdges:300000`, but `createMatchBudget()`
// only honors `maxCandidateEdges`, so the widened edge budget was silently
// dropped and the default 100k truncation stayed in force. The shipped
// default must produce its intended limits through the real budget
// constructor.

test('5452: symmetric default budget keys are honored by createMatchBudget', () => {
  const snapshot = createMatchBudget(DEFAULT_SYMMETRIC_MATCH_BUDGET).snapshot();
  assert.equal(snapshot.maxCandidateEdges, 300000, 'the intended 300k candidate-edge budget must take effect');
  assert.equal(snapshot.maxCandidateEvaluations, 1500000);
  assert.equal(snapshot.maxComponentNodes, 4096);
  assert.equal(snapshot.maxComponentEdges, 65536);
});

test('5452: shipped default carries no dead budget keys', () => {
  const KNOWN = new Set(Object.keys(createMatchBudget({}).snapshot()));
  for (const key of Object.keys(DEFAULT_SYMMETRIC_MATCH_BUDGET)) {
    assert.ok(KNOWN.has(key), `${key} must be a recognized match-budget key`);
  }
});
