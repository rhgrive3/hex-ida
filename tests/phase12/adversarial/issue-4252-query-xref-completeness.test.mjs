import assert from 'node:assert/strict';
import test from 'node:test';

import { planAnalysisGoal } from '../../../js/query/planner.js';

const query = {
  action: 'increase',
  entity: { terms: ['needle'] },
  context: { terms: [] },
  event: { terms: [] },
  dataflow: { shape: 'read-modify-write' },
  expect: { calls: [] },
  confident: true,
};

function toolsFor(xrefsByTarget) {
  return {
    async search_functions() {
      return { results: [], complete: true, returned: 0, total: 0, coverage: 1 };
    },
    async search_strings() {
      return {
        results: Object.keys(xrefsByTarget).map((address) => ({ stringAddress: BigInt(address) })),
        complete: true,
        returned: Object.keys(xrefsByTarget).length,
        total: Object.keys(xrefsByTarget).length,
        coverage: 1,
      };
    },
    async get_xrefs(address) {
      return xrefsByTarget[String(address)];
    },
    async get_callers() { return { results: [], complete: true, returned: 0, total: 0, coverage: 1 }; },
    async get_callees() { return { results: [], complete: true, returned: 0, total: 0, coverage: 1 }; },
    async get_function(address) {
      return {
        address: BigInt(address),
        name: `fn_${BigInt(address).toString(16)}`,
        instructions: 1,
        summary: { calls: [] },
        cost: { functions: 1, disassembly: 1 },
      };
    },
    async get_semantic_facts() { return { results: [], complete: true, returned: 0, total: 0, coverage: 1 }; },
    async verify_field_update() { return { verified: false, evidence: [] }; },
    async find_thresholds() { return { results: [], complete: true, returned: 0, total: 0, coverage: 1 }; },
  };
}

async function plan(xrefsByTarget) {
  return planAnalysisGoal(query, {}, {
    tools: toolsFor(xrefsByTarget),
    maxFunctions: 48,
    maxDisassembly: 128,
    maxSearchResults: 8,
    maxExpansions: 0,
    timeoutMs: 2000,
  });
}

test('issue-4252: incomplete string xrefs make overall search incomplete and preserve diagnostics', async () => {
  const result = await plan({
    8192: {
      functions: [{ addr: 0x1000n }],
      completeness: { complete: false, coverage: 0.25, reason: 'xref-budget', returned: 1, total: 4 },
    },
  });

  assert.equal(result.partial, true);
  assert.equal(result.completeness.complete, false);
  assert.equal(result.completeness.searchComplete, false);
  assert.ok(result.missingEvidence.includes('search-incomplete'));
  const report = result.searchCompleteness.reports.find((entry) => entry.tool === 'get_xrefs');
  assert.ok(report, 'get_xrefs completeness report must be retained');
  assert.equal(report.term, '8192');
  assert.equal(report.complete, false);
  assert.equal(report.reason, 'xref-budget');
  assert.equal(report.coverage, 0.25);
  assert.equal(result.candidates[0]?.discoveryCoverage, 0.25);
});

test('issue-4252: first-party createAgentTools xref producer propagates upstream incompleteness', async () => {
  const result = await planAnalysisGoal(query, {
    strings: [{ text: 'needle', stringAddress: 0x2000n }],
    functions: [],
    program: {
      refSitesTo() { return []; },
      functionsReferencing() {
        return { results: [{ addr: 0x1000n }], complete: false, reason: 'xref-budget' };
      },
    },
  }, {
    maxFunctions: 48,
    maxDisassembly: 128,
    maxSearchResults: 8,
    maxExpansions: 0,
    timeoutMs: 2000,
  });

  const report = result.searchCompleteness.reports.find((entry) => entry.tool === 'get_xrefs');
  assert.ok(report, 'first-party get_xrefs report must reach planner diagnostics');
  assert.equal(report.complete, false);
  assert.equal(report.reason, 'xref-budget');
  assert.equal(result.completeness.searchComplete, false);
  assert.ok(result.missingEvidence.includes('search-incomplete'));
});

test('issue-4252: truncated xrefs without explicit complete still fail closed', async () => {
  const result = await plan({
    8192: {
      functions: [{ addr: 0x1000n }],
      truncated: true,
      reason: 'result-limit',
      coverage: 0.5,
      returned: 1,
      total: 2,
    },
  });

  assert.equal(result.partial, true);
  assert.equal(result.completeness.searchComplete, false);
  assert.equal(result.searchCompleteness.reports.find((entry) => entry.tool === 'get_xrefs')?.reason, 'result-limit');
});

test('issue-4252: incomplete empty xrefs cannot become complete negative evidence', async () => {
  const result = await plan({
    8192: { functions: [], complete: false, coverage: 0, reason: 'upstream-incomplete', returned: 0, total: null },
  });

  assert.equal(result.candidates.length, 0);
  assert.equal(result.completeness.complete, false);
  assert.equal(result.completeness.searchComplete, false);
  assert.ok(result.missingEvidence.includes('search-incomplete'));
  assert.equal(result.searchCompleteness.reports.find((entry) => entry.tool === 'get_xrefs')?.reason, 'upstream-incomplete');
});

test('issue-4252: one partial xref source keeps multi-string candidate enumeration incomplete', async () => {
  const result = await plan({
    8192: { functions: [{ addr: 0x1000n }], complete: true, coverage: 1, returned: 1, total: 1 },
    12288: { functions: [{ addr: 0x2000n }], complete: false, coverage: 0.5, reason: 'xref-budget', returned: 1, total: 2 },
  });

  const xrefReports = result.searchCompleteness.reports.filter((entry) => entry.tool === 'get_xrefs');
  assert.equal(xrefReports.length, 2);
  assert.equal(xrefReports.filter((entry) => !entry.complete).length, 1);
  assert.equal(result.completeness.complete, false);
  assert.ok(result.missingEvidence.includes('search-incomplete'));
});

test('issue-4252: complete xref enumeration preserves complete planner search', async () => {
  const result = await plan({
    8192: { functions: [{ addr: 0x1000n }], complete: true, coverage: 1, returned: 1, total: 1 },
  });

  const report = result.searchCompleteness.reports.find((entry) => entry.tool === 'get_xrefs');
  assert.ok(report);
  assert.equal(report.complete, true);
  assert.equal(result.completeness.searchComplete, true);
  assert.equal(result.completeness.complete, true);
  assert.equal(result.partial, false);
  assert.equal(result.candidates[0]?.discoveryCoverage, 1);
});
