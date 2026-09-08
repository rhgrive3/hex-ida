import assert from 'node:assert/strict';
import { compileGoal, queryPlan, SHAPES } from '../../../js/goalc.js';
import { planAnalysisGoal } from '../../../js/query/planner.js';
import { FACT } from '../../../js/semantic.js';

const setQuery = compileGoal('HPを100に設定する場所');
assert.equal(setQuery.action, 'set');
assert.equal(setQuery.dataflow.shape, SHAPES.WRITE);
assert.deepEqual(setQuery.dataflow.steps, ['value', 'store']);
assert.deepEqual(setQuery.expect.memory, ['store']);
assert.equal(queryPlan(setQuery).some((step) => step.tool === 'find_read_modify_write'), false);

for (const text of ['HPが増える場所', 'HPが減る場所']) {
  const query = compileGoal(text);
  assert.equal(query.dataflow.shape, SHAPES.RMW, text);
  assert.equal(queryPlan(query).some((step) => step.tool === 'find_read_modify_write'), true, text);
}

assert.equal(compileGoal('HPを保存する場所').dataflow.shape, SHAPES.TRANSFER);
assert.equal(compileGoal('HPを読み出す場所').dataflow.shape, SHAPES.ANY);
assert.equal(compileGoal('レア度を決める場所').dataflow.shape, SHAPES.PRODUCE);
assert.equal(compileGoal('HPを確認する場所').dataflow.shape, SHAPES.COMPARE);

function complete(results) {
  return { results, completeness: { complete: true, coverage: 1, returned: results.length, total: results.length } };
}

const PURE_WRITE = 0x1000n;
const RMW_WRITE = 0x2000n;
const tools = {
  search_functions: async () => complete([{ address: PURE_WRITE }, { address: RMW_WRITE }]),
  search_strings: async () => complete([]),
  get_callers: async () => complete([]),
  get_callees: async () => complete([]),
  get_function: async () => ({ name: 'candidate', summary: { calls: [] }, cost: { disassembly: 0 } }),
  get_semantic_facts: async (address) => complete(address === PURE_WRITE
    ? [{ kind: FACT.WRITE, evidence: ['pure-write'] }]
    : [{ kind: FACT.WRITE, evidence: ['rmw-write'] }, { kind: FACT.RMW, evidence: ['rmw-only'] }]),
};

async function rank(query) {
  return planAnalysisGoal(query, {}, {
    tools,
    maxFunctions: 8,
    maxDisassembly: 256,
    maxExpansions: 2,
    maxSearchResults: 8,
    timeoutMs: 2000,
  });
}

const setRanked = await rank(setQuery);
const setPure = setRanked.candidates.find((candidate) => candidate.address === PURE_WRITE);
const setRmw = setRanked.candidates.find((candidate) => candidate.address === RMW_WRITE);
assert.ok(setPure);
assert.ok(setRmw);
assert.equal(setPure.semanticScore, 8);
assert.equal(setRmw.semanticScore, 8);
assert.equal(setRmw.semanticFacts.some((fact) => fact.kind === FACT.RMW), false);
assert.equal(setRanked.best?.address, PURE_WRITE);

const increaseRanked = await rank(compileGoal('HPが増える場所'));
const increasePure = increaseRanked.candidates.find((candidate) => candidate.address === PURE_WRITE);
const increaseRmw = increaseRanked.candidates.find((candidate) => candidate.address === RMW_WRITE);
assert.ok(increasePure);
assert.ok(increaseRmw);
assert.equal(increasePure.semanticScore, 8);
assert.equal(increaseRmw.semanticScore, 60);
assert.ok(increaseRmw.semanticScore > increasePure.semanticScore);

console.log('issue-3933 goal set write shape: ok');
