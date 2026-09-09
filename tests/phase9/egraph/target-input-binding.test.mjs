import assert from 'node:assert/strict';
import test from 'node:test';
import { querySymbolicAnalysis, readSymbolicTargetInputs } from '../../../js/symbolic/query/analysis.js';
import { createTaintModels } from '../../../js/symbolic/taint/models.js';
import { preparePhase8RewritePlan, isPhase8RewritePlan } from '../../../js/decompiler/phase8/pass-validation.js';
import { identity } from '../taint/fixtures.mjs';

const models = createTaintModels({ id:'target-inputs', version:'1', provenance:'input-binding-regression', sources:[], sinks:[] });

function fixture() {
  const a = { id:'a', kind:'arg', reg:'x0', index:0, bits:4 };
  const b = { id:'b', kind:'arg', reg:'x0', index:1, bits:4 };
  const zero = { id:'zero', bits:4 }, target = { id:'target', bits:4 }, swapped = { id:'swapped', bits:4 };
  const sub = { id:'sub', op:'bin', sub:'sub', args:[{ value:b }, { value:b }], dst:zero, row:0, address:0n };
  const add = { id:'add', op:'bin', sub:'add', args:[{ value:a }, { value:zero }], dst:target, row:1, address:4n };
  const reverse = { id:'reverse', op:'bin', sub:'add', args:[{ value:b }, { value:a }], dst:swapped, row:2, address:8n };
  const ret = { id:'ret', op:'ret', args:[{ value:target }], row:3, address:12n };
  zero.def = sub; target.def = add; swapped.def = reverse;
  const instructions = [sub, add, reverse, ret];
  const ir = { entry:0, values:[a, b, zero, target, swapped], instructions,
    blocks:[{ index:0, insts:instructions, succ:[] }] };
  return { ir, a, b, zero, target, swapped };
}

const options = { identity, models, memory:{ addressBits:8 }, candidateStrategy:'equality-saturation', timeoutMs:2000, backendTier:'tiered' };

test('C4-04 actual translated inputs retain distinct SSA objects despite equal register spelling', async () => {
  const f = fixture();
  const result = await querySymbolicAnalysis(f.ir, { ...options, targets:[f.target] });
  assert.equal(result.status, 'complete', result.reason);
  const binding = readSymbolicTargetInputs(result, f.target);
  assert.equal(binding.expression, result.targets[0].expression);
  assert.deepEqual(binding.inputs.map(input => input.value), [f.b, f.a]);
  assert.deepEqual(binding.inputs.map(input => input.valueId), ['b', 'a']);
  assert.equal(new Set(binding.inputs.map(input => input.symbol.symbolId)).size, 2);
  assert.ok(binding.inputs.every(input => input.symbol.kind === 'fresh_symbol' && input.bits === 4));
  const survivingInput = binding.inputs.find(input => input.value === f.a);
  const candidate = result.targets[0].candidates.find(candidate => candidate.after === survivingInput.symbol);
  assert.ok(candidate, 'extraction retains the actual surviving input symbol');
  assert.equal(candidate.eligible, false, 'input correspondence is not proof authority');
  assert.equal(candidate.verification.reason, 'ambiguous-symbol-name-handoff');
  assert.ok(Object.isFrozen(binding) && Object.isFrozen(binding.inputs) && binding.inputs.every(Object.isFrozen));
});

test('C4-04 an independently proved nonconstant candidate resolves through the actual input relation', async () => {
  const f = fixture(); f.b.reg = 'x1';
  const result = await querySymbolicAnalysis(f.ir, { ...options, targets:[f.target] });
  assert.equal(result.status, 'complete', result.reason);
  const binding = readSymbolicTargetInputs(result, f.target);
  const input = binding.inputs.find(input => input.value === f.a);
  assert.ok(result.targets[0].candidates.some(candidate => candidate.eligible && candidate.after === input.symbol));
  assert.equal(binding.inputs.find(input => input.value === f.b).symbol.name, 'arg_x1');
});

test('C4-04 each target owns its translation order and shared dependencies are captured once', async () => {
  const f = fixture();
  const result = await querySymbolicAnalysis(f.ir, { ...options, targets:[f.target, f.swapped] });
  assert.equal(result.status, 'complete', result.reason);
  const forward = readSymbolicTargetInputs(result, f.target), reverse = readSymbolicTargetInputs(result, f.swapped);
  assert.deepEqual(forward.inputs.map(input => input.value), [f.b, f.a]);
  assert.deepEqual(reverse.inputs.map(input => input.value), [f.a, f.b]);
  assert.notEqual(forward, reverse);
  assert.equal(forward.inputs[0].symbol.symbolId, reverse.inputs[0].symbol.symbolId,
    'a query-local ordinal can denote different inputs in different target scopes');
  assert.notEqual(forward.inputs[0].value, reverse.inputs[0].value);
  assert.notEqual(forward.inputs[0].symbol, reverse.inputs[1].symbol);
  assert.equal(forward.inputs.filter(input => input.value === f.b).length, 1);
});

test('C4-04 numeric and string SSA IDs remain distinct in the captured relation', async () => {
  const f = fixture(); f.a.id = 0; f.b.id = '0';
  const result = await querySymbolicAnalysis(f.ir, { ...options, targets:[f.target] });
  assert.equal(result.status, 'complete', result.reason);
  const binding = readSymbolicTargetInputs(result, f.target);
  assert.deepEqual(binding.inputs.map(input => input.valueId), ['0', 'legacy-number:0']);
  assert.deepEqual(binding.inputs.map(input => input.rawValueId), ['0', 0]);
});

test('C4-04 copied results or targets and mismatched identity cannot issue input correspondence', async () => {
  const f = fixture();
  const result = await querySymbolicAnalysis(f.ir, { ...options, targets:[f.target] });
  assert.ok(readSymbolicTargetInputs(result, f.target));
  assert.equal(readSymbolicTargetInputs({ ...result }, f.target), null);
  assert.equal(readSymbolicTargetInputs(result, { ...f.target }), null);
  assert.equal(readSymbolicTargetInputs(result, f.target, { ...identity, snapshotId:'other' }), null);
  assert.equal(readSymbolicTargetInputs(result, f.swapped), null);
  let reads = 0;
  assert.equal(readSymbolicTargetInputs({ get identity() { reads++; throw new Error('unissued getter'); } }, f.target), null);
  assert.equal(reads, 0, 'an unissued query cannot invoke an identity getter');
});

test('C4-04 stale input identity, width or source graph invalidates its correspondence', async () => {
  for (const mutate of [
    f => { f.a.id = 'renamed'; },
    f => { f.a.bits = 8; },
    f => { f.target.def.args[0].value = f.b; },
    f => { Object.defineProperty(f.a, 'id', { get() { throw new Error('getter must not run'); }, enumerable:true }); },
  ]) {
    const f = fixture();
    const result = await querySymbolicAnalysis(f.ir, { ...options, targets:[f.target] });
    assert.ok(readSymbolicTargetInputs(result, f.target));
    mutate(f);
    assert.equal(readSymbolicTargetInputs(result, f.target), null);
  }
});

test('C4-04 universal input binding is independent of path-specific execution values', async () => {
  const f = fixture();
  const result = await querySymbolicAnalysis(f.ir, { ...options, targets:[f.target], execution:{ symbolicArgs:{ 0:0n, 1:0n } } });
  assert.equal(result.status, 'complete', result.reason);
  const binding = readSymbolicTargetInputs(result, f.target);
  assert.ok(binding);
  assert.ok(binding.inputs.every(input => input.symbol.kind === 'fresh_symbol'));
  assert.ok(binding.inputs.some(input => input.value === f.a));
});

test('C4-04 cancellation, exhausted query budget and stale epoch expose no usable input relation', async () => {
  for (const extra of [{ timeoutMs:0 }, { analysisLimits:{ allocationUnits:0 } }, { isCancelled:() => true }]) {
    const f = fixture(), result = await querySymbolicAnalysis(f.ir, { ...options, ...extra, targets:[f.target] });
    assert.equal(result.status, 'partial');
    assert.equal(readSymbolicTargetInputs(result, f.target), null);
  }
  const f = fixture(), controller = new AbortController();
  let current = identity;
  const result = await querySymbolicAnalysis(f.ir, { ...options, targets:[f.target], signal:controller.signal, getCurrentIdentity:() => current });
  assert.ok(readSymbolicTargetInputs(result, f.target));
  current = { ...identity, snapshotId:'new' };
  assert.equal(readSymbolicTargetInputs(result, f.target), null);
  current = identity;
  controller.abort();
  assert.equal(readSymbolicTargetInputs(result, f.target), null);
});

test('C4-04 the real Phase 8 plan retains input audit IDs while private correspondence guards its admission', async () => {
  const f = fixture();
  const request = { ...options, abiId:'generic-v1', targets:[f.zero] };
  const plan = await preparePhase8RewritePlan(f.ir, request);
  assert.equal(plan.status, 'complete', plan.reason);
  assert.equal(plan.entries.length, 1);
  const inputs = plan.entries[0].inputBindings;
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].valueId, 'b');
  assert.equal(inputs[0].rawValueId, f.b.id);
  assert.equal(inputs[0].bits, 4);
  assert.equal(typeof inputs[0].symbolId, 'string');
  assert.ok(Object.isFrozen(inputs) && Object.isFrozen(inputs[0]));
  const context = { ir:f.ir, proofIdentity:identity, abiId:request.abiId };
  assert.equal(isPhase8RewritePlan(plan, context), true);
  assert.equal(isPhase8RewritePlan({ ...plan }, context), false);
  f.b.id = 'changed';
  assert.equal(isPhase8RewritePlan(plan, context), false);
});
