import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSemanticModel } from '../../../js/blocks.js';
import { planAnalysisGoal } from '../../../js/query/planner.js';

const QUERY = Object.freeze({
  action: 'read',
  entity: { terms: [] },
  context: { terms: [] },
  event: { terms: [] },
  dataflow: { shape: 'read' },
  expect: { calls: [] },
  confident: true,
});

const SEED = 0x1000n;
const CALLER = 0x2000n;
const CALLEE = 0x3000n;

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

function directTools({ callers = page(), callees = page() } = {}) {
  return {
    async get_callers(address) {
      assert.equal(BigInt(address), SEED);
      return callers;
    },
    async get_callees(address) {
      assert.equal(BigInt(address), SEED);
      return callees;
    },
    async get_function(address) {
      return {
        address: BigInt(address),
        name: `fn_${BigInt(address).toString(16)}`,
        instructions: 1,
        summary: { calls: [] },
        cost: { functions: 0, disassembly: 0 },
      };
    },
    async get_semantic_facts() {
      return page();
    },
    async find_thresholds() {
      return page();
    },
  };
}

function planWithTools(tools, candidateFunctions = [{ address: SEED, source: 'seed', score: 10 }]) {
  return planAnalysisGoal(QUERY, { candidateFunctions }, {
    tools,
    maxFunctions: 8,
    maxDisassembly: 64,
    maxSearchResults: 8,
    maxExpansions: 4,
    timeoutMs: 2_000,
  });
}

function graphCandidate(result, address) {
  return result.candidates.find((candidate) => candidate.address === address);
}

test('issue-4260: partial callers downgrade planner completeness and retain per-seed diagnostics', async () => {
  const result = await planWithTools(directTools({
    callers: page([{ addr: CALLER }], {
      complete: false,
      truncated: true,
      returned: 1,
      total: 2,
      coverage: 0.5,
      reason: 'query-limit',
    }),
  }));

  assert.equal(result.partial, true);
  assert.equal(result.completeness.complete, false);
  assert.equal(result.completeness.searchComplete, false);
  assert.ok(result.missingEvidence.includes('search-incomplete'));

  const report = result.searchCompleteness.reports.find((entry) => entry.tool === 'get_callers');
  assert.ok(report, 'caller completeness report must be retained');
  assert.equal(report.term, `caller@${SEED}`);
  assert.equal(report.complete, false);
  assert.equal(report.reason, 'query-limit');
  assert.equal(report.coverage, 0.5);
  assert.equal(graphCandidate(result, CALLER)?.discoveryCoverage, 0.5);
});

test('issue-4260: partial callees downgrade planner completeness and candidate coverage', async () => {
  const result = await planWithTools(directTools({
    callees: page([{ addr: CALLEE }], {
      complete: false,
      truncated: true,
      returned: 1,
      total: 4,
      coverage: 0.25,
      reason: 'producer-partial',
    }),
  }));

  assert.equal(result.completeness.complete, false);
  assert.equal(result.completeness.searchComplete, false);
  const report = result.searchCompleteness.reports.find((entry) => entry.tool === 'get_callees');
  assert.ok(report, 'callee completeness report must be retained');
  assert.equal(report.term, `callee@${SEED}`);
  assert.equal(report.complete, false);
  assert.equal(report.reason, 'producer-partial');
  assert.equal(report.coverage, 0.25);
  assert.equal(graphCandidate(result, CALLEE)?.discoveryCoverage, 0.25);
});

test('issue-4260: complete callers/callees preserve complete graph discovery', async () => {
  const result = await planWithTools(directTools({
    callers: page([{ addr: CALLER }]),
    callees: page([{ addr: CALLEE }]),
  }));

  assert.equal(result.partial, false);
  assert.equal(result.completeness.complete, true);
  assert.equal(result.completeness.searchComplete, true);
  assert.equal(result.missingEvidence.includes('search-incomplete'), false);
  assert.equal(graphCandidate(result, CALLER)?.discoveryCoverage, 1);
  assert.equal(graphCandidate(result, CALLEE)?.discoveryCoverage, 1);
  assert.equal(result.searchCompleteness.reports.filter((entry) => entry.tool === 'get_callers').length, 1);
  assert.equal(result.searchCompleteness.reports.filter((entry) => entry.tool === 'get_callees').length, 1);
});

test('issue-4260: one partial seed keeps multi-seed graph discovery partial', async () => {
  const SECOND = 0x4000n;
  const tools = {
    ...directTools(),
    async get_callers(address) {
      const at = BigInt(address);
      if (at === SEED) return page([{ addr: CALLER }]);
      if (at === SECOND) return page([], {
        complete: false,
        truncated: true,
        returned: 0,
        total: null,
        coverage: 0,
        reason: 'query-limit',
      });
      throw new Error(`unexpected caller seed ${at}`);
    },
    async get_callees(address) {
      const at = BigInt(address);
      if (at === SEED || at === SECOND) return page();
      throw new Error(`unexpected callee seed ${at}`);
    },
  };

  const result = await planWithTools(tools, [
    { address: SEED, source: 'seed-a', score: 10 },
    { address: SECOND, source: 'seed-b', score: 9 },
  ]);

  assert.equal(result.completeness.complete, false);
  assert.equal(result.completeness.searchComplete, false);
  const callerReports = result.searchCompleteness.reports.filter((entry) => entry.tool === 'get_callers');
  assert.equal(callerReports.length, 2);
  assert.equal(callerReports.filter((entry) => !entry.complete).length, 1);
  assert.equal(callerReports.find((entry) => !entry.complete)?.term, `caller@${SECOND}`);
});

test('issue-4260: first-party createAgentTools path propagates partial ProgramIndex callers into planner completeness', async () => {
  const modelFor = (address) => buildSemanticModel([
    { mn: 'ret', ops: '', row: 0, address },
  ], [], []);

  const context = {
    candidateFunctions: [{ address: SEED, source: 'first-party-seed', score: 10 }],
    async analyze(address) {
      return modelFor(BigInt(address));
    },
    program: {
      functionRange(address) {
        const start = BigInt(address);
        return { start, end: start + 4n };
      },
      callersOf(address) {
        assert.equal(BigInt(address), SEED);
        return {
          results: [{ addr: CALLER }],
          complete: false,
          truncated: true,
          reason: 'query-limit',
        };
      },
      calleesOf(address) {
        assert.equal(BigInt(address), SEED);
        return { results: [], complete: true, total: 0 };
      },
    },
  };

  const result = await planAnalysisGoal(QUERY, context, {
    maxFunctions: 8,
    maxDisassembly: 64,
    maxSearchResults: 8,
    maxExpansions: 1,
    timeoutMs: 2_000,
  });

  assert.equal(result.completeness.complete, false);
  assert.equal(result.completeness.searchComplete, false);
  assert.ok(result.missingEvidence.includes('search-incomplete'));
  const report = result.searchCompleteness.reports.find((entry) => entry.tool === 'get_callers');
  assert.ok(report, 'first-party get_callers completeness must reach planner diagnostics');
  assert.equal(report.complete, false);
  assert.equal(report.reason, 'query-limit');
  assert.ok(report.coverage < 1);
  assert.ok(graphCandidate(result, CALLER)?.discoveryCoverage < 1);
});

test('issue-4260: graph limit inference uses the actual 12-row caller request rather than the global search limit', async () => {
  const callers = Array.from({ length: 12 }, (_, index) => ({ addr: 0x5000n + BigInt(index * 4) }));
  const tools = directTools({ callers: { results: callers } });

  const result = await planWithTools(tools);

  assert.equal(result.completeness.complete, false);
  assert.equal(result.completeness.searchComplete, false);
  const report = result.searchCompleteness.reports.find((entry) => entry.tool === 'get_callers');
  assert.ok(report, 'caller query at its exact request limit must be recorded');
  assert.equal(report.returned, 12);
  assert.equal(report.complete, false);
  assert.equal(report.reason, 'result-limit');
  assert.equal(report.coverage, 0.65);
});
