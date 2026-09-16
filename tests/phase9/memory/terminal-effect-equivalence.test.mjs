import assert from 'node:assert/strict';
import test from 'node:test';
import { queryTerminalEffectEquivalence, isAdoptableTerminalEffectEquivalence } from '../../../js/symbolic/query/terminal-effect-equivalence.js';
import { partialStoreFixture, identity } from './main-fixtures.mjs';

function faultDescriptor() {
  return { kind:'pc-alignment-fault', condition:{ kind:'target-misaligned', alignmentBytes:4 },
    detail:{ architecture:'arm64', instructionSet:'a64' } };
}
function withFaultTarget(ir, target) {
  const ret = ir.instructions.find(inst => inst.op === 'ret');
  ret.returnTargetValue = typeof target === 'bigint' ? { id:`pc-${target}`, kind:'const', const:target, bits:64 } : target;
  ret.extra = { ...(ret.extra ?? {}), returnControlTargetValueId:'return-pc',
    returnControlTarget:{ schema:'semantic-return-control-target/v1', state:'resolved', valueId:'return-pc' },
    attributes:{ ...((ret.extra ?? {}).attributes ?? {}), machineEffects:{ bundleCompleteness:'exact', unknownEffects:false,
      architectureId:'arm64', mode:'a64', possibleFaults:[faultDescriptor()] } } };
  return ir;
}
const request = (beforeIr, afterIr, extra={}) => ({ identity:{...identity,architecture:'arm64'}, beforeIr, afterIr,
  inputs:[], preconditions:[], timeoutMs:5000, backendTier:'tiered', ...extra });

test('C4-04B proves the complete canonical return fault effect, not a guessed normal return', async () => {
  for (const target of [0x1000n,0x1001n]) {
    const q = request(withFaultTarget(partialStoreFixture(),target), withFaultTarget(partialStoreFixture(),target));
    const result = await queryTerminalEffectEquivalence(q);
    assert.equal(result.verdict,'proved',result.reason);
    assert.equal(result.eligible,true);
    assert.equal(result.scope.kind,'terminal-control-effects');
    assert.deepEqual(result.scope.effects,['terminal-control-target','terminal-control-normal-completion','terminal-fault-predicates']);
    assert.deepEqual(result.scope.faultKinds,['pc-alignment-fault']);
    assert.equal(isAdoptableTerminalEffectEquivalence(result,q),true);
  }
});

test('C4-04B refutes a changed canonical terminal target/fault predicate', async () => {
  const result = await queryTerminalEffectEquivalence(request(
    withFaultTarget(partialStoreFixture(),0x1000n), withFaultTarget(partialStoreFixture(),0x1001n)));
  assert.equal(result.verdict,'refuted',result.reason);
  assert.equal(result.eligible,false);
});

test('C4-04B uses one explicit symbolic input correspondence for faulting and normal valuations', async () => {
  const beforeTarget={id:'before-pc',kind:'arg',reg:'x0',index:0,bits:64};
  const afterTarget={id:'after-pc',kind:'arg',reg:'x0',index:0,bits:64};
  const before=withFaultTarget(partialStoreFixture(),beforeTarget), after=withFaultTarget(partialStoreFixture(),afterTarget);
  const q=request(before,after,{inputs:[{before:beforeTarget,after:afterTarget}]});
  const result=await queryTerminalEffectEquivalence(q);
  assert.equal(result.verdict,'proved',result.reason);
  assert.equal(isAdoptableTerminalEffectEquivalence(result,q),true);
  afterTarget.bits=32;
  assert.equal(isAdoptableTerminalEffectEquivalence(result,q),false,'issued execution currentness revokes the receipt');
});

test('C4-04B rejects noncanonical exceptional annotations instead of laundering them into the effect proof', async () => {
  const before=withFaultTarget(partialStoreFixture(),0x1000n), after=withFaultTarget(partialStoreFixture(),0x1000n);
  after.instructions.at(-1).extra.mayUnwind=true;
  const result=await queryTerminalEffectEquivalence(request(before,after));
  assert.equal(result.eligible,false);
  assert.equal(result.verdict,'unknown');
  assert.match(result.reason,/unsupported-instruction-exceptional-edge-annotation|incomplete-terminal-control-coverage|execution:/);
});
