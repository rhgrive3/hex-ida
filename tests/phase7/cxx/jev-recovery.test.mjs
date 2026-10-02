import test from 'node:test';
import assert from 'node:assert/strict';
import { createCxxQueryPlanner } from '../../../js/analysis/cxx/query-recovery.js';
import { jevRecoveryRequest, selectJevRecoveryPlan, createJevRecoveryClient } from '../../../js/analysis/query/jev-recovery.js';
import { jevValueFlowRequest,jevSemanticRoute,jevMemberContextSignature,rerankAnonymousCxx,createJevMemberClient } from '../../../js/analysis/query/jev-advisory.js';
import {createCppReceiverEvidence,createCppMemberEvidence} from '../../../js/analysis/cxx/object-evidence.js';
import {CxxMemberIndex} from '../../../js/analysis/cxx/member-index.js';
import {withCxxReturnedMemberPreference,cxxSemanticViews,cxxSemanticScores} from '../../../js/analysis/query/cxx-semantic-preference.js';

function returnedLocal() {
 const index=new CxxMemberIndex();
 const publish=(address,offset,roles,extra={})=>{
  const receiver=createCppReceiverEvidence({functionId:String(address),functionAddress:address,canonicalValueId:'arg0',
   classIdentity:{kind:'named',className:'Widget'},receiverRole:'this',nonStaticProof:{rule:'vtable-slot'},
   abiBinding:{register:'x0',argumentIndex:0,architecture:'arm64'},snapshotId:'bound',completeness:'complete'});
  index.publish({receiver,members:[createCppMemberEvidence({functionId:receiver.functionId,receiverDigest:receiver.digest,
   snapshotId:'bound',offsetBytes:offset,sizeBytes:4,category:'int32',typeLabel:'int32_t',rule:'width-32',
   readCount:1,writeCount:0,accessRoles:roles,...extra})]});
 };
 publish(1n,8n,['return-input']);publish(2n,12n,['comparison-input']);
 const local=()=>{
  const candidates=[...index.classes.values()].flatMap(cls=>cls.ivars.map(field=>({key:field.key,source:'cxx',
   anonymous:field.anonymous,className:cls.name,field,offset:field.offset,size:field.size,provenance:field.provenance}))).reverse();
  return {top:candidates[0],candidates,verdict:'ambiguous'};
 };
 return {index,publish,local};
}

test('single-function retrieval selects one canonical returned member without upgrading facts or verdicts',()=>{
 const fixture=returnedLocal(),local=fixture.local(),symbols={nameAt:a=>a===1n?'_ZNK6Widget8getCountEv':'_ZNK6Widget7isReadyEv'};
 const selection={source:'jev-retrieval',selectedAddress:1n,selectedClass:'Widget'};
 const preferred=withCxxReturnedMemberPreference(local,selection,symbols,fixture.index,{isCurrent:()=>true});
 assert.equal(preferred.top.offset,8);assert.equal(local.top.offset,12);assert.equal(preferred.verdict,local.verdict);
 assert.equal(preferred.semanticPreference.verdict,'weak-preference');assert.equal(preferred.margin,null);
 assert.ok(local.candidates.includes(preferred.top));assert.equal(fixture.index.fieldCount,2);
 for(const change of [{source:'hex'},{selectedAddress:99n},{selectedClass:'Invented'}])
  assert.equal(withCxxReturnedMemberPreference(local,{...selection,...change},symbols,fixture.index,{isCurrent:()=>true}),local);
 for(const option of [{mode:'exact'},{isCurrent:()=>false}])
  assert.equal(withCxxReturnedMemberPreference(local,selection,symbols,fixture.index,{isCurrent:()=>true,...option}),local);
 const strong={...local,verdict:'confirmed'};
 assert.equal(withCxxReturnedMemberPreference(strong,selection,symbols,fixture.index,{isCurrent:()=>true}),strong);
 assert.equal(withCxxReturnedMemberPreference(local,selection,symbols,{...fixture.index},{isCurrent:()=>true}),local);
 const forged={...local,candidates:local.candidates.map(c=>({...c,field:{...c.field}}))};
 assert.equal(withCxxReturnedMemberPreference(forged,selection,symbols,fixture.index,{isCurrent:()=>true}),forged);
});

test('single-function retrieval rejects hidden return ambiguity, contradictions and changed baseline identity',()=>{
 const f=returnedLocal(),baseline=f.local(),selection={source:'jev-retrieval',selectedAddress:1n,selectedClass:'Widget'},symbols={nameAt:()=> '_ZNK6Widget8getCountEv'};
 f.publish(1n,16n,['return-input']);
 const full=f.local(),partial={...full,candidates:full.candidates.filter(c=>c.offset!==16)};
 assert.equal(withCxxReturnedMemberPreference(partial,selection,symbols,f.index,{isCurrent:()=>true,baseline}),partial,
  'a returned member outside the ranking shortlist still vetoes the preference');
 const g=returnedLocal(),local=g.local();
 assert.equal(withCxxReturnedMemberPreference(local,selection,symbols,g.index,{isCurrent:()=>true,
  baseline:{...local,top:{...local.top,size:8}}}),local);
 const receiver=createCppReceiverEvidence({functionId:'3',functionAddress:3n,canonicalValueId:'arg0',classIdentity:{kind:'named',className:'Widget'},
  receiverRole:'this',nonStaticProof:{rule:'vtable-slot'},abiBinding:{register:'x0',argumentIndex:0,architecture:'arm64'},snapshotId:'bound',completeness:'complete'});
 g.index.publish({receiver,members:[createCppMemberEvidence({functionId:'3',receiverDigest:receiver.digest,snapshotId:'bound',
  offsetBytes:8n,sizeBytes:8,category:'int64',typeLabel:'int64_t',rule:'width-64',readCount:1,writeCount:0})]});
 const contradicted=g.local();
 assert.equal(withCxxReturnedMemberPreference(contradicted,selection,symbols,g.index,{isCurrent:()=>true,baseline:local}),contradicted);
});

test('single-function retrieval accepts one computed-return member but vetoes a hidden second operand',()=>{
 const f=returnedLocal();f.publish(3n,16n,['computed-return-input'],{returnedMemberCount:1});
 const local=f.local();local.top=local.candidates.find(c=>c.offset===12);
 const selection={source:'jev-retrieval',selectedAddress:3n,selectedClass:'Widget'},symbols={nameAt:()=> '_ZNK6Widget8getFlagsEv'};
 const preferred=withCxxReturnedMemberPreference(local,selection,symbols,f.index,{isCurrent:()=>true});
 assert.equal(preferred.top.offset,16);assert.equal(preferred.verdict,local.verdict);
 assert.equal(preferred.semanticPreference.verdict,'weak-preference');
 const view=cxxSemanticViews(local.candidates,symbols).find(v=>v.key===preferred.top.key);
 assert.equal(view.functionContexts[0].returnedMemberCount,1);
 assert.equal(cxxSemanticScores('widget flags',[view])[0].score,10,
  'the deterministic comparator receives the same computed-return context as the remote path');
 f.publish(3n,20n,['computed-return-input'],{returnedMemberCount:1});const full=f.local();
 const partial={...full,top:full.candidates.find(c=>c.offset===12),candidates:full.candidates.filter(c=>c.offset!==20)};
 assert.equal(withCxxReturnedMemberPreference(partial,selection,symbols,f.index,{isCurrent:()=>true,baseline:local}),partial);
 const dropped=returnedLocal();
 dropped.publish(3n,16n,['computed-return-input'],{returnedMemberCount:2});
 const onlyPublished=dropped.local();
 assert.equal(withCxxReturnedMemberPreference(onlyPublished,selection,symbols,dropped.index,{isCurrent:()=>true}),onlyPublished,
  'the producer counted a second member even when publication omitted that operand');
 const missing=returnedLocal();missing.publish(3n,16n,['computed-return-input']);const absentCount=missing.local();
 assert.equal(withCxxReturnedMemberPreference(absentCount,selection,symbols,missing.index,{isCurrent:()=>true}),absentCount,
  'computed-return context needs a closed producer count, not published-set uniqueness alone');
 const g=returnedLocal();g.publish(3n,16n,['computed-return-input'],{returnedMemberCount:1});
 const baseline=g.local();baseline.top=baseline.candidates.find(c=>c.offset===12);
 assert.equal(withCxxReturnedMemberPreference(baseline,selection,symbols,g.index,{isCurrent:()=>true}).top.offset,16);
 g.publish(3n,24n,[],{returnExpressionIncomplete:true});const current=g.local();
 current.top=current.candidates.find(c=>c.offset===12);
 current.candidates=current.candidates.filter(c=>c.offset!==24);
 assert.equal(withCxxReturnedMemberPreference(current,selection,symbols,g.index,{isCurrent:()=>true,baseline}),current,
  'an untraced returned root vetoes the function even when its marker is outside the ranked lattice');
});

test('single-function retrieval cannot select outside the 255 member shortlist or scan an unbounded owner',()=>{
 const f=returnedLocal(),selection={source:'jev-retrieval',selectedAddress:1n,selectedClass:'Widget'},symbols={nameAt:()=> '_ZNK6Widget8getCountEv'};
 for(let i=0;i<298;i++)f.publish(2n,BigInt(16+4*i),['comparison-input']);
 const local=f.local(),options={isCurrent:()=>true};assert.equal(local.candidates.length,300);
 assert.equal(withCxxReturnedMemberPreference(local,selection,symbols,f.index,options),local,'oversized implicit shortlist fails closed');
 assert.equal(withCxxReturnedMemberPreference(local,selection,symbols,f.index,{...options,shortlist:local.candidates.slice(0,255)}),local);
 const kept=local.candidates.slice(-255),preferred=withCxxReturnedMemberPreference(local,selection,symbols,f.index,{...options,shortlist:kept});
 assert.equal(preferred.top.offset,8);assert.ok(kept.includes(preferred.top));
 assert.equal(withCxxReturnedMemberPreference(local,selection,symbols,f.index,{...options,shortlist:kept.map(c=>({...c}))}),local,
  'a copied/invented shortlist cannot admit an otherwise omitted candidate');
 for(let i=298;i<399;i++)f.publish(2n,BigInt(16+4*i),['comparison-input']);
 const bounded={...local,candidates:local.candidates.slice(-255)};
 assert.equal(withCxxReturnedMemberPreference(bounded,selection,symbols,f.index,{...options,shortlist:bounded.candidates}),bounded);
});

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
test('live V4 selection uses the same branded request projection as its ambiguity veto',async()=>{
 const local=anonymousLocal(),symbols={nameAt:()=> '_ZN6Widget6updateEb'};let calls=0,body;
 const opts={enabled:true,isCurrent:()=>true,symbols,mode:'partial',representation:'argument-flow-v4',routingPolicy:'object-context-v4'};
 const client=createJevMemberClient({apiKey:'secret-test-key',symbols,representation:'argument-flow-v4',fetchImpl:async(_url,options)=>{
  calls++;body=JSON.parse(options.body);
  return {ok:true,json:async()=>({model:'openjev',answers:{pick:{type:'choice',choice:'c1',confidence:.6,probabilities:{c1:.6}},unique:{type:'noul',noul:.5}}})};
 }});
 local.candidates[0].oracle='SECRET_ORACLE';
 const selected=await rerankAnonymousCxx('Has the operation finished?',local,{...opts,client});
 assert.equal(selected.source,'jev','a valid live V4 selection must survive the visible-context veto');
 assert.equal(selected.top1,local.candidates[1]);assert.equal(local.top,local.candidates[0]);
 assert.ok(body.questions.pick.criteria.c0.includes('member: offset 0x8'));
 assert.ok(body.questions.pick.criteria.c1.includes('member: offset 0x9'));
 assert.equal(JSON.stringify(body).includes('SECRET_ORACLE'),false);
 assert.equal(JSON.stringify(body).includes('secret-test-key'),false);
 const same=anonymousLocal(true);
 assert.equal((await rerankAnonymousCxx('Has the operation finished?',same,{...opts,client})).top1,same.top);
 const before=calls;
 for(const options of [{...opts,enabled:false},{...opts,isCurrent:()=>false}])
  assert.equal((await rerankAnonymousCxx('Has the operation finished?',local,{...options,client})).top1,local.top);
 assert.equal((await rerankAnonymousCxx('Has the operation finished?',{...local,verdict:'confirmed'},{...opts,client})).top1,local.top);
 assert.equal((await rerankAnonymousCxx('Has the operation finished?',{...local,candidates:local.candidates.map(c=>({...c,field:{...c.field}}))},{...opts,client})).top1,local.top);
 assert.equal(calls,before,'disabled, strong, stale and forged input never call the remote client');
 // Untrusted candidate display properties cannot overwrite branded facts.
 local.candidates[1].recoveredType={category:'SECRET_ORACLE'};
 await rerankAnonymousCxx('Has the operation finished?',local,{...opts,client});
 assert.equal(JSON.stringify(body).includes('SECRET_ORACLE'),false);
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
 assert.equal(jevMemberContextSignature(views[0]),jevMemberContextSignature({...same,
  functionContexts:[...same.functionContexts,...same.functionContexts]}),'duplicate provenance does not invent semantics');
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

test('compact retrieval provides an explicit abstention and never interprets it as a function', async()=>{
 const p=planner(),query='widget count',base=p.plan(query),requestPolicy='compact-accessor-v5';
 let body=null;
 const options={enabled:true,isCurrent:()=>true,requestPolicy,client:{call:async input=>{
  body=input.body;assert.equal(input.requestPolicy,requestPolicy);
  return {model:'openjev',answers:{pick:answer('none')}};
 }}};
 const abstained=await selectJevRecoveryPlan(query,p,options);
 assert.equal(abstained.source,'hex');assert.deepEqual(abstained.plan,base);
 assert.deepEqual(Object.keys(body.questions),['pick']);assert.ok(body.questions.pick.criteria.none);
 assert.ok(!JSON.stringify(body).includes('receiver evidence:'));
 for(const pick of [answer('c254'),answer('invented'),{...answer('c0'),probabilities:{c0:1,invented:0}},
  {...answer('none'),confidence:NaN}]) {
  assert.equal((await selectJevRecoveryPlan(query,p,{...options,client:{call:async()=>({model:'openjev',answers:{pick}})}})).source,'hex');
 }
 const choices=p.choices(query),index=choices.findIndex(c=>c.className==='Widget');
 const selected=await selectJevRecoveryPlan(query,p,{...options,maxFunctions:1,
  client:{call:async()=>({model:'openjev',answers:{pick:answer(`c${index}`)}})}});
 assert.equal(selected.source,'jev-retrieval');assert.equal(selected.plan.length,1);
 assert.equal(selected.selectedAddress,choices[index].address);
});

test('compact retrieval caps all protocol choices at255 and removes unanalysable or indistinguishable entries', async()=>{
 const rows=Array.from({length:300},(_,i)=>({address:BigInt(i+1),className:'Widget',methodName:`getValue${i}`,
  symbolName:null,proof:'non-static-symbol',declaredSizeBytes:28n}));
 const p={choices:(_query,{maxChoices})=>rows.slice(0,maxChoices),plan:()=>[],
  planOwner:(_query,_owner,{firstAddress})=>rows.filter(r=>r.address===firstAddress)};
 const options={enabled:true,isCurrent:()=>true,requestPolicy:'compact-accessor-v5',maxDeclaredSizeBytes:256};
 let calls=0;
 const client={call:async input=>{
  calls++;assert.equal(input.choices.length,254);assert.equal(Object.keys(input.body.questions.pick.criteria).length,255);
  return {model:'openjev',answers:{pick:answer('c253')}};
 }};
 assert.equal((await selectJevRecoveryPlan('count',p,{...options,client})).selectedAddress,254n);
 assert.equal(calls,1);assert.throws(()=>jevRecoveryRequest('count',rows.slice(0,255),options),/at most254/);
 const duplicate=[{...rows[0],methodName:'same'}, {...rows[1],methodName:'same'},
  {...rows[2],declaredSizeBytes:257n},{...rows[3],declaredSizeBytes:null},rows[4],rows[5]];
 const filtered=await selectJevRecoveryPlan('count',{...p,choices:()=>duplicate},{...options,client:{call:async input=>{
  assert.deepEqual(input.choices.map(r=>r.address),[5n,6n]);
  return {model:'openjev',answers:{pick:answer('c0')}};
 }}});
 assert.equal(filtered.selectedAddress,5n);
 let forbiddenCalls=0;
 for(const change of [{maxDeclaredSizeBytes:0},{requestPolicy:'invented'}])
  assert.equal((await selectJevRecoveryPlan('count',p,{...options,...change,client:{call:async()=>{forbiddenCalls++;}}})).source,'hex');
 assert.equal(forbiddenCalls,0);
 const http=createJevRecoveryClient({apiKey:'test-key',fetchImpl:async(_url,input)=>{
  const body=JSON.parse(input.body);assert.deepEqual(Object.keys(body.questions),['pick']);assert.ok(body.questions.pick.criteria.none);
  assert.ok(!input.body.includes('secret_oracle_label'));return {ok:true,json:async()=>({model:'openjev',answers:{pick:answer('none')}})};
 }});
 await http.call({query:'count',choices:rows.slice(0,2),requestPolicy:options.requestPolicy,body:{oracle:'secret_oracle_label'}});
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

test('V5 retrieval retains matching owner depth and broad exploration without adding receiver authority',()=>{
 const names=[],funcs=[];
 const add=name=>{names.push(name);funcs.push(BigInt(names.length));};
 for(let i=0;i<60;i++){const method='value'+i;add(`_ZNK6Widget${method.length}${method}Ev`);}
 for(let i=0;i<260;i++){const owner='Other'+i;add(`_ZNK${owner.length}${owner}4readEv`);}
 add('_ZN6Widget6StaticEv');
 const symbols={names,addrs:funcs,funcs};
 const old=createCxxQueryPlanner({symbols,isExecutable:()=>true,planningPolicy:'value-accessor-v3'});
 const next=createCxxQueryPlanner({symbols,isExecutable:()=>true,planningPolicy:'semantic-retrieval-v5'});
 const choices=next.choices('widget setting');
 assert.equal(choices.length,255);assert.equal(new Set(choices.map(row=>String(row.address))).size,255);
 assert.ok(!old.choices('widget setting').some(row=>row.address===60n));
 assert.ok(choices.some(row=>row.address===60n),'the late proven method is visible to the external selector');
 assert.ok(choices.filter(row=>row.className!=='Widget').length>=127,'global owners keep at least half the available budget');
 assert.ok(choices.every(row=>row.methodName!=='Static'),'ordinary qualified names remain unproven');
 assert.equal(next.functionCount,old.functionCount);
 assert.deepEqual(next.plan('widget setting'),old.plan('widget setting'),'only the remote shortlist changes');
 assert.equal(next.choices('widget',{maxChoices:1}).length,1);
 assert.equal(next.choices('no matching object').length,255);
 const nested=createCxxQueryPlanner({symbols:{funcs:[1n,2n],addrs:[1n,2n],
  names:['_ZNK3BoxI6WidgetE4readEv','_ZNK6Widget4readEv']},
  isExecutable:()=>true,planningPolicy:'semantic-retrieval-v5'});
 const box=nested.choices('widget').find(row=>row.address===1n);
 assert.equal(box.className,'Box<Widget>');assert.deepEqual(box.classTokens,['box'],
  'a template argument is related context, not the requested owning object');
 assert.equal(nested.choices('widget')[0].address,2n);
});
