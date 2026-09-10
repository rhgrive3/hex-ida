import assert from 'node:assert/strict';
import test from 'node:test';
import { preparePhase8RewritePlan, isPhase8RewritePlan, readProvedInputBindings, runProofRewritePass } from '../../../js/decompiler/phase8/pass-validation.js';
import { runPhase8Stage, createAnalysisState } from '../../../js/decompiler/phase8/index.js';
import { enhanceSemanticDecompilation, optimizeSemanticDecompilation, readProducerInputExpressions } from '../../../js/decompiler/pipeline.js';
import { evaluateExpression } from '../../../js/decompiler/verify/equivalence.js';
import { evaluateExpr, EVAL_STATUS } from '../../../js/symbolic/expr/index.js';
import { querySymbolicAnalysis, readSymbolicTargetInputs } from '../../../js/symbolic/query/analysis.js';
import { createTaintModels } from '../../../js/symbolic/taint/models.js';
import { fixture } from '../helpers/ir-fixtures.mjs';
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

// Reuse the existing frozen scalar width axis. Each cell contains a real
// nonconstant producer expression: op(a, xor(a,a) + offset), not a pre-folded constant
// or an identity query offered directly to the solver. This is a finite family
// integration denominator, not universal correctness of every rewrite rule.
function operatorProjectionFixture(bits, operator, offset = 0) {
  const f = fixture('proof-operator-width'); f.block(0);
  const input = f.opaque(bits); input.index = 0; input.reg = 'x0';
  const zero = f.binary('xor', input, input, bits);
  const right = offset ? f.binary('add', zero, f.constant(offset, bits), bits) : zero;
  const target = f.binary(operator, input, right, bits); f.ret();
  const ir = f.build(); ir.instructions = ir.blocks.flatMap(block => block.insts);
  ir.instructions.forEach((inst, index) => { inst.id = `operator_${index}`; inst.address = 0x1000n + BigInt(index * 4); });
  const ret = ir.instructions.at(-1); ret.args = [{ value:target }]; target.uses.push(ret);
  const canonical = structuredClone(ir);
  const result = enhanceSemanticDecompilation({ semantic:true, ir, types:null,
    lines:[{ kind:'stmt', indent:0, text:'return pending;', row:ret.row, addr:ret.address }], metrics:{}, ctx:{} }, null,
  { phase8PrepareProof:true, phase8ProofOnlyRewrites:true, deterministicTransforms:true, decompilerTimeBudgetMs:1000 });
  return { ir, input, target, canonical, result, options:{ identity, abiId:'generic-v1', memory:{addressBits:8},
    targets:[target], timeoutMs:1000, backendTier:'tiered', requireProofOnlyRewrites:true } };
}

test('C4-04 all total binary families cross the real proof-only adoption boundary on the frozen width axis', async t => {
  const widths = [1,2,3,4,8,16,32,64];
  const operators = ['add','sub','mul','and','or','xor','shl','lshr','ashr'];
  const strategies = ['local-rewrites','representation-rules','equality-saturation'];
  const models = createTaintModels({id:'binary-width-test',version:'1',provenance:'test',sources:[],sinks:[]});
  const rows = [];
  for (const bits of widths) for (const operator of operators) for (const offset of [0,1]) {
    const f = operatorProjectionFixture(bits, operator, offset);
    const originalAst = structuredClone(f.result.cAst), originalSemantic = structuredClone(f.result.semanticAst);
    const before = f.result.semanticAst.values.find(item => item.valueId === f.target.id).expression;
    const input = f.result.semanticAst.values.find(item => item.valueId === f.input.id).expression;
    assert.equal(before.kind, 'binary', `${bits}/${operator}: real unsimplified producer`);
    assert.equal(before.op, operator);
    assert.equal(f.result.rewriteStats.applications, 0);
    const translated = await querySymbolicAnalysis(f.ir, { ...f.options, models, candidateStrategy:'translate-only' });
    assert.equal(translated.status, 'complete', translated.reason);
    assert.equal(translated.metrics.candidateQueries, 0);
    const binding = readSymbolicTargetInputs(translated, f.target, identity);
    assert.equal(binding.inputs.length, 1); assert.equal(binding.inputs[0].value, f.input);
    for (const candidateStrategy of strategies) {
      const label = `${bits}/${operator}/${offset}/${candidateStrategy}`;
      const result = await optimizeSemanticDecompilation(f.result, { ...f.options, candidateStrategy });
      const report = result.proofOptimization, row = report.targetDecisions[0];
      const refuted = bits === 1 && offset === 1 && ['shl','lshr'].includes(operator) && candidateStrategy === 'representation-rules';
      assert.equal(report.status, 'complete', `${label}: ${report.reason}`);
      assert.equal(report.adopted, refuted ? 0 : 1, label);
      assert.deepEqual(report.decisionCoverage, { requested:1, complete:true }, label);
      assert.equal(row.bits, bits); assert.equal(row.operator, operator);
      assert.equal(row.disposition, refuted ? 'refuted' : 'adopted', label);
      const transform = result.phase8Projection.transforms.find(item => item.queryHash === row.queryHash);
      const after = result.semanticAst.values.find(item => item.valueId === f.target.id).expression;
      if (refuted) {
        // Representation rules model machine shifts, not saturated BV1 shifts.
        // The independent proof actually refutes this proposal. Never drop
        // these cells from the denominator or call a rejection an adoption.
        assert.equal(row.reason, 'all-generated-candidates-refuted'); assert.equal(row.candidateCount, 1);
        assert.deepEqual(result.phase8Projection.transforms, []);
        assert.equal(result.pseudocode, f.result.pseudocode);
        assert.deepEqual(result.cAst, originalAst); assert.deepEqual(result.semanticAst, originalSemantic);
      } else {
        assert.ok(transform?.beforeHash && transform.afterHash && transform.planId, label);
        assert.ok(result.renderProvenance.ledger.some(item => item.queryHash === row.queryHash), label);
        assert.notEqual(after, before, label);
      }
      const mask = (1n << BigInt(bits)) - 1n;
      const values = bits <= 8 ? Array.from({length:2 ** bits}, (_, i) => BigInt(i))
        : [0n,1n,BigInt(bits - 1),BigInt(bits),BigInt(bits + 1),mask,mask - 1n,1n << BigInt(bits - 1)];
      let machineViewBeforeMismatches = 0;
      for (const value of values) {
        // Independent BigInt oracle; offset 1 distinguishes add/sub and the
        // bitwise operators that all collapse to the same value at offset 0.
        // BV1 includes a saturated shift. BigInt signed right shift handles
        // that case without importing C signed-overflow/shift assumptions.
        const right = BigInt(offset), signed = BigInt.asIntN(bits, value);
        const expected = ({add:() => value + right, sub:() => value - right, mul:() => value * right,
          and:() => value & right, or:() => value | right, xor:() => value ^ right,
          shl:() => value << right, lshr:() => value >> right, ashr:() => signed >> right})[operator]() & mask;
        const canonicalBefore = evaluateExpr(binding.expression, new Map([[binding.inputs[0].symbol.symbolId,value]]));
        assert.equal(canonicalBefore.status, EVAL_STATUS.VALUE);
        assert.equal(canonicalBefore.value, expected, `${label}: canonical before ${value}`);
        if (!refuted) assert.equal(evaluateExpression(after, {[input.name]:value}), expected, `${label}: after ${value}`);
        // The legacy machine AST evaluator masks shift counts; the canonical
        // proof recipe explicitly lowers saturating BV shifts. Retain this
        // observation instead of calling it proof of the initial raw renderer.
        if (evaluateExpression(before, {[input.name]:value}) !== expected) machineViewBeforeMismatches++;
      }
      const refused = await optimizeSemanticDecompilation(f.result, { ...f.options, candidateStrategy, phase8WorkBudget:0 });
      assert.equal(refused.proofOptimization.status, 'partial', label);
      assert.equal(refused.proofOptimization.adopted, 0, label);
      assert.deepEqual(refused.proofOptimization.decisionCoverage, {requested:1,complete:false}, label);
      assert.equal(refused.proofOptimization.targetDecisions.length, 1, label);
      assert.ok(refused.proofOptimization.targetDecisions.every(item => item.disposition === 'unknown'), label);
      assert.equal(refused.cAst, f.result.cAst); assert.equal(refused.semanticAst, f.result.semanticAst);
      assert.equal(refused.pseudocode, f.result.pseudocode);
      assert.deepEqual(f.result.cAst, originalAst); assert.deepEqual(f.result.semanticAst, originalSemantic);
      assert.deepEqual(structuredClone(f.ir), f.canonical, label);
      if (machineViewBeforeMismatches) assert.ok(['shl','lshr','ashr'].includes(operator), label);
      rows.push({bits, operator, offset, candidateStrategy, disposition:row.disposition, reason:row.reason,
        kind:transform?.kind ?? null, comparisons:values.length,
        machineViewBeforeMismatches,
        publicationRefusal:refused.proofOptimization.reason});
    }
  }
  assert.equal(rows.length, 432);
  assert.equal(new Set(rows.map(row => `${row.bits}/${row.operator}/${row.offset}/${row.candidateStrategy}`)).size, 432);
  assert.equal(rows.filter(row => row.disposition === 'adopted').length, 430);
  assert.equal(rows.filter(row => row.disposition === 'refuted').length, 2);
  t.diagnostic(JSON.stringify({schema:'c4-04-binary-production-widths-v1',rows}));
});

test('C4-04 division and remainder stay explicitly unsupported on the same production width and strategy axes', async t => {
  const rows = [];
  for (const bits of [1,2,3,4,8,16,32,64]) for (const operator of ['udiv','sdiv','urem','srem']) {
    const f = operatorProjectionFixture(bits, operator);
    for (const candidateStrategy of ['local-rewrites','representation-rules','equality-saturation']) {
      const label = `${bits}/${operator}/${candidateStrategy}`;
      const result = await optimizeSemanticDecompilation(f.result, { ...f.options, candidateStrategy });
      const report = result.proofOptimization;
      assert.equal(report.status, 'complete', `${label}: ${report.reason}`);
      assert.deepEqual(report.decisionCoverage, { requested:1, complete:true }, label);
      assert.equal(report.targetDecisions.length, 1);
      const row = report.targetDecisions[0];
      assert.equal(row.bits, bits); assert.equal(row.operator, operator);
      assert.equal(row.disposition, 'unsupported', label);
      assert.equal(row.reason, 'non-total-or-effectful-target', label);
      assert.equal(row.candidateCount, 0); assert.equal(report.adopted, 0);
      assert.deepEqual(result.phase8Projection.transforms, []);
      assert.equal(result.pseudocode, f.result.pseudocode);
      assert.deepEqual(result.cAst, f.result.cAst); assert.deepEqual(result.semanticAst, f.result.semanticAst);
      assert.deepEqual(structuredClone(f.ir), f.canonical, label);
      rows.push({bits, operator, candidateStrategy, disposition:row.disposition, reason:row.reason});
    }
  }
  assert.equal(rows.length, 96);
  assert.equal(new Set(rows.map(row => `${row.bits}/${row.operator}/${row.candidateStrategy}`)).size, 96);
  t.diagnostic(JSON.stringify({schema:'c4-04-nontotal-binary-production-widths-v1',rows}));
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
