import test from 'node:test';
import assert from 'node:assert/strict';
import { preparePhase8RewritePlan } from '../../../js/decompiler/phase8/pass-validation.js';
import { scalarEffectObligationReason } from '../../../js/semantics/compat/effect-obligations.js';
import { proofFixture } from '../helpers/proof-fixtures.mjs';

test('C4 scalar projection cannot replace a source with unresolved bundle faults or unwind', async () => {
  const cases = {possibleFaults:[{kind:'data-abort'}],faults:[{kind:'alignment'}],
    mayThrow:true,mayUnwind:true,unwindTargets:[1],unwindSummary:{kind:'cleanup'},
    undefinedResult:{reason:'unmodeled'}};
  for (const layer of ['instruction','extra','attributes','machineEffects']) {
    for (const [key,value] of Object.entries(cases)) {
      const f = proofFixture(4);
      let target = f.target.def;
      for (const nested of layer === 'instruction' ? [] :
        layer === 'extra' ? ['extra'] : layer === 'attributes' ? ['extra','attributes'] : ['extra','attributes','machineEffects']) {
        target = target[nested] ??= {};
      }
      target[key] = value;
      assert.equal(scalarEffectObligationReason(f.target.def),`unresolved-${key}`);
      const plan = await preparePhase8RewritePlan(f.ir,f.options);
      assert.equal(plan.entries.length,0,`${layer}/${key}: no scalar authority`);
      if (plan.status === 'complete') {
        assert.equal(plan.targetDecisions[0].disposition,'unsupported',`${layer}/${key}`);
        assert.equal(plan.targetDecisions[0].reason,`unresolved-${key}`);
      } else {
        assert.equal(plan.targetDecisions[0].disposition,'unknown');
        assert.match(plan.reason,/^(unbound-instruction-fault-annotation|unsupported-instruction-exceptional-edge-annotation)$/);
      }
    }
  }
});

test('C4 effect inspection rejects accessor obligations without executing them', () => {
  let reads = 0;
  const instruction = {extra:{attributes:{machineEffects:{}}}};
  Object.defineProperty(instruction.extra.attributes.machineEffects,'possibleFaults',{
    get() { reads++; return []; },enumerable:true,
  });
  assert.equal(scalarEffectObligationReason(instruction),'unresolved-possibleFaults');
  assert.equal(reads,0);
  assert.equal(scalarEffectObligationReason({extra:{attributes:{machineEffects:{
    possibleFaults:[],faults:[],mayThrow:false,mayUnwind:false,bundleCompleteness:'exact',
  }}}}),null);
});
