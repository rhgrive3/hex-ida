import test from 'node:test';
import assert from 'node:assert/strict';
import {checkMemoryEventModel,MEMORY_EVENT_SCHEMA,MEMORY_MODELS} from '../../js/core/evidence/memory-event-model.js';
import {workFor} from './helpers.mjs';
const e=(id,thread,kind,location,order='relaxed',v='1')=>({id,thread,kind,location,order,...(kind==='write'?{value:v}:{})});
const model=(events,kind=MEMORY_MODELS[0])=>({schema:MEMORY_EVENT_SCHEMA,model:kind,coverage:'closed-events',initial:[{location:'x',value:'0'},{location:'y',value:'0'}],events});
const sb=()=>model([e('wx','a','write','x'),e('ry','a','read','y'),e('wy','b','write','y'),e('rx','b','read','x')]);
const check=(t,m,reads,extra={})=>checkMemoryEventModel(m,{reads,...extra},{work:workFor(t)});
test('SC store buffering 0,0 is forbidden only in the closed explicit model',t=>{const r=check(t,sb(),{rx:'0',ry:'0'});assert.equal(r.status,'forbidden-in-model');assert.equal(r.exhaustive,true);assert.equal(r.semanticProof,false);});
test('coherent acquire-release subset admits relaxed store buffering 0,0',t=>{const m=sb();m.model=MEMORY_MODELS[1];const r=check(t,m,{rx:'0',ry:'0'});assert.equal(r.status,'model-witness');assert.deepEqual(r.witness.readsFrom.map(x=>x.value),['0','0']);});
test('release/acquire message passing forbids stale payload',t=>{const m=model([e('wx','a','write','x'),e('wy','a','write','y','release'),e('ry','b','read','y','acquire'),e('rx','b','read','x')],MEMORY_MODELS[1]);assert.equal(check(t,m,{ry:'1',rx:'0'}).status,'forbidden-in-model');m.events[1].order='relaxed';assert.equal(check(t,m,{ry:'1',rx:'0'}).status,'model-witness');});
for(const kind of MEMORY_MODELS) {
 test(kind+': same thread cannot read an older value after its own write',t=>assert.equal(check(t,model([e('w','a','write','x'),e('r','a','read','x')],kind),{r:'0'}).status,'forbidden-in-model'));
 test(kind+': a read cannot read its future same-location write',t=>assert.equal(check(t,model([e('r','a','read','x'),e('w','a','write','x')],kind),{r:'1'}).status,'forbidden-in-model'));
 test(kind+': coherent reads never move backward',t=>{const m=model([e('w','a','write','x'),e('r1','b','read','x'),e('r2','b','read','x')],kind);assert.equal(check(t,m,{r1:'1',r2:'0'}).status,'forbidden-in-model');});
}
test('open event set cannot prove absence',t=>{const m=sb();m.coverage='open-events';assert.equal(check(t,m,{rx:'0',ry:'0'}).status,'unknown');});
test('search cutoff is UNKNOWN, not forbidden',t=>{const r=check(t,sb(),{rx:'0',ry:'0'},{maxSearchSteps:1});assert.equal(r.status,'unknown');assert.equal(r.exhaustive,false);});
test('contradictory read value exhaustive even without any candidate',t=>{const r=check(t,sb(),{rx:'2'});assert.equal(r.status,'forbidden-in-model');assert.equal(r.candidates,0);});
for(const mutate of [m=>m.events.push({...m.events[0]}),m=>m.events[0].location='z',m=>m.events[0].kind='rmw',m=>m.events[0].value='4294967296',m=>m.events[0].order='acquire',m=>m.model='ARM-hardware'])test('reject unsupported event '+mutate,t=>{const m=sb();mutate(m);assert.throws(()=>check(t,m,{rx:'0'}));});
test('no user-controlled graph edges or guessed source identities',t=>{const m=sb();m.hb=[];assert.throws(()=>check(t,m,{rx:'0'}));assert.throws(()=>check(t,sb(),{missing:'1'}));});
test('deterministic finite SC agrees with independent schedule enumeration',t=>{
  // Independent reference executes interleavings, not rf/co/fr graph checks.
  const threads=[[e('ax','a','write','x'),e('ay','a','read','y')],[e('by','b','write','y'),e('bx','b','read','x')]], observed=new Set();
  function visit(pos,mem,values){if(pos.every((p,i)=>p===threads[i].length)){observed.add(`${values.ay}:${values.bx}`);return;}
    for(let i=0;i<2;i++){const op=threads[i][pos[i]];if(!op)continue;const p=[...pos];p[i]++;const n={...mem},v={...values};if(op.kind==='write')n[op.location]=op.value;else v[op.id]=n[op.location];visit(p,n,v);}}
  visit([0,0],{x:'0',y:'0'},{});for(const ay of ['0','1'])for(const bx of ['0','1'])assert.equal(check(t,model(threads.flat()),{ay,bx}).status==='model-witness',observed.has(`${ay}:${bx}`));
});
