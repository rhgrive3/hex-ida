import test from 'node:test';
import assert from 'node:assert/strict';
import { createCxxQueryPlanner } from '../../../js/analysis/cxx/query-recovery.js';
import { jevRecoveryRequest, selectJevRecoveryPlan, createJevRecoveryClient } from '../../../js/analysis/query/jev-recovery.js';
import { jevValueFlowRequest,jevSemanticRoute,jevMemberContextSignature,rerankAnonymousCxx,createJevMemberClient } from '../../../js/analysis/query/jev-advisory.js';
import {createCppReceiverEvidence,createCppMemberEvidence} from '../../../js/analysis/cxx/object-evidence.js';
import {CxxMemberIndex} from '../../../js/analysis/cxx/member-index.js';

function anonymousLocal(sameContext=false) {
 const receiver=createCppReceiverEvidence({functionId:'1',functionAddress:1n,canonicalValueId:'arg0',
  classIdentity:{kind:'named',className:'Widget'},receiverRole:'this',nonStaticProof:{rule:'vtable-slot'},
  abiBinding:{register:'x0',argumentIndex:0,architecture:'arm64'},snapshotId:'bound',completeness:'complete'});
 const index=new CxxMemberIndex();index.publish({receiver,members:[0,1].map(i=>createCppMemberEvidence({
  functionId:'1',receiverDigest:receiver.digest,snapshotId:'bound',offsetBytes:BigInt(8+i),sizeBytes:1,
  category:'bool-like',typeLabel:'bool|uint8_t',rule:'boolean-machine-use',readCount:1,writeCount:1,
  accessRoles:sameContext?['constant-written']:i?['constant-written','one-written']:['argument-written']}))});
 const candidates=[...index.classes.values()].flatMap(cls=>cls.ivars.map(field=>({
  key:field.key,source:'cxx',anonymous:true,className:cls.name,field,offset:field.offset,size:field.size,
  recoveredType:field.recoveredType,provenance:field.provenance})));
 return {top:candidates[0],candidates,verdict:'ambiguous'};
}
test('automatic anonymous routing vetoes identical context and fails closed on stale or invalid remote results',async()=>{
 const symbols={nameAt:()=> '_ZN6Widget6updateEb'},local=anonymousLocal();let calls=0;
 const client={call:async()=>{calls++;return {selectedKey:local.candidates[1].key,choiceIndex:1};}};
 const opts={enabled:true,isCurrent:()=>true,symbols,client};
 assert.equal((await rerankAnonymousCxx('Has the operation finished?',local,opts)).source,'jev');
 assert.equal((await rerankAnonymousCxx('finished?',local,{...opts,enabled:false})).top1,local.top);
 assert.equal((await rerankAnonymousCxx('finished?',{...local,verdict:'confirmed'},opts)).source,'hex');
 assert.equal(calls,1,'disabled and strong results never call the API');
 const indistinguishable=anonymousLocal(true);
 assert.equal((await rerankAnonymousCxx('finished?',indistinguishable,{...opts,
  client:{call:async()=>({choiceIndex:1})}})).top1,indistinguishable.top);
 for(const bad of [{selectedKey:'invented'},{choiceIndex:255},{selectedKey:local.top.key,choiceIndex:1}])
  assert.equal((await rerankAnonymousCxx('finished?',local,{...opts,client:{call:async()=>bad}})).top1,local.top);
 assert.equal((await rerankAnonymousCxx('finished?',local,{...opts,timeoutMs:2,client:{call:()=>new Promise(()=>{})}})).top1,local.top);
 let current=true;
 assert.equal((await rerankAnonymousCxx('finished?',local,{...opts,isCurrent:()=>current,
  client:{call:async()=>{current=false;return {choiceIndex:1};}}})).top1,local.top);
 assert.equal(local.verdict,'ambiguous');assert.equal(local.top,local.candidates[0]);
});
test('anonymous HTTP client uses only branded release facts and rejects malformed responses',async()=>{
 const local=anonymousLocal(),symbols={nameAt:()=> '_ZN6Widget6updateEb'};let calls=0;
 const valid={model:'openjev',answers:{pick:{type:'choice',choice:'c1',confidence:0.6,probabilities:{c1:0.6}},unique:{type:'noul',noul:0.5}}};
 let payload=valid,ok=true;
 const client=createJevMemberClient({apiKey:'secret-test-key',symbols,fetchImpl:async(_url,options)=>{
  calls++;assert.ok(!options.body.includes('secret-test-key'));assert.ok(!options.body.includes('SECRET_ORACLE'));
  assert.equal(options.headers.authorization,'Bearer secret-test-key');return {ok,json:async()=>payload};}});
 local.candidates[0].oracle='SECRET_ORACLE';
 assert.equal((await client.call({query:'finished?',candidates:local.candidates})).selectedKey,local.candidates[1].key);
 for(const response of [{...valid,model:'invented'}, {...valid,answers:{...valid.answers,pick:{...valid.answers.pick,choice:'c255'}}},
  {...valid,answers:{...valid.answers,unique:{type:'noul',noul:2}}},{}]) {
  payload=response;assert.equal(await client.call({query:'finished?',candidates:local.candidates}),null);
 }
 ok=false;assert.equal(await client.call({query:'finished?',candidates:local.candidates}),null);
 const previous=calls;
 assert.equal(await client.call({query:'finished?',candidates:local.candidates.map(candidate=>({...candidate,field:{...candidate.field}}))}),null);
 assert.equal(calls,previous,'serialized evidence cannot authorize an external request');
 assert.equal(createJevMemberClient({apiKey:''}),null);
});

test('selective semantics preserve strong and unique local accessors and expose indistinguishable contexts',()=>{
 const views=[{key:'a',source:'cxx',anonymous:true,className:'Widget',conflict:false,
  functionContexts:[{address:'1',name:'_ZNK6Widget8getCountEv',accessRoles:['return-input']}]},
  {key:'b',source:'cxx',anonymous:true,className:'Widget',conflict:false,
  functionContexts:[{address:'2',name:'_ZN6Widget6updateEb',accessRoles:['argument-written']}]}];
 assert.equal(jevSemanticRoute('current count',views,{verdict:'likely'}).reason,'strong-local-result');
 assert.equal(jevSemanticRoute('current count',views,{topKey:'a'}).reason,'unique-local-accessor');
 assert.equal(jevSemanticRoute('has processing finished',views,{topKey:'a'}).call,true);
 assert.equal(jevSemanticRoute('current count',views.map(view=>({...view,anonymous:false}))).call,false);
 const same={...views[0],key:'c',offset:99,size:1};
 assert.equal(jevMemberContextSignature(views[0]),jevMemberContextSignature(same),'an offset/width does not invent semantics');
 assert.equal(jevSemanticRoute('finished',views.map(view=>({...view,functionContexts:[{address:'1',name:'_ZN6WidgetC1Ev',accessRoles:['zero-written']}]}))).call,false);
});

test('prospective value-flow descriptions ignore oracle labels and bound canonical machine roles',()=>{
  const view={className:'Widget',offset:9,size:1,recoveredType:{category:'bool-like',proven:true},
    sourceFieldName:'SECRET_ORACLE_FIELD',oracle:{name:'SECRET_ORACLE_FIELD'},
    functionContexts:Array.from({length:80},(_,index)=>({address:String(index+1),
      name:'_ZN6Widget6updateEb',receiverProven:true,accessRoles:['constant-written','SECRET_ORACLE_FIELD']}))};
  const body=jevValueFlowRequest('Is the work complete?',[view]);
  assert.equal(JSON.stringify(body).includes('SECRET_ORACLE_FIELD'),false);
  assert.equal((body.questions.pick.criteria.c0.match(/store roles:/g)??[]).length,8);
  assert.ok(body.questions.pick.criteria.c0.includes('constant-written'));
  assert.equal(view.functionContexts.length,80,'projection must not mutate its input');
});

function planner() {
  return createCxxQueryPlanner({ symbols: { funcs: [1n,2n,3n], addrs: [1n,2n,3n],
    names: ['_ZNK6Widget8GetCountEv','_ZNK5Other8GetCountEv','_ZN6WidgetC1Ev'] }, isExecutable: () => true });
}
const answer = choice => ({ type: 'choice', choice, confidence: 1, probabilities: { [choice]: 1 } });
const payload = (object, pick) => ({ model: 'openjev', answers: { object: answer(object), pick: answer(pick) } });

test('semantic retrieval selects only existing proven release functions and agrees on owning object', async () => {
  const p=planner(), choices=p.choices('unrelated phrase'), selected=choices.findIndex(row=>row.className==='Widget');
  let calls=0;
  const result=await selectJevRecoveryPlan('unrelated phrase',p,{enabled:true,isCurrent:()=>true,
    client:{call:async input=>{calls++;assert.ok(input.signal instanceof AbortSignal);
      const body=jevRecoveryRequest(input.query,input.choices.map(row=>({...row,oracleFieldName:'forbidden_oracle'})));
      assert.ok(!JSON.stringify(body).includes('forbidden_oracle'));return payload(`c${selected}`,`c${selected}`);}}});
  assert.equal(calls,1);assert.equal(result.source,'jev-retrieval');assert.equal(result.selectedClass,'Widget');
  assert.ok(result.plan.every(row=>row.className==='Widget'));assert.equal(result.plan[0].address,choices[selected].address);
  const other=choices.findIndex(row=>row.className==='Other');
  const inconsistent=await selectJevRecoveryPlan('unrelated phrase',p,{enabled:true,isCurrent:()=>true,
    client:{call:async()=>payload(`c${selected}`,`c${other}`)}});
  assert.equal(inconsistent.source,'hex');assert.deepEqual(inconsistent.plan,[]);
  assert.equal(createJevRecoveryClient({}),null);
  const http=createJevRecoveryClient({apiKey:'test-key',fetchImpl:async(url,options)=>{
    assert.equal(url,'https://api.openjev.sh/v1/systemone');
    assert.ok(!options.body.includes('forbidden_oracle'));assert.ok(!options.body.includes('test-key'));
    return {ok:false};}});
  assert.equal(await http.call({query:'count',choices,body:{oracle:'forbidden_oracle'}}),null);
});

test('disabled, stale, HTTP failure, malformed, invented choices and real timeout preserve the deterministic plan', async () => {
  const p=planner(), query='widget count', baseline=p.plan(query), options={enabled:true,isCurrent:()=>true};
  const invalid=[null, payload('c0','c999'),payload('c0','invented'),{...payload('c0','c0'),model:'other'}];
  for(const response of invalid){const result=await selectJevRecoveryPlan(query,p,{...options,client:{call:async()=>response}});
    assert.equal(result.source,'hex');assert.deepEqual(result.plan,baseline);}
  let calls=0;for(const gate of [{enabled:false},{isCurrent:()=>false},{isCurrent:()=>{throw Error('stale');}}]){
    assert.equal((await selectJevRecoveryPlan(query,p,{...options,...gate,client:{call:async()=>{calls++;throw Error('HTTP');}}})).source,'hex');}
  assert.equal(calls,0);
  assert.equal((await selectJevRecoveryPlan(query,p,{...options,client:{call:async()=>{throw Error('HTTP');}}})).source,'hex');
  let signal;const timed=await selectJevRecoveryPlan(query,p,{...options,timeoutMs:5,
    client:{call:input=>{signal=input.signal;return new Promise(()=>{});}}});
  assert.equal(timed.source,'hex');assert.deepEqual(timed.plan,baseline);assert.equal(signal.aborted,true);
  let current=true;const stale=await selectJevRecoveryPlan(query,p,{...options,isCurrent:()=>current,
    client:{call:async()=>{current=false;return payload('c0','c0');}}});assert.equal(stale.source,'hex');
});

test('the 255 boundary and ambiguous aliases never grant an external selector extra identities', () => {
  const funcs=Array.from({length:300},(_,i)=>BigInt(i));
  const names=funcs.map(()=> '_ZNK6Widget8GetCountEv');
  const p=createCxxQueryPlanner({symbols:{funcs,addrs:funcs,names},isExecutable:()=>true});
  assert.equal(p.choices('widget count').length,255);assert.throws(()=>p.choices('widget',{maxChoices:256}),/budget/);
  assert.deepEqual(p.planOwner('count','Invented'),[]);
  const folded=createCxxQueryPlanner({symbols:{funcs:[1n],addrs:[1n,1n],names:['_ZNK6Widget8GetCountEv','_ZNK5Other8GetCountEv']},isExecutable:()=>true});
  assert.deepEqual(folded.choices('count'),[]);
});
