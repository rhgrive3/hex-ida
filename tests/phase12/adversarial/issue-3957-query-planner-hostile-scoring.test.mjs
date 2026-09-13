import assert from 'node:assert/strict';
import test from 'node:test';

import { planAnalysisGoal } from '../../../js/query/planner.js';

const TARGET = 0x9000n;

function page(results = [], overrides = {}) {
  return {
    results,
    complete: true,
    truncated: false,
    returned: results.length,
    total: results.length,
    coverage: 1,
    reason: null,
    ...overrides,
  };
}

test('issue-3957: malformed expected-call hints are never coerced during candidate scoring', async () => {
  let coercions = 0;
  const hostileHint = {
    toString() {
      coercions += 1;
      throw new Error('hostile expected-call hint was coerced');
    },
  };
  const query = {
    action: 'send',
    entity: { terms: ['lexical-hit'] },
    context: { terms: [] },
    event: { terms: [] },
    dataflow: { shape: 'transfer' },
    expect: { calls: [hostileHint] },
    confident: true,
  };
  const tools = {
    async search_functions(term) {
      return term === 'lexical-hit'
        ? page([{ addr: TARGET, name: 'lexical_hit' }])
        : page();
    },
    async search_strings() { return page(); },
    async get_xrefs() { return { functions: [], complete: true, returned: 0, total: 0, coverage: 1 }; },
    async get_callers() { return page(); },
    async get_callees() { return page(); },
    async get_function(address) {
      return {
        address: BigInt(address),
        name: 'lexical_hit',
        instructions: 1,
        summary: { calls: [{ name: 'curl_easy_perform' }] },
        cost: { functions: 0, disassembly: 0 },
      };
    },
    async get_semantic_facts() { return page(); },
    async verify_field_update() { return { verified: false, evidence: [] }; },
    async find_thresholds() { return page(); },
  };

  const result = await planAnalysisGoal(query, {}, {
    tools,
    maxFunctions: 8,
    maxDisassembly: 64,
    maxSearchResults: 8,
    maxExpansions: 1,
    timeoutMs: 2_000,
  });

  assert.equal(coercions, 0, 'structured expected-call hints must never reach String() coercion');
  assert.ok(result.candidates.some((row) => row.address === TARGET), 'lexical candidate must reach analyzeCandidates');
  const report = result.searchCompleteness.reports.find((row) => row.tool === 'expected_call_hints');
  assert.ok(report, 'malformed hint must remain visible in fail-closed completeness accounting');
  assert.equal(report.reason, 'malformed-expected-call-hint');
  assert.equal(result.completeness.searchComplete, false);
});
