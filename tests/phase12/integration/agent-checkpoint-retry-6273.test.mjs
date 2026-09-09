import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentJobManager } from '../../../js/ai/jobs/index.js';

function fixture(exhausted=false) {
  let turns=0,failures=1;
  const persisted=new Map();const writes=[];
  const persistence={
    async save(job){
      writes.push(structuredClone(job));
      if((['complete','checkpointed'].includes(job.status) || job.executionRecoveryPending === true) && failures-- > 0) {job.lastResult.answer='adapter-mutation';throw new Error('quota');}
      persisted.set(job.id,structuredClone(job));
    },
    async load(id){return structuredClone(persisted.get(id));},
  };
  const runtime={async turn(){turns++;return {answer:'done',limits:{exhausted},usage:{modelCalls:1,toolCalls:2,elapsedMs:10,contextBytes:100},evidence:[{id:'e'}],activity:[{type:'tool-result',tool:'read'}]};}};
  const manager=new AgentJobManager({runtime,persistence});
  return {manager,persistence,runtime,persisted,writes,get turns(){return turns;},fail(n){failures=n;}};
}
for(const exhausted of [false,true]) test(`#6273 resume retries only the checkpoint (${exhausted?'continuation':'complete'})`,async()=>{
  const f=fixture(exhausted);await f.manager.create({jobId:'j',goal:'test'});
  await assert.rejects(f.manager.runSlice('j'),/quota/);
  const pending=await f.manager.get('j');assert.equal(pending.status,exhausted?'checkpointed':'complete');
  assert.equal(pending.checkpointSavePending,true);assert.equal(pending.lastResult.answer,'done');
  const before=structuredClone(pending.budgetUsage);
  const recovered=await f.manager.resume('j');assert.equal(f.turns,1);
  assert.deepEqual(recovered.budgetUsage,before);assert.equal(recovered.lastResult.answer,'done');
  assert.equal(recovered.checkpointSavePending,undefined);
  assert.equal(f.persisted.get('j').status,recovered.status);
  assert.deepEqual(f.writes.at(-1),recovered,'same checkpoint, without doubled usage or adapter mutation');
  await f.manager.retryCheckpoint('j');assert.equal(f.turns,1);
  if(exhausted){await f.manager.resume('j');assert.equal(f.turns,2);}
});
test('#6273 repeated quota failures cannot replay a finished slice in-process; #4389 restart recovers the lease',async()=>{
  const f=fixture(true);f.fail(10);await f.manager.create({jobId:'j',goal:'test'});
  for(let i=0;i<4;i++) await assert.rejects(f.manager.resume('j'),/quota/);
  assert.equal(f.turns,1);assert.equal((await f.manager.get('j')).budgetUsage.slices,1);
  const restarted=new AgentJobManager({runtime:f.runtime,persistence:f.persistence});
  f.fail(0);
  const recovered=await restarted.resume('j');
  assert.equal(recovered.status,'checkpointed');
  assert.equal(f.turns,2);
  assert.equal(f.persisted.get('j').lastResult.answer,'done');
});
test('#6273 a fresh manager recovers a completed outcome marker without replaying the turn', async () => {
  const f = fixture(true);
  await f.manager.create({ jobId: 'j', goal: 'test' });
  await assert.rejects(f.manager.runSlice('j'), /quota/);
  assert.equal(f.turns, 1);
  const marker = f.persisted.get('j');
  assert.equal(marker.status, 'running');
  assert.equal(marker.executionOutcomeStatus, 'checkpointed');
  assert.equal(marker.executionRecoveryPending, true);

  const restarted = new AgentJobManager({ runtime: f.runtime, persistence: f.persistence });
  const recovered = await restarted.resume('j');
  assert.equal(recovered.status, 'checkpointed');
  assert.equal(recovered.executionRecoveryPending, undefined);
  assert.equal(f.turns, 1, 'durable outcome recovery must not replay provider/tool side effects');
  assert.equal(f.persisted.get('j').status, 'checkpointed');

  const continued = await restarted.resume('j');
  assert.equal(continued.status, 'checkpointed');
  assert.equal(f.turns, 2, 'an explicit later resume may continue the checkpointed job');
});
test('#6273 an actual execution failure retains failure/cancellation semantics',async()=>{
  for(const cancelled of [false,true]) {
    const controller=new AbortController();const manager=new AgentJobManager({runtime:{async turn(){if(cancelled)controller.abort();throw new Error('execution');}}});
    await manager.create({jobId:'j',goal:'test'});
    await assert.rejects(manager.runSlice('j',{signal:controller.signal}),/execution/);
    assert.equal((await manager.get('j')).status,cancelled?'checkpointed':'failed');
    assert.equal(manager.pendingCheckpoints.size,0);
  }
});

test('#6273 a checkpointed save failure cannot rerun the already executed turn', async () => {
  const f = fixture(true);
  await f.manager.create({ jobId: 'j', goal: 'test' });
  await assert.rejects(f.manager.runSlice('j'), /quota/);
  const usage = structuredClone((await f.manager.get('j')).budgetUsage);
  await f.manager.resume('j');
  assert.equal(f.turns, 1, 'recovery must not repeat provider/tool side effects');
  assert.deepEqual((await f.manager.get('j')).budgetUsage, usage);
});
