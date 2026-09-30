import test from 'node:test';
import assert from 'node:assert/strict';
import { createCxxQueryPlanner } from '../../../js/analysis/cxx/query-recovery.js';
import { jevRecoveryRequest, selectJevRecoveryPlan, createJevRecoveryClient } from '../../../js/analysis/query/jev-recovery.js';
import { jevValueFlowRequest } from '../../../js/analysis/query/jev-advisory.js';

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
