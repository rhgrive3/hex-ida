import assert from 'node:assert/strict';
import test from 'node:test';

import { planAnalysisGoal } from '../../../js/query/planner.js';

const TARGET = 0x9000n;
const weakCandidates = Array.from({ length: 48 }, (_, index) => ({
  addr: 0x100000000n + BigInt(index * 0x10),
  source: 'recognition',
  score: 10,
}));

const query = {
  action: 'increase',
  entity: { terms: ['target'] },
  context: { terms: [] },
  event: { terms: [] },
  dataflow: { shape: 'read-modify-write' },
  expect: { calls: [] },
  confident: true,
};

const tools = {
  async search_functions() { return { results: [] }; },
  async search_strings() { return { results: [] }; },
  async get_xrefs() { return { functions: [] }; },
  async get_callers() { return { results: [] }; },
  async get_callees() { return { results: [] }; },
  async get_function(address) {
    return {
      address: BigInt(address),
      name: 'candidate',
      instructions: 1,
      summary: { calls: [] },
      cost: { functions: 1, disassembly: 1 },
    };
  },
  async get_semantic_facts() { return { results: [] }; },
  async verify_field_update() { return { verified: false, evidence: [] }; },
  async find_thresholds() { return { results: [] }; },
};

test('issue-5910: cumulative evidence admits a staged candidate over the weakest stored entry', async () => {
  const result = await planAnalysisGoal(query, {
    candidateFunctions: [
      ...weakCandidates,
      { addr: TARGET, source: 'recognition', score: 6 },
      { addr: TARGET, source: 'recognition', score: 6 },
    ],
  }, {
    tools,
    // Internal planner budget is 2, so the recognition source cap remains 48.
    maxFunctions: 2,
    maxDisassembly: 16,
    maxSearchResults: 8,
    maxExpansions: 0,
    timeoutMs: 1000,
  });

  assert.equal(result.candidateSources.stored.recognition, 48);
  assert.equal(result.candidateSources.supplied.recognition, 50);
  assert.equal(result.candidates[0]?.address, TARGET);
  assert.ok(result.candidates.some((candidate) => candidate.address === TARGET));
  assert.equal(result.candidates[0]?.score, 12);
});
