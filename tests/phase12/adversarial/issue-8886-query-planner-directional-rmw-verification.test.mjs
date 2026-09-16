import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSemanticModel } from '../../../js/blocks.js';
import { FACT } from '../../../js/semantic.js';
import { createAgentTools } from '../../../js/agent/tools.js';
import { deterministicAnswer } from '../../../js/agent/runtime.js';
import { planAnalysisGoal } from '../../../js/query/planner.js';
import { compileGoal } from '../../../js/goalc.js';

const TARGET = 0x1000n;

function rows(lines) {
  return lines.map((line, index) => {
    const space = line.indexOf(' ');
    return {
      row: index,
      address: TARGET + BigInt(index * 4),
      mn: line.slice(0, space),
      ops: line.slice(space + 1),
    };
  });
}

// add w8,w8,#1 -> proven INCREMENT + generic RMW; lsl/eor -> generic RMW only.
const SEQUENCES = {
  add: ['ldr w8, [x0, #0x140]', 'add w8, w8, #1', 'str w8, [x0, #0x140]', 'ret'],
  sub: ['ldr w8, [x0, #0x140]', 'sub w8, w8, #1', 'str w8, [x0, #0x140]', 'ret'],
  lsl: ['ldr w8, [x0, #0x140]', 'lsl w8, w8, #1', 'str w8, [x0, #0x140]', 'ret'], // hp = hp * 2 (Counterexample A/B)
  eor: ['ldr w8, [x0, #0x140]', 'eor w8, w8, #1', 'str w8, [x0, #0x140]', 'ret'], // hp = hp ^ 1 (Counterexample C)
};

function toolsFor(name) {
  const model = buildSemanticModel(rows(SEQUENCES[name]), [], []);
  return createAgentTools({ analyze: async () => model }, { maxFunctions: 4 });
}

async function fieldKey(name) {
  const tools = toolsFor(name);
  const facts = await tools.get_semantic_facts(TARGET);
  const rmw = facts.results.find((f) => f.kind === FACT.RMW);
  assert.ok(rmw?.location?.key, `${name} fixture must produce a canonical field key`);
  return { tools, key: rmw.location.key };
}

test('issue-8886: a proven increment verifies only "increase", never "decrease"', async () => {
  const { tools, key } = await fieldKey('add');
  const legacy = await tools.verify_field_update(TARGET, { key });
  assert.equal(legacy.verified, true, 'legacy generic-RMW "is the field updated" contract must stay intact (#3950/#4987)');
  const inc = await tools.verify_field_update(TARGET, { key }, { expectedFactKind: FACT.INCREMENT });
  assert.equal(inc.verified, true, 'add produces a real INCREMENT fact');
  assert.deepEqual(inc.updates.map((u) => u.kind), [FACT.INCREMENT]);
  const dec = await tools.verify_field_update(TARGET, { key }, { expectedFactKind: FACT.DECREMENT });
  assert.equal(dec.verified, false, 'increase evidence must not satisfy a decrease intent');
  assert.equal(dec.updates.length, 0);
});

test('issue-8886: a proven decrement verifies only "decrease", never "increase"', async () => {
  const { tools, key } = await fieldKey('sub');
  const dec = await tools.verify_field_update(TARGET, { key }, { expectedFactKind: FACT.DECREMENT });
  assert.equal(dec.verified, true);
  const inc = await tools.verify_field_update(TARGET, { key }, { expectedFactKind: FACT.INCREMENT });
  assert.equal(inc.verified, false, 'decrease evidence must not satisfy an increase intent');
});

for (const name of ['lsl', 'eor']) {
  test(`issue-8886: a directionless RMW (${name}) verifies neither increase nor decrease`, async () => {
    const { tools, key } = await fieldKey(name);
    const legacy = await tools.verify_field_update(TARGET, { key });
    assert.equal(legacy.verified, true, `${name} still proves "the field is updated" via generic RMW`);
    const inc = await tools.verify_field_update(TARGET, { key }, { expectedFactKind: FACT.INCREMENT });
    const dec = await tools.verify_field_update(TARGET, { key }, { expectedFactKind: FACT.DECREMENT });
    assert.equal(inc.verified, false, `${name} must not verify "increase" from a directionless RMW`);
    assert.equal(dec.verified, false, `${name} must not verify "decrease" from a directionless RMW`);
    assert.deepEqual(inc.evidence, [], 'no directional evidence may be attached');
    assert.deepEqual(dec.evidence, []);
  });
}

const page = (results = []) => ({
  results, complete: true, truncated: false, returned: results.length,
  total: results.length, coverage: 1, reason: null,
});

async function plan(name, goal) {
  const real = toolsFor(name);
  const tools = {
    ...real,
    async search_functions() { return page([{ addr: TARGET, name: 'probe' }]); },
    async search_strings() { return page(); },
    async get_xrefs() { return { functions: [], complete: true, returned: 0, total: 0, coverage: 1 }; },
    async get_callers() { return page(); },
    async get_callees() { return page(); },
    async get_function(address) {
      return { address: BigInt(address), name: 'probe', instructions: 4, summary: { calls: [] }, cost: { functions: 0, disassembly: 0 } };
    },
  };
  const plan = await planAnalysisGoal(compileGoal(goal), {}, {
    tools, maxFunctions: 4, maxDisassembly: 64, maxSearchResults: 8,
    maxExpansions: 1, maxToolCalls: 40, timeoutMs: 2_000,
  });
  return { plan, answer: deterministicAnswer(plan) };
}

test('issue-8886: end-to-end planner binds verification authority to the requested direction', async () => {
  const good = await plan('add', 'increase hp');
  assert.equal(good.plan.best?.verification?.verified, true, 'a proven increase must remain deterministically verifiable');

  const mismatch = await plan('add', 'decrease hp');
  assert.notEqual(mismatch.plan.best?.verification?.verified, true, 'increase evidence must not verify a decrease intent');

  const toggleUp = await plan('eor', 'increase hp');
  const toggleDown = await plan('eor', 'decrease hp');
  assert.notEqual(toggleUp.plan.best?.verification?.verified, true, 'Counterexample C: hp ^= 1 must not verify "increase"');
  assert.notEqual(toggleDown.plan.best?.verification?.verified, true, 'Counterexample C: the same evidence must not verify "decrease" either');

  for (const result of [mismatch, toggleUp, toggleDown]) {
    const authorityReason = result.answer.reasons?.find((r) => r.kind === 'deterministic-verification');
    assert.notEqual(authorityReason?.verified, true, 'a directionless/mismatched RMW must not mint deterministic-verification authority');
  }
});
