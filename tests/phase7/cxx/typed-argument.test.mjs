import test from 'node:test';
import assert from 'node:assert/strict';
import {createCppTypedArgumentEvidence,isCanonicalCppTypedArgumentEvidence} from '../../../js/analysis/cxx/typed-argument.js';

test('exact release ABI object-pointer signatures produce immutable argument evidence',()=>{
  for(const [symbol,className,pointeeConst] of [['_Z10readHealthP6Entity','Entity',false],
    ['_Z1fPK6Entity','Entity',true],['_Z1fPN2ns6EntityE','ns::Entity',false],
    ['_Z1fP6Entityiib','Entity',false],['_Z1fP6EntityPvPN2ns5OtherE','Entity',false]]) {
    const p=createCppTypedArgumentEvidence({symbol,functionAddress:3n});
    assert.ok(isCanonicalCppTypedArgumentEvidence(p));assert.equal(p.className,className);
    assert.equal(p.pointeeConst,pointeeConst);assert.equal(p.register,'x0');assert.equal(p.argumentIndex,0);
    assert.equal(p.receiverRole,'typed-argument');assert.ok(Object.isFrozen(p));
    assert.equal(isCanonicalCppTypedArgumentEvidence({...p}),false);
  }
});
test('unsupported or ambiguous signatures and ABI bindings fail closed',()=>{
  for(const symbol of ['_ZN6Entity1fEP6Entity','_ZNK6Entity1fEv','_Z1fIiEvP6Entity',
    '_ZplP6EntityS0_','_Z1fPi','_Z1fPv','_Z1fPP6Entity','_Z1fR6Entity','_Z1fP6Entityv',
    '_Z1fP6Entity'+ 'i'.repeat(16),'_Z1fP6EntityS0_',
    '_Z1fPS_','_Z1fP6Entityjunk','_Z01fP6Entity','_Z1fP06Entity','_Z1fPN2ns6Entity',
    '_Z1fP100Entity','_Z1fP6Ent!ty','_Z1fP'+ 'a'.repeat(1024)]) {
    assert.equal(createCppTypedArgumentEvidence({symbol,functionAddress:3n}),null,symbol);
  }
  for(const patch of [{architecture:'x86_64'},{functionAddress:-1n},{functionAddress:'3'},{functionAddress:null}])
    assert.equal(createCppTypedArgumentEvidence({symbol:'_Z1fP6Entity',functionAddress:3n,...patch}),null);
});
