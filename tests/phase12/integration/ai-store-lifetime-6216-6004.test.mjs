import assert from 'node:assert/strict';
import test from 'node:test';
import { AIRuntime } from '../../../js/ai/runtime.js';
import { EvidenceStore } from '../../../js/ai/evidence.js';
import { createTurnSnapshot } from '../../../js/ai/control/snapshot.js';
import { InvestigationSessionStore } from '../../../js/ai/session-core/index.js';

function deferred() { let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve}; }
function seed(stores, id, address=0x1000n) {
  const all=stores.evidenceStore.ingestPlan({best:{address},candidates:[{address,name:id,score:10,sources:['test'],evidence:[`source-${id}`],verification:{verified:true}}]});
  const proof=all.find(e=>e.status==='verified');
  stores.hypothesisStore.upsert({id:`h-${id}`,claim:`claim ${id}`,supportEvidenceIds:[proof.id]});
  stores.proposalStore.create({id:`p-${id}`,kind:'comment',target:{address:address.toString()},before:'',after:id,evidenceIds:[proof.id]});
  return proof.id;
}
for(const nextBinary of ['bin','other-bin']) test(`#6004 released default namespace cannot leak into ${nextBinary}`,async()=>{
  const runtime=new AIRuntime({context:{binaryId:'bin'},planner:false});
  const original=runtime.storesFor({id:'A'},'bin'); const id=seed(original,'A');
  await runtime.releaseSession('A');assert.equal(runtime.storeNamespaces.size,0);
  const next=runtime.storesFor({id:'B'},nextBinary);
  assert.notEqual(next,original);assert.equal(next.evidenceStore.has(id),false);
  assert.deepEqual(next.hypothesisStore.all(),[]);assert.deepEqual(next.proposalStore.all(),[]);
  assert.equal(runtime.storesFor({id:'B'},nextBinary),next);
});
test('#6004 explicit initial injection is honored once, and persisted findings hydrate only their session',async()=>{
  const injected=new EvidenceStore();const runtime=new AIRuntime({evidenceStore:injected,planner:false});
  const a=runtime.storesFor({id:'A'},'bin');assert.equal(a.evidenceStore,injected);const id=seed(a,'A');
  const persisted={id:'restored',confirmedFindings:a.evidenceStore.byStatus('verified'),hypotheses:a.hypothesisStore.all()};
  await runtime.releaseSession('A');
  const b=runtime.storesFor({id:'B'},'bin');assert.equal(b.evidenceStore.has(id),false);
  const restored=runtime.storesFor(persisted,'bin');assert.equal(restored.evidenceStore.get(id).status,'verified');
  assert.equal(b.evidenceStore.has(id),false);
});
test('#6216 two real turns interleave at session persistence without exchanging stores', {timeout:5000}, async()=>{
  const entered=deferred(), resume=deferred();
  class Sessions extends InvestigationSessionStore {
    async update(id,patch) {
      if(id==='A' && patch.goal==='A' && !this.paused) {this.paused=true;entered.resolve();await resume.promise;}
      return super.update(id,patch);
    }
  }
  const sessions=new Sessions(); const context={binaryId:'bin'}; const snap=createTurnSnapshot(context);
  const provider={async nextTurn(request){return {type:'final',answer:request.sessionId,evidenceIds:[proofs[request.sessionId]],suggestedActions:[]};}};
  const runtime=new AIRuntime({context,sessionStore:sessions,planner:false,provider});
  const proofs={}; const owned={};
  for(const [id,address] of [['A',0x1000n],['B',0x2000n]]) {
    const session=await sessions.create({id,binaryId:snap.binaryId,binaryIdentity:snap.binaryIdentity});
    owned[id]=runtime.storesFor(session,snap.binaryId);proofs[id]=seed(owned[id],id,address);
  }
  const broker=runtime.contextBroker;const seen=[];
  runtime.contextBroker={buildModelContext(args){seen.push([args.session.id,args.evidenceStore,args.hypotheses.map(h=>h.id)]);return broker.buildModelContext(args);}};
  const a=runtime.turn({sessionId:'A',mode:'chat',goal:'A'});
  await entered.promise;
  const b=await runtime.turn({sessionId:'B',mode:'chat',goal:'B'});
  resume.resolve();const first=await a;
  for(const [id,result] of [['A',first],['B',b]]) {
    assert.equal(result.sessionId,id);assert.deepEqual(result.evidence.map(e=>e.id),[proofs[id]]);
    assert.deepEqual(result.hypotheses.map(h=>h.id),[`h-${id}`]);
    const stored=await sessions.get(id);
    assert.deepEqual(stored.confirmedFindings.map(e=>e.id),[proofs[id]]);
    assert.deepEqual(stored.proposedActions.map(p=>p.id),[`p-${id}`]);
    const captured=seen.find(entry=>entry[0]===id);
    assert.equal(captured[1],owned[id].evidenceStore);assert.deepEqual(captured[2],[`h-${id}`]);
  }
});
