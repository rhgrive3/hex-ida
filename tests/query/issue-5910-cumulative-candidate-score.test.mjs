import assert from 'node:assert/strict';
import test from 'node:test';

import { planAnalysisGoal } from '../../js/query/planner.js';

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

  const stagedTarget = 0x9100n;
  const stagedResult = await planAnalysisGoal(query, {
    candidateFunctions: [
      ...weakCandidates,
      { addr: stagedTarget, source: 'recognition', score: 15 },
      ...Array.from({ length: 47 }, (_, index) => ({
        addr: 0x200000000n + BigInt(index * 0x10),
        source: 'recognition',
        score: 20,
      })),
      // This lower-scoring arrival must not evict the stronger staged entry.
      { addr: 0x9200n, source: 'recognition', score: 5 },
      { addr: stagedTarget, source: 'recognition', score: 10 },
    ],
  }, {
    tools,
    maxFunctions: 2,
    maxDisassembly: 16,
    maxSearchResults: 8,
    maxExpansions: 0,
    timeoutMs: 1000,
  });

  assert.equal(stagedResult.candidateSources.stored.recognition, 48);
  assert.ok(stagedResult.candidates.some((candidate) => candidate.address === stagedTarget));
  assert.equal(stagedResult.candidates.find((candidate) => candidate.address === stagedTarget)?.score, 25);
});

test('issue-5910: a full staged pool aggregates a candidate before top-k admission', async () => {
  const stored = Array.from({ length: 48 }, (_, index) => ({
    addr: 0xa0000000n + BigInt(index * 0x10),
    source: 'recognition',
    score: 100,
  }));
  const staged = Array.from({ length: 48 }, (_, index) => ({
    addr: 0xb0000000n + BigInt(index * 0x10),
    source: 'recognition',
    score: 45,
  }));
  const target = 0x9300n;
  const options = {
    tools,
    maxFunctions: 2,
    maxDisassembly: 16,
    maxSearchResults: 8,
    maxExpansions: 0,
    timeoutMs: 1000,
  };

  const ordered = await planAnalysisGoal(query, {
    candidateFunctions: [
      ...stored,
      ...staged,
      { addr: target, source: 'recognition', score: 40 },
      { addr: target, source: 'recognition', score: 40 },
      { addr: target, source: 'recognition', score: 40 },
    ],
  }, options);
  const orderedTarget = ordered.candidates.find((candidate) => candidate.address === target);
  assert.equal(ordered.candidateSources.stored.recognition, 48);
  assert.equal(orderedTarget?.score, 120,
    '40 + 40 + 40 must be aggregated before the full-pool top-k comparison');

  const permutedRows = [];
  for (let index = 0; index < 48; index++) {
    permutedRows.push(stored[index], staged[index]);
    if (index < 3) {
      permutedRows.push(
        { addr: target, source: 'recognition', score: 40 },
      );
    }
  }
  const permuted = await planAnalysisGoal(query, {
    candidateFunctions: permutedRows,
  }, options);
  const permutedTarget = permuted.candidates.find((candidate) => candidate.address === target);
  assert.equal(permuted.candidateSources.stored.recognition, 48);
  assert.equal(permutedTarget?.score, 120,
    'the same evidence multiset must be arrival-order invariant');

  const belowThreshold = await planAnalysisGoal(query, {
    candidateFunctions: [
      ...stored,
      ...staged,
      { addr: 0x9400n, source: 'recognition', score: 4 },
      { addr: 0x9400n, source: 'recognition', score: 4 },
    ],
  }, options);
  assert.equal(
    belowThreshold.candidates.some((candidate) => candidate.address === 0x9400n),
    false,
    'an aggregate below the weakest staged score must not promote',
  );
  assert.equal(belowThreshold.candidateSources.stored.recognition, 48);
});
