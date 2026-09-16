import assert from 'node:assert/strict';
import test from 'node:test';
import { conditionalRegionFixture } from '../helpers/conditional-region-fixture.mjs';
import { identity } from '../helpers/proof-fixtures.mjs';
import { enhanceSemanticDecompilation } from '../../../js/decompiler/pipeline.js';
import {
  prepareConditionalRegionCondition,
  readConditionalRegionCondition,
} from '../../../js/decompiler/phase8/conditional-region-condition.js';
import {
  prepareConditionalRegionErasure,
  readRegionErasureBody,
} from '../../../js/decompiler/phase8/conditional-region-erasure.js';

function storeArm(builder, value) {
  const store = builder.store(value, { locKind:'global', locKey:'g', bits:8 });
  Object.assign(store.loc, { address:16n, addressSpace:'data' });
  store.extra = { completeness:'complete', addressPrecise:true, memoryAccess:{
    addressSpace:'data', widthBits:8, volatility:false, atomic:false,
    ordering:'unknown', endian:'little', faults:[],
  } };
}

const proofOptions = Object.freeze({
  identity,
  addressBits:8,
  backendTier:'exhaustive',
  timeoutMs:5000,
});

function fixture() {
  const f = conditionalRegionFixture({ armEffect:storeArm });
  const projection = enhanceSemanticDecompilation(f.seed, { name:'reachability', calls:[] }, {
    phase8PrepareProof:true,
    phase8PrepareRegionProof:true,
    deterministicTransforms:true,
    renderProvenance:true,
  });
  return { ...f, projection };
}

test('C4-04B issued condition binds the exact copied region and mints only private flat-body authority', async () => {
  const f = fixture();
  const conditionPlan = await prepareConditionalRegionCondition(f.structure, f.projection, proofOptions);
  assert.equal(conditionPlan.status, 'complete', conditionPlan.reason);
  const condition = readConditionalRegionCondition(conditionPlan, f.projection, f.structure, identity);
  assert.ok(condition);
  assert.equal(condition.region.original, f.structure.region);
  assert.equal(condition.header, condition.region.header);

  const reachability = await f.run();
  const plan = prepareConditionalRegionErasure(f.structure, reachability, f.ir, {
    identity,
    timeoutMs:5000,
    projection:f.projection,
    conditionPlan,
  });
  assert.equal(plan.status, 'complete', plan.reason);
  assert.equal(plan.bodyValidation, 'proved-no-phi-flat-stores');
  assert.deepEqual(plan.pendingValidation, ['removed-entity-provenance']);

  const body = readRegionErasureBody(plan, f.projection, f.ir, identity);
  assert.ok(body);
  assert.equal(body.scope, 'unreachable-render-arm-body-no-phi');
  assert.equal(body.condition, condition);
  assert.equal(body.header, condition.header);
  assert.equal(body.nodes.length, plan.removedNodes.length);
  assert.ok(body.nodes.length > 0);
  assert.ok(body.nodes.every(node => node.kind === 'stmt' && node.semantic?.op === 'store'));
  assert.ok(body.originalNodes.every(node => node.kind === 'stmt'));

  assert.equal(readRegionErasureBody(plan, { ...f.projection }, f.ir, identity), null,
    'copied projection metadata must not manufacture body authority');
  assert.equal(readRegionErasureBody({ ...plan }, f.projection, f.ir, identity), null,
    'copied public plan fields must not manufacture body authority');
});

test('C4-04B body authority is revoked when the observed copied region becomes stale', async () => {
  const f = fixture();
  const conditionPlan = await prepareConditionalRegionCondition(f.structure, f.projection, proofOptions);
  assert.equal(conditionPlan.status, 'complete', conditionPlan.reason);
  const reachability = await f.run();
  const plan = prepareConditionalRegionErasure(f.structure, reachability, f.ir, {
    identity,
    timeoutMs:5000,
    projection:f.projection,
    conditionPlan,
  });
  assert.equal(plan.bodyValidation, 'proved-no-phi-flat-stores');
  const body = readRegionErasureBody(plan, f.projection, f.ir, identity);
  assert.ok(body);

  body.nodes[0].text = `${body.nodes[0].text} /* stale */`;
  assert.equal(readRegionErasureBody(plan, f.projection, f.ir, identity), null);
});