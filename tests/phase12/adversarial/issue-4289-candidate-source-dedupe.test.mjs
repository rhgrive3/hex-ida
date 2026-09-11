import assert from 'node:assert/strict';
import test from 'node:test';

import { planAnalysisGoal } from '../../../js/query/planner.js';

const QUERY = Object.freeze({
  action: 'read',
  entity: { terms: [] },
  context: { terms: [] },
  event: { terms: [] },
  expect: { calls: [] },
  confident: true,
});

function complete(results = []) {
  return { results, total: results.length, returned: results.length, complete: true, coverage: 1 };
}

const tools = {
  async get_function(address) {
    return {
      address: BigInt(address),
      name: `fn_${BigInt(address).toString(16)}`,
      instructions: 1,
      summary: { calls: [] },
      cost: { functions: 1, disassembly: 1 },
    };
  },
  async get_semantic_facts() { return complete([]); },
};

function plan(candidateFunctions, overrides = {}) {
  return planAnalysisGoal(QUERY, { candidateFunctions }, {
    tools,
    maxFunctions: 8,
    maxDisassembly: 128,
    maxSearchResults: 8,
    maxExpansions: 0,
    timeoutMs: 2_000,
    ...overrides,
  });
}

test('issue-4289: duplicate priors are one supplied candidate while preserving merged evidence', async () => {
  const result = await plan([
    { address: 0x1000n, source: 'recognition-a', score: 3 },
    { address: '0x1000', source: 'recognition-b', score: 2 },
  ]);

  assert.equal(result.candidateSources.supplied.recognition, 1);
  assert.equal(result.candidateSources.stored.recognition, 1);
  assert.deepEqual(result.candidateSources.completeness.bySource.recognition, {
    supplied: 1,
    stored: 1,
    complete: true,
    coverage: 1,
  });
  assert.equal(result.completeness.complete, true);
  assert.equal(result.missingEvidence.includes('candidate-source-limit'), false);
  assert.equal(result.best?.address, 0x1000n);
  assert.equal(result.best?.score, 5);
  assert.deepEqual(result.best?.sources.sort(), ['recognition-a', 'recognition-b']);
});

test('issue-4289 adversarial: duplicates at the exact pool cap do not invent source truncation', async () => {
  const stored = Array.from({ length: 48 }, (_, index) => ({
    address: 0x200000n + BigInt(index * 0x10),
    source: `recognition-${index}`,
    score: 10,
  }));
  const firstAddress = stored[0].address;
  const result = await plan([
    ...stored,
    { address: Number(firstAddress), source: 'recognition-number-alias', score: 1 },
    { address: firstAddress.toString(), source: 'recognition-decimal-alias', score: 1 },
  ], {
    // Keep the recognition source cap at 48; only the planner shortlist is smaller.
    maxFunctions: 2,
  });

  const recognition = result.candidateSources.completeness.bySource.recognition;
  assert.equal(result.candidateSources.supplied.recognition, 48);
  assert.equal(result.candidateSources.stored.recognition, 48);
  assert.equal(recognition.complete, true);
  assert.equal(recognition.coverage, 1);
  assert.equal(result.missingEvidence.includes('candidate-source-limit'), false);
  assert.ok(result.missingEvidence.includes('planner-shortlist-limit'));
  assert.equal(result.candidates[0]?.address, firstAddress);
  assert.equal(result.candidates[0]?.score, 12, 'duplicate evidence must still accumulate at the cap');
});

test('issue-4289: duplicate evidence plus a real cap loss uses unique-candidate coverage', async () => {
  const stored = Array.from({ length: 48 }, (_, index) => ({
    address: 0x200000n + BigInt(index * 0x10),
    source: `recognition-${index}`,
    score: 10,
  }));
  const overflow = 0x300000n;
  const result = await plan([
    ...stored,
    { address: overflow, source: 'overflow-a', score: 1 },
    { address: overflow, source: 'overflow-b', score: 1 },
  ], {
    // Internal planner budget remains 2, so the recognition source cap is 48.
    maxFunctions: 2,
  });

  const recognition = result.candidateSources.completeness.bySource.recognition;
  assert.equal(result.candidateSources.stored.recognition, 48);
  assert.equal(result.candidateSources.supplied.recognition, 49);
  assert.equal(recognition.supplied, 49);
  assert.equal(recognition.stored, 48);
  assert.equal(recognition.complete, false);
  assert.equal(recognition.coverage, 48 / 49);
  assert.equal(result.completeness.candidateSourceCoverage, 48 / 49);
  assert.ok(result.missingEvidence.includes('candidate-source-limit'));
});

test('issue-4289: malformed prior identities remain untrusted loss instead of disappearing from completeness', async () => {
  let coercions = 0;
  const malformed = {
    [Symbol.toPrimitive]() {
      coercions += 1;
      return '4096';
    },
  };
  const result = await plan([{ address: malformed, source: 'recognition', score: 1 }]);

  assert.equal(coercions, 0, 'candidate identity accounting must not invoke caller coercion hooks');
  assert.equal(result.candidateSources.supplied.recognition, 1);
  assert.equal(result.candidateSources.stored.recognition, 0);
  assert.equal(result.candidateSources.completeness.bySource.recognition.complete, false);
  assert.equal(result.completeness.complete, false);
  assert.ok(result.missingEvidence.includes('candidate-source-limit'));
  assert.deepEqual(result.candidates, []);
});
