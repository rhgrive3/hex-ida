import assert from 'node:assert/strict';
import test from 'node:test';

import { compileGoal } from '../../../js/goalc.js';
import { planAnalysisGoal } from '../../../js/query/planner.js';
import { FACT } from '../../../js/semantic.js';

const TARGET = 0x3950n;

function page(results = []) {
  return { results, complete:true, truncated:false, returned:results.length, total:results.length, coverage:1, reason:null };
}

function query(action, facts, entityTerms = ['intent-hit']) {
  return {
    action,
    entity: { terms: entityTerms },
    context: { terms: [] },
    event: { terms: [] },
    dataflow: { shape: action === 'increase' || action === 'decrease' ? 'read-modify-write' : action === 'save' ? 'transfer' : 'read' },
    expect: { calls: [] },
    confident: true,
    __facts: facts,
  };
}

async function run(action, facts, options = {}) {
  const fieldTargets = [];
  let thresholdQueries = 0;
  const q = options.query || query(action, facts, options.entityTerms);
  q.__facts = facts;
  const searchTerm = q.entity?.terms?.[0] || 'intent-hit';
  const tools = {
    async search_functions(term) { return term === searchTerm ? page([{ addr:TARGET, name:'intent_hit' }]) : page(); },
    async search_strings() { return page(); },
    async get_xrefs() { return { functions:[], complete:true, returned:0, total:0, coverage:1 }; },
    async get_callers() { return page(); },
    async get_callees() { return page(); },
    async get_function(address) {
      return { address:BigInt(address), name:'intent_hit', instructions:1, summary:{ calls:[] }, cost:{ functions:0, disassembly:0 } };
    },
    async get_semantic_facts() { return page(q.__facts); },
    async verify_field_update(_address, target) { fieldTargets.push(target); return { verified:true, evidence:['ev-rmw'] }; },
    async find_thresholds() { thresholdQueries++; return page([{ kind:'threshold', value:7 }]); },
  };
  const result = await planAnalysisGoal(q, {}, {
    tools,
    maxFunctions:8,
    maxDisassembly:64,
    maxSearchResults:8,
    maxExpansions:1,
    maxToolCalls:32,
    timeoutMs:2_000,
  });
  return { result, fieldTargets, thresholdQueries };
}

test('issue-3950: save intent cannot promote generic RMW verification to decisive proof', async () => {
  const rmw = { kind:FACT.RMW, location:{ disp:0x20 }, evidence:['sem-rmw'] };
  const out = await run('save', [rmw]);
  assert.equal(out.fieldTargets.length, 0, 'save is not an RMW-update intent');
  assert.equal(out.result.best?.verification, null, 'generic RMW must not become save proof');
  assert.equal(out.result.best?.evidenceScore, 0);
  assert.ok(out.result.missingEvidence.includes('no-runtime-or-causal-verification'));
});

test('issue-3950: increase intent retains single-target field-update verification', async () => {
  const rmw = { kind:FACT.RMW, location:{ disp:0x20 }, evidence:['sem-rmw'] };
  const out = await run('increase', [rmw]);
  assert.deepEqual(out.fieldTargets, [{ offset:0x20 }]);
  assert.equal(out.result.best?.verification?.verified, true);
  assert.equal(out.result.best?.evidenceScore, 45);
  assert.ok(out.result.evidence.includes('ev-rmw'));
});

test('issue-3950: mixed update fields bind verification to the query-relevant target', async () => {
  const facts = [
    { kind:FACT.RMW, location:{ key:'field:stat_counter', disp:0x10 }, evidence:['sem-counter'] },
    { kind:FACT.INCREMENT, location:{ key:'field:stat_counter', disp:0x10 }, evidence:['sem-counter-inc'] },
    { kind:FACT.RMW, location:{ key:'field:player_hp', disp:0x20 }, evidence:['sem-hp'] },
    { kind:FACT.INCREMENT, location:{ key:'field:player_hp', disp:0x20 }, evidence:['sem-hp-inc'] },
  ];
  const q = compileGoal('increase hp');
  const out = await run('increase', facts, { query:q });
  assert.deepEqual(out.fieldTargets, ['field:player_hp'], 'unrelated first RMW must not own +45 verification authority');
  assert.equal(out.result.best?.verification?.verified, true);
  assert.equal(out.result.best?.evidenceScore, 45);
  assert.ok(out.result.evidence.includes('ev-rmw'));
});

test('issue-3950: ambiguous multi-field update evidence does not mint decisive verification', async () => {
  const facts = [
    { kind:FACT.RMW, location:{ key:'field:counter_a', disp:0x10 }, evidence:['sem-a'] },
    { kind:FACT.RMW, location:{ key:'field:counter_b', disp:0x20 }, evidence:['sem-b'] },
  ];
  const q = compileGoal('increase hp');
  const out = await run('increase', facts, { query:q });
  assert.equal(out.fieldTargets.length, 0);
  assert.equal(out.result.best?.verification, null);
  assert.equal(out.result.best?.evidenceScore, 0);
});

test('issue-3950: decide intent keeps threshold verification path authoritative', async () => {
  const facts = [
    { kind:FACT.BRANCH, evidence:['sem-branch'] },
    { kind:FACT.RMW, location:{ disp:0x20 }, evidence:['sem-rmw'] },
  ];
  const out = await run('decide', facts);
  assert.equal(out.fieldTargets.length, 0);
  assert.equal(out.thresholdQueries, 1);
  assert.equal(out.result.best?.verification, null);
  assert.ok(out.result.best?.thresholdEvidence?.results?.length > 0);
});
