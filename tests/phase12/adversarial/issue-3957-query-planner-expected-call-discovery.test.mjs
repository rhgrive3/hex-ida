import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSemanticModel } from '../../../js/blocks.js';
import { createHexToolRegistry } from '../../../js/ai/tools/registry-base.js';
import { planAnalysisGoal } from '../../../js/query/planner.js';

const API = 0x7000n;
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

function queryFor(action, expectedCall) {
  return {
    action,
    entity: { terms: ['unrelated-lexical-term'] },
    context: { terms: [] },
    event: { terms: [] },
    dataflow: { shape: action === 'decide' ? 'produce' : 'transfer' },
    expect: { calls: [expectedCall] },
    confident: true,
  };
}

function directTools(expectedCall, { callerPage = page([{ addr: TARGET }]) } = {}) {
  return {
    async search_functions(term) {
      return term === expectedCall
        ? page([{ addr: API, name: `_${expectedCall}` }])
        : page();
    },
    async search_strings() { return page(); },
    async get_xrefs() { return { functions: [], complete: true, returned: 0, total: 0, coverage: 1 }; },
    async get_callers(address) {
      const at = BigInt(address);
      if (at === API) return callerPage;
      return page();
    },
    async get_callees() { return page(); },
    async get_function(address) {
      return {
        address: BigInt(address),
        name: `sub_${BigInt(address).toString(16)}`,
        instructions: 1,
        summary: { calls: [{ name: expectedCall }] },
        cost: { functions: 0, disassembly: 0 },
      };
    },
    async get_semantic_facts() { return page(); },
    async verify_field_update() { return { verified: false, evidence: [] }; },
    async find_thresholds() { return page(); },
  };
}

function options(tools) {
  return {
    tools,
    maxFunctions: 8,
    maxDisassembly: 64,
    maxSearchResults: 8,
    maxExpansions: 1,
    timeoutMs: 2_000,
  };
}

for (const [action, expectedCall] of [
  ['decide', 'arc4random_uniform'],
  ['send', 'curl_easy_perform'],
  ['save', 'sqlite3_step'],
]) {
  test(`issue-3957: ${action} expected-call caller is discovered before shortlist without lexical/string hits`, async () => {
    const result = await planAnalysisGoal(queryFor(action, expectedCall), {}, options(directTools(expectedCall)));
    const candidate = result.candidates.find((row) => row.address === TARGET);
    assert.ok(candidate, `${expectedCall} caller must enter candidate discovery`);
    assert.ok(candidate.sources.includes(`expected-call:${expectedCall}`));
    assert.ok(candidate.graphScore > 0);
  });
}

test('issue-3957: expected-call caller incompleteness propagates into planner completeness and coverage', async () => {
  const expectedCall = 'arc4random_uniform';
  const result = await planAnalysisGoal(queryFor('decide', expectedCall), {}, options(directTools(expectedCall, {
    callerPage: page([{ addr: TARGET }], {
      complete: false,
      truncated: true,
      returned: 1,
      total: 2,
      coverage: 0.5,
      reason: 'query-limit',
    }),
  })));

  const candidate = result.candidates.find((row) => row.address === TARGET);
  assert.ok(candidate);
  assert.equal(result.completeness.complete, false);
  assert.equal(result.completeness.searchComplete, false);
  assert.ok(result.missingEvidence.includes('search-incomplete'));
  assert.equal(candidate.discoveryCoverage, 0.5);
  const report = result.searchCompleteness.reports.find((row) => row.term === `expected-call-caller:${expectedCall}@${API}`);
  assert.ok(report);
  assert.equal(report.complete, false);
  assert.equal(report.reason, 'query-limit');
});

function registryPlannerTools(registry) {
  const execute = async (name, input) => (await registry.execute(name, input, { scope: 'binary' })).result;
  return {
    search_functions: (query, { limit } = {}) => execute('search_functions', { query, limit }),
    search_strings: (query, { limit } = {}) => execute('search_strings', { query, limit }),
    get_xrefs: (address, { limit } = {}) => execute('get_xrefs', { address: `0x${BigInt(address).toString(16)}`, limit }),
    get_callers: (address, { limit } = {}) => execute('get_callers', { address: `0x${BigInt(address).toString(16)}`, limit }),
    get_callees: (address, { limit } = {}) => execute('get_callees', { address: `0x${BigInt(address).toString(16)}`, limit }),
    get_function: async (address) => {
      const before = registry.analysisStats?.disassembly || 0;
      const result = await execute('get_function', { address: `0x${BigInt(address).toString(16)}` });
      const after = registry.analysisStats?.disassembly || before;
      return { ...result, cost: { ...(result.cost || {}), disassembly: Math.max(0, after - before) } };
    },
    get_semantic_facts: (address, { limit } = {}) => execute('get_semantic_facts', { functionAddress: `0x${BigInt(address).toString(16)}`, limit }),
    find_thresholds: (address, { limit } = {}) => execute('find_thresholds', {
      functionAddress: `0x${BigInt(address).toString(16)}`,
      ...(limit == null ? {} : { limit }),
    }),
    verify_field_update: (address, field, { limit, pathLimit } = {}) => execute('verify_field_update', {
      functionAddress: `0x${BigInt(address).toString(16)}`,
      field,
      ...(limit == null ? {} : { limit }),
      ...(pathLimit == null ? {} : { pathLimit }),
    }),
  };
}

test('issue-3957: actual createHexToolRegistry path preserves expected-call discovery', async () => {
  const expectedCall = 'arc4random_uniform';
  const context = {
    binaryId: 'issue-3957',
    revision: '1',
    async searchFunctions(query) {
      return query === expectedCall ? [{ addr: API, name: `_${expectedCall}` }] : [];
    },
    async searchStrings() { return []; },
    program: {
      functionRange(address) {
        const start = BigInt(address);
        return { start, end: start + 4n };
      },
      callersOf(address) {
        return BigInt(address) === API
          ? { results: [{ addr: TARGET }], complete: true, total: 1 }
          : { results: [], complete: true, total: 0 };
      },
      calleesOf() { return { results: [], complete: true, total: 0 }; },
      refSitesTo() { return { results: [], complete: true, total: 0 }; },
      functionsReferencing() { return { results: [], complete: true, total: 0 }; },
    },
    async analyze(address) {
      return buildSemanticModel([{ mn: 'ret', ops: '', row: 0, address: BigInt(address) }], [], []);
    },
  };
  const registry = createHexToolRegistry(context, { maxFunctions: 8, maxDisassembly: 64 });
  const result = await planAnalysisGoal(queryFor('decide', expectedCall), {}, options(registryPlannerTools(registry)));

  assert.ok(result.candidates.some((row) => row.address === TARGET));
  assert.ok(registry.accounting.calls > 0);
});

test('issue-3957: expected-call hint budget is bounded and reports omitted hint coverage', async () => {
  const calls = Array.from({ length: 9 }, (_, index) => `expected_api_${index}`);
  let expectedSearches = 0;
  const tools = {
    ...directTools('not-used'),
    async search_functions(term) {
      if (calls.includes(term)) expectedSearches += 1;
      return page();
    },
  };
  const query = queryFor('send', calls[0]);
  query.expect.calls = calls;
  const result = await planAnalysisGoal(query, {}, options(tools));

  assert.equal(expectedSearches, 8);
  assert.equal(result.completeness.complete, false);
  const report = result.searchCompleteness.reports.find((row) => row.tool === 'expected_call_hints');
  assert.ok(report);
  assert.equal(report.reason, 'expected-call-hint-limit');
  assert.equal(report.returned, 8);
  assert.equal(report.total, 9);
  assert.equal(report.coverage, 8 / 9);
});

test('issue-3957: expected-call discovery remains an independent pool and preserves lexical candidates', async () => {
  const expectedCall = 'arc4random_uniform';
  const lexical = 0xa000n;
  const base = directTools(expectedCall);
  const tools = {
    ...base,
    async search_functions(term) {
      if (term === 'unrelated-lexical-term') return page([{ addr: lexical, name: 'unrelated_lexical_term' }]);
      return base.search_functions(term);
    },
  };
  const result = await planAnalysisGoal(queryFor('decide', expectedCall), {}, {
    ...options(tools),
    maxFunctions: 6,
  });

  assert.ok(result.candidates.some((row) => row.address === lexical), 'lexical candidate must remain independently eligible');
  assert.ok(result.candidates.some((row) => row.address === TARGET), 'expected-call caller must remain independently eligible');
  assert.ok(result.candidateSources.quotas.lexical > 0);
  assert.ok(result.candidateSources.quotas.graph > 0);
});

test('issue-3957 adversarial: unresolved expected-call names never fabricate a callee address', async () => {
  const expectedCall = 'arc4random_uniform';
  let callerQueries = 0;
  const base = directTools(expectedCall);
  const tools = {
    ...base,
    async search_functions(term) {
      if (term === expectedCall) return page([{ name: `_${expectedCall}` }]);
      return page();
    },
    async get_callers() {
      callerQueries += 1;
      return page([{ addr: TARGET }]);
    },
  };
  const result = await planAnalysisGoal(queryFor('decide', expectedCall), {}, options(tools));

  assert.equal(callerQueries, 0);
  assert.equal(result.candidates.some((row) => row.address === TARGET), false);
  assert.ok(result.missingEvidence.includes('no-candidate-function'));
});

test('issue-3957 adversarial: structured expected-call hints are not coerced into symbol queries', async () => {
  let coercions = 0;
  const hostile = {
    toString() { coercions += 1; return 'arc4random_uniform'; },
  };
  let expectedSearches = 0;
  const tools = {
    ...directTools('arc4random_uniform'),
    async search_functions(term) {
      if (term === 'arc4random_uniform') expectedSearches += 1;
      return page();
    },
  };
  const query = queryFor('decide', 'arc4random_uniform');
  query.expect.calls = [hostile];
  const result = await planAnalysisGoal(query, {}, options(tools));

  assert.equal(coercions, 0);
  assert.equal(expectedSearches, 0);
  assert.equal(result.completeness.complete, false);
  const report = result.searchCompleteness.reports.find((row) => row.tool === 'expected_call_hints');
  assert.equal(report?.reason, 'malformed-expected-call-hint');
});
