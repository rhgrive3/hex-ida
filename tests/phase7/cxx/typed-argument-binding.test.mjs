import test from 'node:test';
import assert from 'node:assert/strict';
import {createCxxEvidenceProvider} from '../../../js/analysis/cxx/project.js';
import {createCppTypedArgumentReceiverEvidence,isCanonicalCppReceiverEvidence,analyzeFunctionSymbol} from '../../../js/analysis/cxx/object-evidence.js';
import {createCppTypedArgumentEvidence} from '../../../js/analysis/cxx/typed-argument.js';
import {currentCppReceiver} from '../../../js/decompiler/cxx-evidence.js';
import {createCxxQueryPlanner} from '../../../js/analysis/cxx/query-recovery.js';
const symbol='_Z10readHealthP6Entity';
test('only outer ABI role tokens prove constructors, destructors or const members',()=>{
 for(const raw of ['_ZN3Foo3FooEv','_ZN3Foo5aC1EbEv','_ZN3Foo1fEPK3Foo']) {
  const role=analyzeFunctionSymbol(raw);assert.equal(role.isConstructor,false,raw);
  assert.equal(role.isDestructor,false,raw);assert.equal(role.isConstMember,false,raw);
 }
 for(const raw of ['_ZN3FooC1Ev','_ZN3FooC2Ev','_ZN3BoxIiEC1Ev'])
  assert.equal(analyzeFunctionSymbol(raw).isConstructor,true,raw);
 assert.equal(analyzeFunctionSymbol('_ZN3FooD1Ev').isDestructor,true);
 assert.equal(analyzeFunctionSymbol('_ZNK3Foo1fEv').isConstMember,true);
 assert.equal(analyzeFunctionSymbol('_ZN3FooC9Ev').isCxx,true);
 assert.equal(analyzeFunctionSymbol('_ZN3FooC9Ev').isConstructor,false);
});
const ir={functionId:'reader',values:[{id:'arg0',kind:'arg',reg:'x0',bits:64}],instructions:[
 {id:'read',op:'load',loc:{kind:'field',base:{id:'arg0'},disp:8n,size:4},dst:{id:'value',bits:32}}]};
function symbolsFor(names=[symbol]){return{names,addrs:names.map(()=>1n),funcs:[1n],nameAt:()=>names[0]};}
async function provider(names=[symbol],snapshotId='first',knownClass=true){
 let reads=0;const p=createCxxEvidenceProvider({symbols:symbolsFor(names),read:()=>{reads++;return null;},snapshotId,
  cacheKey:'bound',cache:{get:async()=>({classes:knownClass?[{className:'Entity',vtableAddress:16n,offsetToTop:0n,slots:[]}]:[],pointerBytes:8})}});
 await p.build();assert.equal(reads,0);return p;
}
test('typed object arguments publish only in explicit recovery and never become this',async()=>{
 const p=await provider(),request={functionId:'reader',functionAddress:1n,functionName:symbol,ir};
 assert.equal(p.projectForFunction(request),null);
 const projection=p.projectForFunction({...request,enableTypedArguments:true});
 assert.ok(isCanonicalCppReceiverEvidence(projection.receiver));
 assert.equal(projection.receiver.receiverRole,'typed-argument');
 assert.equal(projection.receiver.nonStaticProof,null);
 assert.equal(projection.receiver.classIdentity.className,'Entity');
 assert.equal(projection.members.length,1);assert.equal(p.memberIndex().fieldCount,1);
 assert.equal(currentCppReceiver({addr:1n,cxxEvidence:projection},ir),null,'a typed argument must not render as this');
 const later=await provider([symbol],'later');
 const next=later.projectForFunction({...request,enableTypedArguments:true});
 assert.notEqual(projection.receiver.digest,next.receiver.digest);
 assert.notEqual(p.memberIndex().classes.values().next().value.ownerKey,later.memberIndex().classes.values().next().value.ownerKey);
 const noClassProof=await provider([symbol],'unverified-type',false);
 assert.equal(noClassProof.projectForFunction({...request,enableTypedArguments:true}),null,'a named ABI type alone might be an enum');
});
test('argument evidence cannot be cloned or rebound to another function, and aliases fail closed',async()=>{
 const proof=createCppTypedArgumentEvidence({symbol,functionAddress:1n});
 const input={argumentProof:proof,classIdentity:{kind:'named',className:'Entity',vtableAddress:16n,offsetToTop:0n},functionId:'reader',functionAddress:1n,canonicalValueId:'arg0',snapshotId:'bound'};
 assert.throws(()=>createCppTypedArgumentReceiverEvidence({...input,argumentProof:{...proof}}),/proof-required/);
 assert.throws(()=>createCppTypedArgumentReceiverEvidence({...input,functionAddress:2n}),/function-binding/);
 assert.throws(()=>createCppTypedArgumentReceiverEvidence({...input,classIdentity:null}),/class-proof-required/);
 const p=await provider([symbol,'_Z10readHealthP5Other']);
 assert.equal(p.projectForFunction({functionId:'reader',functionAddress:1n,functionName:symbol,ir,enableTypedArguments:true}),null);
 const planner=createCxxQueryPlanner({symbols:symbolsFor([symbol,'_Z10readHealthP5Other']),isExecutable:()=>true,planningPolicy:'value-accessor-v3'});
 assert.equal(planner.functionCount,0);
 const invalidAlias=createCxxQueryPlanner({symbols:symbolsFor([symbol,'_Z8unprovenv']),isExecutable:()=>true,planningPolicy:'value-accessor-v3'});
 assert.equal(invalidAlias.functionCount,0);
});
