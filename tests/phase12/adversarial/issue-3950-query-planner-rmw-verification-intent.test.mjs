import assert from 'node:assert/strict';
import test from 'node:test';

import { planAnalysisGoal } from '../../../js/query/planner.js';
import { FACT } from '../../../js/semantic.js';

const TARGET = 0x3950n;

function page(results = []) {
  return { results, complete:true, truncated:false, returned:results.length, total:results.length, coverage:1, reason:null };
}

function query(action, facts) {
  return {
    action,
    entity: { terms: ['intent-hit'] },
    context: { terms: [] },
    event: { terms: [] },
    dataflow: { shape: action === 'increase' ? 'read-modify-write' : action === 'save' ? 'transfer' : 'read' },
    expect: { calls: [] },
    confident: true,
    __facts: facts,
  };
}

async function run(action, facts) {
  let fieldVerifications = 0;
  let thresholdQueries = 0;
  const q = query(action, facts);
  const tools = {
    async search_functions(term) { return term === 'intent-hit' ? page([{ addr:TARGET, name:'intent_hit' }]) : page(); },
    async search_strings() { return page(); },
    async get_xrefs() { return { functions:[], complete:true, returned:0, total:0, coverage:1 }; },
    async get_callers() { return page(); },
    async get_callees() { return page(); },
    async get_function(address) {
      return { address:BigInt(address), name:'intent_hit', instructions:1, summary:{ calls:[] }, cost:{ functions:0, disassembly:0 } };
    },
    async get_semantic_facts() { return page(q.__facts); },
    async verify_field_update() { fieldVerifications++; return { verified:true, evidence:['ev-rmw'] }; },
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
  return { result, fieldVerifications, thresholdQueries };
}

test('issue-3950: save intent cannot promote generic RMW verification to decisive proof', async () => {
  const rmw = { kind:FACT.RMW, location:{ disp:0x20 }, evidence:['sem-rmw'] };
  const out = await run('save', [rmw]);
  assert.equal(out.fieldVerifications, 0, 'save is not an RMW-update intent');
  assert.equal(out.result.best?.verification, null, 'generic RMW must not become save proof');
  assert.equal(out.result.best?.evidenceScore, 0);
  assert.ok(out.result.missingEvidence.includes('no-runtime-or-causal-verification'));
});

test('issue-3950: increase intent retains field-update verification', async () => {
  const rmw = { kind:FACT.RMW, location:{ disp:0x20 }, evidence:['sem-rmw'] };
  const out = await run('increase', [rmw]);
  assert.equal(out.fieldVerifications, 1);
  assert.equal(out.result.best?.verification?.verified, true);
  assert.equal(out.result.best?.evidenceScore, 45);
  assert.ok(out.result.evidence.includes('ev-rmw'));
});

test('issue-3950: decide intent keeps threshold verification path authoritative', async () => {
  const facts = [
    { kind:FACT.BRANCH, evidence:['sem-branch'] },
    { kind:FACT.RMW, location:{ disp:0x20 }, evidence:['sem-rmw'] },
  ];
  const out = await run('decide', facts);
  assert.equal(out.fieldVerifications, 0);
  assert.equal(out.thresholdQueries, 1);
  assert.equal(out.result.best?.verification, null);
  assert.ok(out.result.best?.thresholdEvidence?.results?.length > 0);
});
