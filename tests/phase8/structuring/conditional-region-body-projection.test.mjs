import assert from 'node:assert/strict';
import test from 'node:test';
import { conditionalRegionFixture } from '../helpers/conditional-region-fixture.mjs';
import { identity } from '../helpers/proof-fixtures.mjs';
import { enhanceSemanticDecompilation } from '../../../js/decompiler/pipeline.js';
import { prepareConditionalRegionCondition } from '../../../js/decompiler/phase8/conditional-region-condition.js';
import {
  prepareConditionalRegionErasure,
  readRegionErasureBody,
} from '../../../js/decompiler/phase8/conditional-region-erasure.js';
import { runPhase8Vertical } from '../../../js/decompiler/phase8/index.js';
import {
  applyPhase8Projection,
  readProjectedConditionalRegions,
} from '../../../js/decompiler/phase8/projection.js';
import { validateRenderProvenance } from '../../../js/decompiler/phase8/render-provenance.js';

function storeArm(builder, value) {
  const store = builder.store(value, { locKind:'global', locKey:'g', bits:8 });
  Object.assign(store.loc, { address:16n, addressSpace:'data' });
  store.extra = { completeness:'complete', addressPrecise:true, memoryAccess:{
    addressSpace:'data', widthBits:8, volatility:false, atomic:false,
    ordering:'unknown', endian:'little', faults:[],
  } };
}

function removeJoinPhi(ir) {
  const input = ir.values.find(value => value.kind === 'arg' && value.reg === 'x0');
  const join = ir.blocks[3];
  assert.ok(input && join);
  join.phis = [];
  const ret = join.insts.find(inst => inst.op === 'ret');
  assert.ok(ret);
  ret.args = [{ value:input }];
  ir.instructions = ir.blocks.flatMap(block => [...block.phis, ...block.insts]);
}

async function committed() {
  const f = conditionalRegionFixture({ armEffect:storeArm, mutate:removeJoinPhi });
  assert.equal(f.structure.phis.length, 0);
  const projection = enhanceSemanticDecompilation(f.seed, { name:'reachability', calls:[] }, {
    phase8PrepareProof:true,
    phase8PrepareRegionProof:true,
    deterministicTransforms:true,
    renderProvenance:true,
  });
  const conditionPlan = await prepareConditionalRegionCondition(f.structure, projection, {
    identity,
    addressBits:8,
    backendTier:'exhaustive',
    timeoutMs:5000,
  });
  assert.equal(conditionPlan.status, 'complete', conditionPlan.reason);
  const reachability = await f.run();
  const plan = prepareConditionalRegionErasure(f.structure, reachability, f.ir, {
    identity,
    timeoutMs:5000,
    projection,
    conditionPlan,
  });
  assert.equal(plan.status, 'complete', plan.reason);
  assert.equal(plan.bodyValidation, 'proved-no-phi-flat-stores');
  const body = readRegionErasureBody(plan, projection, f.ir, identity);
  assert.ok(body);
  const opts = { phase8ProofIdentity:identity, phase8RegionErasurePlan:plan };
  const stage = runPhase8Vertical({ ir:f.ir, opts, enabledStages:['rendering'] }, { timeBudgetMs:1000 });
  assert.equal(stage.ledger.published, true, JSON.stringify(stage.ledger));
  assert.equal(stage.ledger.completeness, 'complete');
  return { ...f, projection, plan, body, opts, stage };
}

test('C4-04B committed private body authority removes only the proved render arm and publishes tombstones', async () => {
  const f = await committed();
  const canonical = structuredClone(f.ir);
  const originalBody = [...f.projection.cAst.body];
  const originalText = f.projection.pseudocode;
  const result = applyPhase8Projection(f.projection, f.stage.analysis, f.opts);

  assert.notEqual(result.cAst, f.projection.cAst);
  assert.equal(result.cAst.body.length, originalBody.length - f.body.nodes.length);
  assert.equal(f.projection.cAst.body.length, originalBody.length, 'prepared producer stays immutable');
  assert.equal(f.projection.pseudocode, originalText);
  assert.deepEqual(structuredClone(f.ir), canonical, 'render adoption must not edit Semantic IR/SSA/CFG');

  const removals = result.rewriteProof.filter(record => record.rule === 'erase-proved-unreachable-arm-store');
  assert.equal(removals.length, f.body.nodes.length);
  assert.deepEqual(removals.map(record => record.renderedRemoval.lineIndex).sort((a, b) => a - b),
    f.body.nodes.map(node => originalBody.indexOf(node)).sort((a, b) => a - b));
  assert.ok(removals.every(record => record.renderedRemoval.scope === 'pre-transform-render'
    && record.renderedRemoval.operation === 'remove'));

  const ledger = result.renderProvenance.ledger.filter(record => record.rule === 'erase-proved-unreachable-arm-store');
  assert.equal(ledger.length, removals.length);
  assert.ok(ledger.every(record => record.renderedBinding === 'producer-bound' && record.removedRefs.length === 1));
  for (const record of ledger) {
    assert.ok(record.removedRefs.every(ref => !Object.hasOwn(result.renderProvenance.entities, ref)));
  }
  assert.equal(result.renderProvenance.completeness, 'complete');
  assert.equal(validateRenderProvenance(result.renderProvenance).state, 'complete');

  const carrier = readProjectedConditionalRegions(result.cAst, f.ir);
  assert.ok(carrier);
  const projected = carrier.regions.find(region => region.original === f.structure.region);
  assert.ok(projected);
  assert.deepEqual(projected.arms.find(arm => arm.role === f.plan.removedRole).nodes, []);
  assert.ok(projected.arms.find(arm => arm.role === f.plan.liveRole).nodes.length > 0);
});

test('C4-04B removal is all-or-nothing when provenance history cannot fit', async () => {
  const f = await committed();
  const result = applyPhase8Projection(f.projection, f.stage.analysis, {
    ...f.opts,
    renderProvenanceBudget:{ maxTransformRecords:1 },
  });
  assert.equal(result, f.projection);
  assert.equal(result.rewriteProof.some(record => record.rule === 'erase-proved-unreachable-arm-store'), false);
});