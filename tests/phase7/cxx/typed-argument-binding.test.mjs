import test from 'node:test';
import assert from 'node:assert/strict';
import {createCxxEvidenceProvider} from '../../../js/analysis/cxx/project.js';
import {createCppTypedArgumentReceiverEvidence,isCanonicalCppReceiverEvidence,analyzeFunctionSymbol} from '../../../js/analysis/cxx/object-evidence.js';
import {createCppTypedArgumentEvidence} from '../../../js/analysis/cxx/typed-argument.js';
import {currentCppReceiver} from '../../../js/decompiler/cxx-evidence.js';
import {createCxxQueryPlanner} from '../../../js/analysis/cxx/query-recovery.js';
import {cxxSemanticViews} from '../../../js/analysis/query/cxx-semantic-preference.js';
import {pinpointField} from '../../../js/pinpoint.js';
import {parseGoal} from '../../../js/goals.js';
const symbol='_Z10readHealthP6Entity';
test('integral and enum template arguments retain exact ABI owner and receiver proof',async()=>{
 for(const [raw,owner] of [
  ['_ZNK3BoxILi2EE3getEv','Box<2>'],
  ['_ZNK3BoxILin2EE3getEv','Box<-2>'],
  ['_ZNK3BoxILb1EE3getEv','Box<true>'],
  ['_ZNK3BoxILN3abc4KindE1EE3getEv','Box<(abc::Kind)1>'],
 ]){
  const info=analyzeFunctionSymbol(raw);assert.equal(info.className,owner,raw);
  assert.equal(info.isConstMember,true);
  const p=createCxxEvidenceProvider({symbols:symbolsFor([raw]),read:()=>null,snapshotId:'literal-abi',
   cacheKey:raw,cache:{get:async()=>({classes:[],pointerBytes:8})}});
  await p.build();const projection=p.projectForFunction({functionId:'reader',functionAddress:1n,functionName:raw,ir});
  assert.equal(projection.receiver.classIdentity.className,owner);
  assert.equal(p.memberIndex().fieldCount,1);
 }
 for(const raw of ['_ZNK3BoxILb2EE3getEv','_ZNK3BoxILin0EE3getEv','_ZNK3BoxILi01EE3getEv',
  '_ZNK3BoxILi2147483648EE3getEv','_ZNK3BoxILjn1EE3getEv','_ZNK3BoxILd3ff0000000000000EE3getEv',
  '_ZNK3BoxILPi0EE3getEv','_ZNK3BoxIL_Z3foovEE3getEv','_ZNK3BoxILi2EE3getEvBAD'])
  assert.equal(analyzeFunctionSymbol(raw).className,undefined,raw);
 const ordinary=analyzeFunctionSymbol('_ZN3BoxILi2EE3getEv');
 assert.equal(ordinary.className,'Box<2>');assert.equal(ordinary.isConstMember,false);
});
test('ABI component boundaries keep method template namespaces out of owners',async()=>{
 const cases=[
  ['_ZNK6Widget3getIN3abc1XEEEiv','Widget','get<abc::X>'],
  ['_ZNK6WidgetIN3abc1XEE3getEv','Widget<abc::X>','get'],
  ['_ZNK3abc6WidgetIN3def1XEE3getIN3ghi1YEEEiv','abc::Widget<def::X>','get<ghi::Y>'],
  ['_ZNK6WidgetlsEi','Widget','operator<<'],
  ['_ZNK6WidgetclEv','Widget','operator()'],
 ];
 for(const [raw,owner,method] of cases){
  const info=analyzeFunctionSymbol(raw);
  assert.equal(info.className,owner,raw);assert.equal(info.methodName,method,raw);
  assert.equal(info.isConstMember,true,raw);
  const p=createCxxEvidenceProvider({symbols:symbolsFor([raw]),read:()=>null,snapshotId:'abi-components',
   cacheKey:raw,cache:{get:async()=>({classes:[],pointerBytes:8})}});
  await p.build();const projection=p.projectForFunction({functionId:'reader',functionAddress:1n,functionName:raw,ir});
  assert.equal(projection.receiver.classIdentity.className,owner);
  assert.equal(p.memberIndex().classCount,1);
  assert.equal([...p.memberIndex().classes.values()][0].name,owner);
 }
 for(const raw of ['_ZNK6Widget3getIN3abc1XEEEivBAD','_ZNK6Widget3getIN3abc1XEEiv'])
  assert.equal(analyzeFunctionSymbol(raw).className,undefined,raw);
 const ordinary=analyzeFunctionSymbol('_ZN6Widget3getIN3abc1XEEEiv');
 assert.equal(ordinary.className,'Widget');assert.equal(ordinary.isConstMember,false);
});
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
test('internal-linkage global functions bind an independently proven first object pointer',async()=>{
 const raw='_ZL5localP6Widgetb';
 const proof=createCppTypedArgumentEvidence({symbol:raw,functionAddress:1n});
 assert.equal(proof.className,'Widget');assert.equal(proof.register,'x0');assert.equal(proof.parameterCount,2);
 assert.equal(proof.internalLinkage,true);
 const symbols={names:[raw,'_ZN6WidgetD1Ev'],addrs:[1n,2n],funcs:[1n,2n],nameAt:a=>a===1n?raw:'_ZN6WidgetD1Ev'};
 const provider=createCxxEvidenceProvider({symbols,read:()=>null,snapshotId:'local-argument',cacheKey:'local-argument',
  cache:{get:async()=>({classes:[],pointerBytes:8})}});await provider.build();
 assert.equal(provider.projectForFunction({functionAddress:1n,functionId:'reader',ir,enableTypedArguments:true})?.receiver.classIdentity.className,'Widget');
 assert.equal(provider.memberIndex().fieldCount,1);
 const planner=createCxxQueryPlanner({symbols,isExecutable:()=>true,planningPolicy:'semantic-retrieval-v5'});
 assert.equal(planner.choices('widget').find(row=>row.address===1n).proof,'release-typed-object-argument');
 const noClass={...symbols,names:[raw],addrs:[1n],funcs:[1n]};
 assert.deepEqual(createCxxQueryPlanner({symbols:noClass,isExecutable:()=>true,planningPolicy:'semantic-retrieval-v5'}).choices('widget'),[],
  'a named pointee without independent class evidence still proves no owner');
});
test('internal-linkage argument decoding rejects local scopes, qualified names, repeated linkage and unknown signatures',()=>{
 for(const raw of ['_ZLL5localP6Widgetb','_ZLN6Widget5localEP6Widget','_ZZ5outervE5localP6Widget',
  '_ZL5localI6WidgetEvPT_','_ZL5localP6Widgetv','_ZL5localP6WidgetbBAD','_ZL5localP6WidgetJ'])
  assert.equal(createCppTypedArgumentEvidence({symbol:raw,functionAddress:1n}),null,raw);
});
test('display renames cannot create C++ ownership or enter binary-derived Jev contexts',async()=>{
 const forged='_ZNK6Oracle11secretFieldEv';
 const raw='_Z4readv';
 const symbols={names:[raw],addrs:[1n],funcs:[1n],nameAt:()=>forged};
 const make=async symbols=>{const p=createCxxEvidenceProvider({symbols,read:()=>null,snapshotId:'raw-symbols',
  cacheKey:'renames',cache:{get:async()=>({classes:[],pointerBytes:8})}});await p.build();return p;};
 let p=await make(symbols);
 assert.equal(p.projectForFunction({functionId:'reader',functionAddress:1n,functionName:forged,ir}),null);
 assert.equal(p.memberIndex().fieldCount,0);
 const legitimate='_ZNK6Widget4readEv';
 p=await make({...symbols,names:[legitimate]});
 const projection=p.projectForFunction({functionId:'reader',functionAddress:1n,functionName:forged,ir});
 assert.equal(projection.receiver.classIdentity.className,'Widget');
 const local=await pinpointField({goal:parseGoal('widget'),cxxFields:p.memberIndex(),limit:400});
 const views=cxxSemanticViews(local.candidates,{...symbols,names:[legitimate]});
 assert.ok(views.length);assert.equal(views[0].functionContexts[0].name,legitimate);
 assert.equal(JSON.stringify(views).includes('secretField'),false);
});
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
