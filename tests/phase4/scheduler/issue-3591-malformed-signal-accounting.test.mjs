import assert from 'node:assert/strict';
import { deferred, delay, descriptor, scheduler, waitState } from './helpers.mjs';

// Malformed signal shapes fail before creating work or mutating consumer gauges.
for (const [name,signal] of [
  ['empty-object',{}],
  ['missing-listeners',{aborted:false}],
  ['non-callable-add',{aborted:false,addEventListener:true,removeEventListener(){}}],
  ['non-callable-remove',{aborted:false,addEventListener(){},removeEventListener:null}],
]) {
  const {scheduler:s}=scheduler();
  let invocations=0;
  await assert.rejects(
    s.request({descriptor:descriptor(`invalid-${name}`),signal,produce:async()=>{invocations++;return {};}}),
    (error)=>error instanceof TypeError&&error.message==='scheduler-signal-invalid',
  );
  await delay(0);
  assert.equal(invocations,0,name);
  assert.equal(s.stats().activeConsumers,0,name);
  assert.equal(s.stats().inflight,0,name);
}

// A listener API that throws during registration rolls back accounting and cancels orphan work.
{
  const {scheduler:s}=scheduler();
  const boom=new Error('listener-registration-failed');
  let registered=null,removed=0,invocations=0;
  const signal={
    aborted:false,
    addEventListener(_type,listener){ registered=listener; throw boom; },
    removeEventListener(_type,listener){ if(listener===registered) removed++; },
  };
  await assert.rejects(
    s.request({descriptor:descriptor('throwing-registration'),signal,produce:async()=>{invocations++;return {};}}),
    (error)=>error===boom,
  );
  await delay(0);
  assert.equal(removed,1);
  assert.equal(invocations,0);
  assert.equal(s.stats().activeConsumers,0);
  assert.equal(s.stats().orphanCancellations,1);
  assert.equal(s.stats().inflight,0);
}


// Normal AbortSignal cancellation still detaches cleanly and aborts orphan work.
{
  const {scheduler:s}=scheduler({maxConcurrency:1});
  const target=descriptor('valid-abort');
  const controller=new AbortController();
  let producerSawAbort=false;
  const promise=s.request({
    descriptor:target,
    signal:controller.signal,
    produce:({signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{producerSawAbort=true;reject(signal.reason);},{once:true})),
  });
  await waitState(s,target.artifactId,'running');
  controller.abort(new DOMException('valid-abort','AbortError'));
  await assert.rejects(promise,(error)=>error?.name==='AbortError');
  for (let i=0;i<20&&!producerSawAbort;i++) await delay(0);
  assert.equal(producerSawAbort,true);
  assert.equal(s.stats().activeConsumers,0);
  assert.equal(s.stats().orphanCancellations,1);
}

// A malformed coalesced request cannot leak a consumer or perturb the live producer.
{
  const {scheduler:s}=scheduler({maxConcurrency:1});
  const target=descriptor('coalesced-malformed');
  const gate=deferred();
  let invocations=0;
  const first=s.request({descriptor:target,produce:async()=>{invocations++;await gate.promise;return {ok:true};}});
  await waitState(s,target.artifactId,'running');
  const before=s.stats();
  await assert.rejects(
    s.request({descriptor:target,signal:{},produce:async()=>assert.fail('malformed consumer producer ran')}),
    (error)=>error instanceof TypeError&&error.message==='scheduler-signal-invalid',
  );
  assert.equal(s.stats().activeConsumers,before.activeConsumers);
  assert.equal(s.stats().coalescedRequests,before.coalescedRequests);
  gate.resolve();
  await first;
  assert.equal(invocations,1);
  assert.equal(s.stats().activeConsumers,0);
}

// The incompatible-completeness wait path introduced by #3813 also rolls back a throwing listener.
{
  const {scheduler:s}=scheduler({maxConcurrency:1});
  const target=descriptor('slot-malformed');
  const gate=deferred();
  const first=s.request({descriptor:target,completeness:'complete',produce:async()=>{await gate.promise;return {kind:'complete'};}});
  await waitState(s,target.artifactId,'running');
  const boom=new Error('slot-listener-registration-failed');
  const signal={aborted:false,addEventListener(){throw boom;},removeEventListener(){}};
  const before=s.stats();
  await assert.rejects(
    s.request({descriptor:target,completeness:'partial',signal,produce:async()=>assert.fail('incompatible malformed waiter ran')}),
    (error)=>error===boom,
  );
  assert.equal(s.stats().activeConsumers,before.activeConsumers);
  assert.equal(s.stats().orphanCancellations,before.orphanCancellations);
  gate.resolve();
  await first;
  assert.equal(s.stats().activeConsumers,0);
}

console.log('issue-3591 malformed scheduler signal accounting: PASS');
