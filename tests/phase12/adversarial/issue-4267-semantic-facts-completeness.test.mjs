import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSemanticModel } from '../../../js/blocks.js';
import { irFor } from '../../../js/ir.js';
import { FACT } from '../../../js/semantic.js';
import { createAgentTools } from '../../../js/agent/tools.js';
import { planAnalysisGoal } from '../../../js/query/planner.js';

const QUERY = {
  action: 'read',
  entity: { terms: [] },
  context: { terms: [] },
  event: { terms: [] },
  expect: { calls: [] },
  confident: true,
};

const READ_FACT = Object.freeze({ kind: FACT.READ, evidence: [] });

function toolsWithFacts(factsByAddress) {
  return {
    async get_function(address) {
      return {
        address: BigInt(address),
        name: `fn_${BigInt(address).toString(16)}`,
        summary: { calls: [] },
        cost: { disassembly: 0 },
      };
    },
    async get_semantic_facts(address) {
      const entry = factsByAddress.get(BigInt(address).toString());
      assert.ok(entry, `unexpected semantic-facts request for ${address}`);
      return typeof entry === 'function' ? entry() : entry;
    },
  };
}

function plan(candidateAddresses, factsByAddress) {
  return planAnalysisGoal(QUERY, {
    candidateFunctions: candidateAddresses.map((address, index) => ({
      address,
      source: `semantic-prior-${index}`,
      score: candidateAddresses.length - index,
    })),
  }, {
    tools: toolsWithFacts(factsByAddress),
    maxFunctions: 48,
    maxDisassembly: 128,
    maxSearchResults: 8,
    maxExpansions: 0,
    timeoutMs: 2_000,
  });
}

function completeFacts(results = [READ_FACT]) {
  return {
    results,
    completeness: { complete: true, coverage: 1, reason: null, returned: results.length, total: results.length },
    truncated: false,
  };
}

test('issue-4267: partial semantic facts downgrade planner completeness and retain diagnostics', async () => {
  const address = 0x1000n;
  const result = await plan([address], new Map([[address.toString(), {
    results: [READ_FACT],
    completeness: { complete: false, coverage: 0.5, reason: 'result-limit', returned: 1, total: 2 },
    truncated: true,
  }]]));

  assert.equal(result.completeness.complete, false);
  assert.equal(result.completeness.partial, true);
  assert.equal(result.partial, true);
  assert.equal(result.completeness.reason, 'semantic-facts-incomplete');
  assert.ok(result.missingEvidence.includes('semantic-facts-incomplete'));
  assert.equal(result.candidates[0].complete, false, 'candidate global completeness must not contradict local semantic incompleteness');
  assert.equal(result.candidates[0].semanticCompleteness.complete, false);
  assert.equal(result.candidates[0].semanticCompleteness.coverage, 0.5);
  assert.equal(result.candidates[0].semanticCompleteness.reason, 'result-limit');

  assert.equal(result.semanticCompleteness.complete, false);
  assert.deepEqual(result.semanticCompleteness.incomplete.map((entry) => ({
    address: entry.address,
    coverage: entry.coverage,
    reason: entry.reason,
  })), [{ address, coverage: 0.5, reason: 'result-limit' }]);
});

test('issue-4267: legacy truncated semantic-facts shape also fails closed', async () => {
  const address = 0x2000n;
  const result = await plan([address], new Map([[address.toString(), {
    results: [READ_FACT],
    truncated: true,
    coverage: 0.25,
    reason: 'legacy-cap',
  }]]));

  assert.equal(result.completeness.complete, false);
  assert.equal(result.candidates[0].semanticCompleteness.complete, false);
  assert.equal(result.candidates[0].semanticCompleteness.coverage, 0.25);
  assert.equal(result.candidates[0].semanticCompleteness.reason, 'legacy-cap');
  assert.ok(result.missingEvidence.includes('semantic-facts-incomplete'));
});

test('issue-4267: one partial semantic corpus keeps a multi-candidate plan partial', async () => {
  const completeAddress = 0x3000n;
  const partialAddress = 0x4000n;
  const result = await plan([completeAddress, partialAddress], new Map([
    [completeAddress.toString(), completeFacts()],
    [partialAddress.toString(), {
      results: [READ_FACT],
      completeness: { complete: false, coverage: 0.75, reason: 'producer-partial', returned: 1, total: null },
    }],
  ]));

  assert.equal(result.completeness.complete, false);
  assert.equal(result.semanticCompleteness.complete, false);
  assert.deepEqual(result.semanticCompleteness.incomplete.map((entry) => entry.address), [partialAddress]);
  assert.equal(result.semanticCompleteness.incomplete[0].reason, 'producer-partial');
  assert.equal(result.semanticCompleteness.incomplete[0].coverage, 0.75);
});

test('issue-4267: complete semantic facts preserve complete planning and ranking', async () => {
  const first = 0x5000n;
  const second = 0x6000n;
  const result = await plan([first, second], new Map([
    [first.toString(), completeFacts()],
    [second.toString(), completeFacts()],
  ]));

  assert.equal(result.completeness.complete, true);
  assert.equal(result.partial, false);
  assert.equal(result.semanticCompleteness.complete, true);
  assert.deepEqual(result.semanticCompleteness.incomplete, []);
  assert.equal(result.best.address, first);
  assert.equal(result.best.semanticCompleteness.complete, true);
  assert.equal(result.missingEvidence.includes('semantic-facts-incomplete'), false);
});

test('issue-4267 adversarial: contradictory complete/truncated metadata cannot restore semantic authority', async () => {
  const address = 0x7000n;
  const result = await plan([address], new Map([[address.toString(), {
    results: [READ_FACT],
    completeness: { complete: true, coverage: 1, reason: null, returned: 1, total: 1 },
    complete: true,
    truncated: true,
    reason: 'producer-truncated',
  }]]));

  assert.equal(result.completeness.complete, false);
  assert.equal(result.candidates[0].semanticCompleteness.complete, false);
  assert.ok(result.missingEvidence.includes('semantic-facts-incomplete'));
});

test('issue-4267 adversarial: semantic completeness metadata is snapshotted once and malformed values fail closed', async () => {
  const address = 0x8000n;
  let completeReads = 0;
  const semanticResult = { results: [READ_FACT], coverage: 1, returned: 1, total: 1 };
  Object.defineProperty(semanticResult, 'complete', {
    enumerable: true,
    get() {
      completeReads += 1;
      return completeReads === 1 ? 'false' : true;
    },
  });

  const result = await plan([address], new Map([[address.toString(), semanticResult]]));
  assert.equal(completeReads, 1, 'authority-bearing completeness must not be re-read after validation');
  assert.equal(result.completeness.complete, false);
  assert.equal(result.candidates[0].semanticCompleteness.complete, false);
  assert.ok(result.candidates[0].semanticCompleteness.coverage < 1);
});


test('issue-4267: first-party createAgentTools semantic truncation reaches planner completeness', async () => {
  const address = 0x9000n;
  const model = buildSemanticModel([{ mn: 'ret', ops: '', row: 0, address }], [], []);
  irFor(model).truncated = true;
  const tools = createAgentTools({ analyze: async () => model, candidateFunctions: [address] }, { maxFunctions: 4 });
  const result = await planAnalysisGoal(QUERY, {
    candidateFunctions: [{ address, source: 'first-party-semantic', score: 1 }],
  }, {
    tools,
    maxFunctions: 4,
    maxDisassembly: 128,
    maxSearchResults: 8,
    maxExpansions: 0,
    timeoutMs: 2_000,
  });

  assert.equal(result.completeness.complete, false);
  assert.ok(result.missingEvidence.includes('semantic-facts-incomplete'));
  assert.equal(result.candidates[0].semanticCompleteness.complete, false);
  assert.equal(result.candidates[0].semanticCompleteness.reason, 'semantic-ir-truncated');
  assert.equal(result.semanticCompleteness.incomplete[0].address, address);
});
