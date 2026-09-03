import assert from 'node:assert/strict';
import { validateCilEffectFunction } from '../js/managed/cil/validation.js';

function op(offset, { consumed=0, produced=0, controlEffects=[], callEffects=[], completeness='exact', bits=32 } = {}) {
  return {
    bytecodeOffset:offset,
    operationId:`op:${offset}`,
    consumedValues:Array.from({length:consumed}, () => ({ bits })),
    producedValues:Array.from({length:produced}, () => ({ bits })),
    controlEffects,
    callEffects,
    completeness,
  };
}
function validate(bundles, maxStack=8, context={}) {
  return validateCilEffectFunction({ methodId:'managed-method:test:0x06000001', profileId:'ecma-335', bundles, entryState:{maxStack}, exceptionRegions:[] }, context);
}

{
  const report = validate([op(0,{consumed:1}), op(1,{controlEffects:[{kind:'return'}]})]);
  assert.equal(report.status,'invalid');
  assert.ok(report.errors.some((e)=>e.code==='cil-stack-underflow'));
  assert.equal(report.completeness.specValidation,'failed');
}
{
  const report = validate([op(0,{produced:1}), op(1,{consumed:2,produced:1}), op(2,{controlEffects:[{kind:'return'}]})]);
  assert.equal(report.status,'invalid');
  assert.ok(report.errors.some((e)=>e.code==='cil-stack-underflow'));
}
{
  const report = validate([
    op(0,{controlEffects:[{kind:'conditional-branch',targetOffset:3}]}),
    op(1,{produced:1,controlEffects:[{kind:'branch',targetOffset:3}]}),
    op(3,{controlEffects:[{kind:'return'}]}),
  ]);
  assert.equal(report.status,'invalid');
  assert.ok(report.errors.some((e)=>e.code==='cil-stack-height-merge-mismatch'));
}
{
  const report = validate([op(0,{produced:1}), op(1,{produced:1}), op(2,{controlEffects:[{kind:'return'}]})],1);
  assert.equal(report.status,'invalid');
  assert.ok(report.errors.some((e)=>e.code==='cil-max-stack-exceeded'));
}
{
  const report = validate([op(0,{produced:1}), op(1,{consumed:1}), op(2,{controlEffects:[{kind:'return'}]})],1);
  assert.equal(report.status,'valid');
  assert.equal(report.completeness.specValidation,'valid');
}
{
  const report = validate([op(0,{controlEffects:[{kind:'branch',targetOffset:99}]})]);
  assert.equal(report.status,'invalid');
  assert.ok(report.errors.some((e)=>e.code==='cil-invalid-branch-target'));
}
{
  const report = validate([op(0,{callEffects:[{token:1}]}), op(1,{controlEffects:[{kind:'return'}]})]);
  assert.equal(report.status,'partial');
  assert.equal(report.completeness.resolution,'partial');
  assert.ok(report.warnings.some((w)=>w.code==='cil-call-stack-effect-unresolved'));
}

console.log('issue-1142-cil-stack-validation: PASS');
