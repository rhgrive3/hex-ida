import assert from 'node:assert/strict';
import { createSearchPager, createSearchRunLifecycle } from '../../js/ui/panels/search.js';

function fixture(total, completeness = 'complete') {
  const rows=Array.from({length:total},(_,index)=>({addr:BigInt(index),row:index,text:`row ${index}`}));
  const calls=[];
  return {
    calls,
    queries:{
      async search(_snapshot,_query,page,options){
        calls.push({page:{...page},options});
        const value=rows.slice(page.offset,page.offset+page.limit);
        return {
          value,
          completeness,
          page:{
            offset:page.offset,
            limit:page.limit,
            returned:value.length,
            total:completeness==='complete'?rows.length:null,
            next:page.offset+value.length<rows.length?page.offset+value.length:null,
          },
        };
      },
    },
  };
}

for(const [total,offsets] of [[999,[0]],[1000,[0]],[1001,[0,1000]],[2501,[0,1000,2000]]]){
  const sample=fixture(total);
  const pager=createSearchPager(sample.queries,{snapshotId:'s'},{regionId:'r',kind:'text',query:'x'});
  const first=await pager.next();
  assert.equal(first.value.length,Math.min(total,1000));
  assert.equal(sample.calls.length,1,'first UI page must not eagerly fetch backend continuation');
  const rows=[...first.value];
  while(pager.hasMore)rows.push(...(await pager.next()).value);
  assert.equal(rows.length,total,`${total} complete matches must all remain reachable`);
  assert.deepEqual(sample.calls.map(call=>call.page.offset),offsets,`${total} matches must follow page.next without gaps`);
  assert.equal(new Set(rows.map(row=>row.row)).size,total,`${total} matches must not duplicate across backend pages`);
  assert.equal(pager.completeness,'complete');
}

{
  const sample=fixture(1001,'partial');
  const pager=createSearchPager(sample.queries,{snapshotId:'s'},{kind:'text'});
  while(pager.hasMore)await pager.next();
  assert.equal(pager.completeness,'partial','producer incompleteness must remain fail-closed across continuation pages');
}

for(const response of [
  {value:[{row:0}],completeness:'complete'},
  {value:[{row:0}],completeness:'complete',page:{}},
  {value:[{row:0}],completeness:'complete',page:{next:7}},
  {value:[{row:0}],completeness:'complete',page:{next:0}},
]){
  let calls=0;
  const pager=createSearchPager({async search(){calls++;return response;}},{snapshotId:'s'},{kind:'text'});
  const page=await pager.next();
  assert.equal(calls,1,'malformed continuation must stop without retrying');
  assert.equal(page.value.length,1);
  assert.equal(pager.hasMore,false,'malformed continuation must not create an unbounded loop');
  assert.equal(pager.completeness,'partial','malformed continuation must fail closed');
}

{
  const sample=fixture(1001);
  const pager=createSearchPager(sample.queries,{snapshotId:'s'},{kind:'text'});
  const controller=new AbortController();
  const onProgress=()=>{};
  await pager.next({signal:controller.signal,onProgress});
  await pager.next({signal:controller.signal,onProgress});
  assert.equal(sample.calls.every(call=>call.options.signal===controller.signal),true,'continuations must preserve the supplied abort signal');
  assert.equal(sample.calls.every(call=>call.options.onProgress===onProgress),true,'continuations must preserve progress ownership callback');
}

function deferred() {
  let resolve;
  let reject;
  const promise=new Promise((ok,fail)=>{resolve=ok;reject=fail;});
  return {promise,resolve,reject};
}

async function settlePending(runs, controller, pending, ui, label) {
  try {
    const rows=await pending.promise;
    runs.runIfActive(controller,()=>{ui.status=`${label}-complete`;ui.rows=[...rows];});
  } catch {
    runs.runIfActive(controller,()=>{ui.status=`${label}-failed`;ui.dialogs++;});
  } finally {
    runs.finish(controller,()=>{ui.button='find';});
  }
}

for(const outcome of ['reject','resolve']){
  const runs=createSearchRunLifecycle();
  const ui={status:'old-searching',button:'stop',rows:['old'],dialogs:0};
  const oldPending=deferred();
  const old=runs.replace();
  const oldTask=settlePending(runs,old,oldPending,ui,'old');
  old.signal.addEventListener('abort',()=>{
    runs.runIfActive(old,()=>{ui.status='stale-abort';ui.dialogs++;});
  });

  const currentPending=deferred();
  const current=runs.replace();
  const currentTask=settlePending(runs,current,currentPending,ui,'new');
  ui.status='new-searching';ui.button='stop';ui.rows=[];

  if(outcome==='reject')oldPending.reject(new Error('stale backend failure'));
  else oldPending.resolve(['stale-late-row']);
  await oldTask;

  assert.equal(old.signal.aborted,true,'replacement must abort the previous request');
  assert.equal(runs.active,current,'replacement must publish the new owner before abort observers run');
  assert.deepEqual(ui,{status:'new-searching',button:'stop',rows:[],dialogs:0},`old ${outcome} must not mutate the current search UI`);

  currentPending.resolve(['new']);
  await currentTask;
  assert.deepEqual(ui,{status:'new-complete',button:'find',rows:['new'],dialogs:0});
}

for(const reason of ['search-stopped','search-sheet-closed']){
  const runs=createSearchRunLifecycle();
  const ui={status:'active',button:'stop',rows:['first'],dialogs:0};
  const pending=deferred();
  const continuation=runs.start();
  const task=settlePending(runs,continuation,pending,ui,'continuation');
  continuation.signal.addEventListener('abort',()=>{
    runs.runIfActive(continuation,()=>{ui.status='stale-abort';ui.rows.push('stale-abort-row');});
  });
  assert.ok(continuation,'continuation must acquire lifecycle ownership while idle');

  const cancelled=runs.cancel(reason);
  if(reason==='search-stopped'){ui.status='stopped';ui.button='find';}
  const expected={...ui,rows:[...ui.rows]};
  pending.resolve(['stale-late-row']);
  await task;

  assert.equal(cancelled,continuation,`${reason} must cancel the active continuation`);
  assert.equal(continuation.signal.aborted,true,`${reason} must abort the continuation signal`);
  assert.equal(runs.active,null,`${reason} must invalidate ownership before abort callbacks can mutate UI`);
  assert.deepEqual(ui,expected,`${reason} must keep rows/status/button unchanged after a pending continuation settles`);
}

console.log('issue-4873-search-pagination: PASS');
