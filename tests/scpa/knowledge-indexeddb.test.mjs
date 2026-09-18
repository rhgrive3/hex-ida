// Deterministic IDB event/transaction adapter, NOT a real browser conformance run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { KnowledgeDB } from '../../js/knowledge/index.js';
import { readScopedKnowledgeRecords } from '../../js/knowledge/scoped-index.js';
import { fingerprintFunction } from '../../js/fingerprint/index.js';
import { workFor } from './helpers.mjs';
const fp=fingerprintFunction({architecture:'arm64',bytes:[1,2,3,4]});
function backend(count=7,{holdCommit=false,lateAfterAbort=false}={}) {
  const records=Array.from({length:count},(_,i)=>({id:`key-${String(i).padStart(4,'0')}`,fingerprint:fp}));
  const stats={cursorReads:0,getReads:0,aborts:0,seeks:[]};let nextCommit,lastTx;
  const owner=new KnowledgeDB({indexedDB:{cmp:(a,b)=>a===b?0:a<b?-1:1}});
  const db={transaction(){
    let pending=0,active=true,done=false;const tx={error:null,abort(){if(!active)return;active=false;stats.aborts++;queueMicrotask(()=>tx.onabort?.());}};lastTx=tx;
    const complete=()=>{if(done||!active||pending)return;done=true;active=false;tx.oncomplete?.();};
    const schedule=fn=>{pending++;queueMicrotask(()=>{pending--;if(active||lateAfterAbort)fn();if(pending===0){if(holdCommit)nextCommit=complete;else queueMicrotask(complete);}});};
    tx.objectStore=()=>({openCursor(){const request={};let position=0;
      const deliver=()=>schedule(()=>{stats.cursorReads++;const record=records[position];let continued=false;
        request.result=record?{key:record.id,value:structuredClone(record),continue(key){
          assert.equal(continued,false);continued=true;if(key===undefined)position++;else{stats.seeks.push(key);position=records.findIndex(r=>r.id>=key);if(position<0)position=records.length;}deliver();}}:null;
        request.onsuccess?.();});deliver();return request;},
      get(id){const request={};schedule(()=>{stats.getReads++;request.result=structuredClone(records.find(r=>r.id===id));request.onsuccess?.();});return request;}});
    queueMicrotask(()=>{if(!pending){if(holdCommit)nextCommit=complete;else queueMicrotask(complete);}});return tx;
  }};
  owner._db=db;return{owner,db,records,stats,commit:()=>nextCommit?.(),abort:()=>lastTx?.abort()};
}
test('IDB pages seek directly to the saved primary key without rescanning prior records',async t=>{
  const f=backend(400);let cursor=null;const ids=[];
  for(let page=0;page<4;page++){
    const before=f.stats.cursorReads,r=await f.owner.scopedPage({limit:100,cursor,scopeId:'s',work:workFor(t)});
    assert.ok(f.stats.cursorReads-before<=103);ids.push(...r.records.map(x=>x.id));cursor=r.continuation;
  }
  assert.equal(cursor,null);assert.deepEqual(ids,f.records.map(r=>r.id));assert.equal(f.stats.seeks.length,3);
});
test('read requests must wait for transaction completion before publishing a page capability',async t=>{
  const f=backend(3,{holdCommit:true});let settled=false;
  const result=f.owner.scopedPage({limit:1,work:workFor(t)}).then(r=>{settled=true;return r;});
  await new Promise(setImmediate);assert.equal(settled,false);f.commit();assert.ok((await result).continuation);
});
test('an aborted read transaction cannot publish a completed page or a capability',async t=>{
  const f=backend(3,{holdCommit:true}),result=f.owner.scopedPage({limit:1,work:workFor(t)});
  await new Promise(setImmediate);f.abort();await assert.rejects(result,/aborted/);assert.equal(f.stats.aborts,1);
});
test('generation drift between read requests and transaction completion rejects the page',async t=>{
  const f=backend(3,{holdCommit:true}),result=f.owner.scopedPage({limit:1,work:workFor(t)});
  await new Promise(setImmediate);f.owner.revision++;f.commit();await assert.rejects(result,/generation-changed/);
});
test('a stopped IDB read aborts the transaction; late callbacks cannot publish',async t=>{
  const f=backend(3,{holdCommit:true,lateAfterAbort:true}),work=workFor(t),result=f.owner.scopedPage({limit:1,work});
  await new Promise(setImmediate);work.dispose();await assert.rejects(result);assert.equal(f.stats.aborts,1);f.commit();
});
test('indexed candidate selection reads primary records with IDB get, not another full scan',async t=>{
  const f=backend(200),options={limit:8,maximumRecords:256,maximumBucketScan:64,scopeId:'s',work:workFor(t)};
  const cold=await f.owner.scopedIndexedCandidates(fp,options),reads=f.stats.cursorReads;
  const warm=await f.owner.scopedIndexedCandidates(fp,{...options,work:workFor(t)});
  assert.deepEqual(cold.records,warm.records);assert.equal(warm.retrieval.candidateCutReused,true);assert.equal(f.stats.cursorReads,reads);
  assert.equal(f.stats.getReads,cold.records.length+warm.records.length);
});
test('IDB primary record result waits for commit and preserves requested order',async t=>{
  const f=backend(4,{holdCommit:true});let settled=false;
  const result=readScopedKnowledgeRecords(f.owner,['key-0003','key-0001'],{revision:0,work:workFor(t)},()=>f.db).then(r=>{settled=true;return r;});
  await new Promise(setImmediate);assert.equal(settled,false);f.commit();assert.deepEqual((await result).map(x=>x.id),['key-0003','key-0001']);
});
test('an empty IDB index has explicit open semantic universe and no fabricated records',async t=>{
  const f=backend(0),r=await f.owner.scopedIndexedCandidates(fp,{limit:8,maximumRecords:128,maximumBucketScan:64,scopeId:'s',work:workFor(t)});
  assert.deepEqual(r.records,[]);assert.equal(r.retrieval.completeDatabaseScan,true);assert.equal(r.retrieval.referenceUniverseClosed,false);
});
