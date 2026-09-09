import assert from 'node:assert/strict';
import test from 'node:test';
import { preparePhase8RewritePlan, isPhase8RewritePlan, readProvedInputBindings, runProofRewritePass } from '../../../js/decompiler/phase8/pass-validation.js';
import { runPhase8Stage, createAnalysisState } from '../../../js/decompiler/phase8/index.js';
import { optimizeSemanticDecompilation, readProducerInputExpressions } from '../../../js/decompiler/pipeline.js';
import { proofFixture, projectionFixture, identity } from '../helpers/proof-fixtures.mjs';

test('C4-04 every requested target has an ordered decision without calling a selected proof adopted', async () => {
  const f = proofFixture(4);
  const plan = await preparePhase8RewritePlan(f.ir, { ...f.options, targets:[f.input, f.target] });
  assert.equal(plan.status, 'complete', plan.reason);
  assert.deepEqual(plan.decisionCoverage, { requested:2, complete:true });
  assert.deepEqual(plan.targetDecisions.map(row => row.requestedIndex), [0, 1]);
  assert.deepEqual(plan.targetDecisions.map(row => row.disposition), ['unchanged', 'selected']);
  assert.equal(plan.targetDecisions[0].reason, 'no-generated-candidate');
  assert.equal(plan.targetDecisions[1].queryHash, plan.entries[0].queryHash);
  assert.equal(plan.targetDecisions[1].operator, 'xor');
  assert.equal(plan.targetDecisions[1].bits, 4);
  assert.ok(Object.isFrozen(plan.targetDecisions) && plan.targetDecisions.every(Object.isFrozen));
});

test('C4-04 independently proved nonconstant candidates receive a scalar projection recipe', async () => {
  const f = proofFixture(4);
  f.target.def.sub = 'or';
  const plan = await preparePhase8RewritePlan(f.ir, { ...f.options, candidateStrategy:'equality-saturation' });
  assert.equal(plan.status, 'complete', plan.reason);
  assert.equal(plan.entries.length, 1);
  assert.equal(plan.entries[0].kind, 'solver-scalar');
  assert.ok(Object.isFrozen(plan.entries[0].projection));
  assert.equal(plan.targetDecisions.length, 1);
  assert.equal(plan.targetDecisions[0].disposition, 'selected');
  assert.equal(plan.targetDecisions[0].reason, 'eligible-scalar-projection');
  assert.ok(plan.targetDecisions[0].candidateCount > 0);
  assert.equal(f.target.def.sub, 'or', 'the display plan does not mutate canonical IR');
});

test('C4-04 non-total target refusal is included in the same decision denominator', async () => {
  const f = proofFixture(4);
  f.target.def.sub = 'udiv';
  const plan = await preparePhase8RewritePlan(f.ir, f.options);
  assert.equal(plan.status, 'complete', plan.reason);
  assert.deepEqual(plan.entries, []);
  assert.equal(plan.targetDecisions[0].disposition, 'unsupported');
  assert.equal(plan.targetDecisions[0].reason, 'non-total-or-effectful-target');
  assert.equal(plan.decisionCoverage.requested, 1);
});

test('C4-04 batch failure cannot leave selected or adopted audit rows from earlier work', async () => {
  const f = proofFixture(4);
  const plan = await preparePhase8RewritePlan(f.ir, { ...f.options, limits:{ rewrites:0 } });
  assert.equal(plan.status, 'partial');
  assert.deepEqual(plan.entries, []);
  assert.equal(plan.decisionCoverage.requested, 1);
  assert.equal(plan.decisionCoverage.complete, false);
  assert.equal(plan.targetDecisions[0].disposition, 'unknown');
  assert.equal(plan.targetDecisions[0].reason, plan.reason);
  const expired = await preparePhase8RewritePlan(f.ir, { ...f.options, timeoutMs:0 });
  assert.equal(expired.decisionCoverage.complete, false);
  assert.equal(expired.decisionCoverage.requested, null, 'an uninspected request must not fabricate a target count');
});

test('C4-04 decision data does not copy plan authority and target-set changes change the audit identity', async () => {
  const f = proofFixture(4);
  const a = await preparePhase8RewritePlan(f.ir, f.options);
  const b = await preparePhase8RewritePlan(f.ir, { ...f.options, targets:[f.input, f.target] });
  assert.notEqual(a.planId, b.planId);
  const context = { ir:f.ir, proofIdentity:identity, abiId:f.options.abiId };
  assert.equal(isPhase8RewritePlan({ ...a }, context), false);
  assert.equal(isPhase8RewritePlan(a, context), true);
});

test('C4-04 adopted decisions require the real committed and rendered transform', async () => {
  const f = projectionFixture(4);
  const result = await optimizeSemanticDecompilation(f.result, f.options);
  assert.equal(result.proofOptimization.status, 'complete', result.proofOptimization.reason);
  assert.equal(result.proofOptimization.targetDecisions.length, f.options.targets.length);
  assert.equal(result.proofOptimization.targetDecisions.filter(row => row.disposition === 'adopted').length, result.proofOptimization.adopted);
  for (const row of result.proofOptimization.targetDecisions) {
    assert.equal(row.disposition, 'adopted');
    assert.ok(result.phase8Projection.transforms.some(transform => transform.valueId === row.valueId && transform.queryHash === row.queryHash));
  }
});

test('C4-04 failed publication withholds adoption in both aggregate and per-target evidence', async () => {
  const f = projectionFixture(4);
  const result = await optimizeSemanticDecompilation(f.result, { ...f.options, phase8WorkBudget:0 });
  assert.equal(result.proofOptimization.status, 'partial');
  assert.equal(result.proofOptimization.adopted, 0);
  assert.equal(result.proofOptimization.targetDecisions.length, 2);
  assert.ok(result.proofOptimization.targetDecisions.every(row => row.disposition === 'unknown'));
  assert.equal(result.proofOptimization.decisionCoverage.complete, false);
  assert.equal(result.pseudocode, f.result.pseudocode);
});

test('C4-04 supported and unsupported operator families keep the same exact width denominator', async () => {
  const observed = [];
  for (const bits of [1, 4, 8, 32, 64]) {
    for (const operator of ['xor', 'udiv']) {
      const f = proofFixture(bits);
      f.target.def.sub = operator;
      const plan = await preparePhase8RewritePlan(f.ir, f.options);
      assert.equal(plan.status, 'complete', `${bits}/${operator}: ${plan.reason}`);
      assert.equal(plan.targetDecisions.length, 1);
      const row = plan.targetDecisions[0];
      assert.equal(row.bits, bits);
      assert.equal(row.operator, operator);
      assert.equal(row.disposition, operator === 'xor' ? 'selected' : 'unsupported');
      assert.equal(plan.decisionCoverage.complete, true, 'decision coverage is not proof coverage');
      observed.push(`${bits}/${operator}`);
    }
  }
  assert.equal(new Set(observed).size, 10);
});

test('C4-04 only the real committed overlay exposes the original input correspondence to projection', async () => {
  const f = proofFixture(4), plan = await preparePhase8RewritePlan(f.ir, f.options);
  const context = { ir:f.ir, proofIdentity:identity, abiId:f.options.abiId, proofRewritePlan:plan };
  let staged;
  runProofRewritePass(context, {}, { stage(_key, value) { staged = value; } });
  assert.equal(readProvedInputBindings({ get:() => staged }, context), null);
  assert.equal(readProvedInputBindings(createAnalysisState({ provedRewrites:staged }), context), null);
  const stage = runPhase8Stage(context, { stages:['canonical-facts', 'rendering'], timeBudgetMs:120 });
  assert.equal(stage.ledger.published, true);
  const correspondence = readProvedInputBindings(stage.analysis, context);
  assert.equal(correspondence.artifact, stage.analysis.get('provedRewrites'));
  assert.equal(correspondence.bindings[0].entry, plan.entries[0]);
  assert.equal(correspondence.bindings[0].binding.inputs[0].value, f.input);
  assert.ok(Object.isFrozen(correspondence) && Object.isFrozen(correspondence.bindings));
  f.input.bits = 8;
  assert.equal(readProvedInputBindings(stage.analysis, context), null);
});

test('C4-04 the real representation producer resolves SSA inputs without an ID or name substitute', () => {
  const f = projectionFixture(4);
  const inputs = readProducerInputExpressions(f.result, [f.input, f.other]);
  assert.equal(inputs.length, 2);
  assert.equal(inputs[0].value, f.input);
  assert.equal(inputs[0].expression, f.result.semanticAst.values.find(item => item.valueId === f.input.id).expression);
  assert.equal(inputs[1].value, f.other);
  assert.ok(Object.isFrozen(inputs) && inputs.every(Object.isFrozen));
  assert.equal(readProducerInputExpressions(f.result, [{ ...f.input }]), null);
  assert.equal(readProducerInputExpressions(f.result, [f.target]), null);
  assert.equal(readProducerInputExpressions({ ...f.result, semanticAst:{ ...f.result.semanticAst } }, [f.input]), null);
});

test('C4-04 copied or changed input expressions invalidate the observed representation relation', () => {
  for (const mode of ['copy', 'edit']) {
    const f = projectionFixture(4);
    const item = f.result.semanticAst.values.find(item => item.valueId === f.input.id);
    if (mode === 'copy') item.expression = { ...item.expression };
    else item.expression.name = 'other_input';
    assert.equal(readProducerInputExpressions(f.result, [f.input]), null);
  }
});
