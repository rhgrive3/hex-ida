import assert from 'node:assert/strict';
import test from 'node:test';
import { planAnalysisGoal } from '../../../js/query/planner.js';

const QUERY = {
  action:'read',
  entity:{ terms:['needle'] },
  context:{ terms:[] },
  event:{ terms:[] },
  dataflow:{ shape:'read' },
  expect:{ calls:[] },
  confident:true,
};

const functionRow = { address:0x1000n, name:'needle_fn' };
const functionResult = {
  address:0x1000n,
  name:'needle_fn',
  instructions:1,
  summary:{ calls:[] },
  cost:{ functions:1, disassembly:0 },
};

function directTools(searchFunctions) {
  return {
    async search_functions() { return searchFunctions(); },
    async search_strings() { return { results:[], complete:true, returned:0, total:0, coverage:1 }; },
    async get_function() { return functionResult; },
    async get_semantic_facts() { return { results:[], complete:true, returned:0, total:0, coverage:1 }; },
    async verify_field_update() { return { verified:false, evidence:[] }; },
    async find_thresholds() { return { results:[], complete:true, returned:0, total:0, coverage:1 }; },
  };
}

const options = (tools) => ({
  ...(tools ? { tools } : {}),
  maxFunctions:8,
  maxDisassembly:64,
  maxSearchResults:8,
  maxExpansions:0,
  timeoutMs:5000,
});

function functionReport(result) {
  return result.searchCompleteness.reports.find((row) => row.tool === 'search_functions');
}

test('issue-4641: direct planner tools cannot launder structured completeness metadata', async () => {
  const result = await planAnalysisGoal(QUERY, {}, options(directTools(() => ({
    results:[functionRow],
    complete:'false',
    coverage:['1'],
    returned:['1'],
    total:['1'],
  }))));

  const report = functionReport(result);
  assert.equal(report.complete, false);
  assert.ok(report.coverage < 1, 'malformed coverage must not receive full discovery weight');
  assert.equal(result.completeness.searchComplete, false);
  assert.equal(result.partial, true);
  assert.ok(result.missingEvidence.includes('search-incomplete'));
});

test('issue-4641: malformed nested metadata and numeric strings fail closed without coercion', async () => {
  for (const malformed of [
    { completeness:{ complete:'true', coverage:'1', returned:'1', total:'1' } },
    { completeness:{ complete:[], coverage:[1], returned:[1], total:[1] } },
    { completeness:{ complete:{}, coverage:{ value:1 }, returned:{ value:1 }, total:{ value:1 } } },
  ]) {
    const result = await planAnalysisGoal(QUERY, {}, options(directTools(() => ({
      results:[functionRow],
      ...malformed,
    }))));
    const report = functionReport(result);
    assert.equal(report.complete, false);
    assert.ok(report.coverage < 1);
    assert.equal(result.completeness.searchComplete, false);
  }
});

test('issue-4641: malformed shadow aliases and scan counters cannot restore full authority', async () => {
  const shadowed = await planAnalysisGoal(QUERY, {}, options(directTools(() => ({
    results:[functionRow],
    completeness:{ complete:true, coverage:1, returned:1, total:1 },
    complete:'true',
    coverage:['1'],
    returned:['1'],
    total:['1'],
  }))));
  assert.equal(functionReport(shadowed).complete, false);
  assert.ok(functionReport(shadowed).coverage < 1);

  const scanCoercion = await planAnalysisGoal(QUERY, {}, options(directTools(() => ({
    results:[functionRow],
    complete:true,
    scanned:['100'],
    scanTotal:['100'],
  }))));
  assert.equal(functionReport(scanCoercion).complete, false);
  assert.ok(functionReport(scanCoercion).coverage < 1);
});

test('issue-4641: primitive valid metadata and missing-metadata inference keep existing semantics', async () => {
  const explicit = await planAnalysisGoal(QUERY, {}, options(directTools(() => ({
    results:[functionRow], complete:true, coverage:1, returned:1, total:1,
  }))));
  assert.deepEqual(
    { complete:functionReport(explicit).complete, coverage:functionReport(explicit).coverage, returned:functionReport(explicit).returned, total:functionReport(explicit).total },
    { complete:true, coverage:1, returned:1, total:1 },
  );

  const inferred = await planAnalysisGoal(QUERY, {}, options(directTools(() => ({ results:[functionRow] }))));
  assert.equal(functionReport(inferred).complete, true);
  assert.equal(functionReport(inferred).coverage, 1);
});

test('issue-4641: built-in createAgentTools path remains fail-closed for malformed producer metadata', async () => {
  const result = await planAnalysisGoal(QUERY, {
    async searchFunctions() {
      return { results:[functionRow], complete:'false', coverage:['1'], returned:['1'], total:['1'] };
    },
    async searchStrings() { return { results:[], complete:true, returned:0, total:0, coverage:1 }; },
    async analyze() { return { address:0x1000n, instructions:[], summary:{ calls:[] } }; },
  }, options());

  const report = functionReport(result);
  assert.equal(report.complete, false);
  assert.ok(report.coverage < 1);
  assert.equal(result.completeness.searchComplete, false);
});

console.log('issue-4641-search-completeness-metadata: PASS');
