import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, workFor } from './helpers.mjs';
import { EvidenceGraph } from '../../js/core/evidence/index.js';
import { exportEvidenceCertificate, replayEvidenceCertificate, CertificateCheckerRegistry } from '../../js/core/evidence/certificate.js';
import { normalizeTransformReceipt, normalizeTransformObservables, explainTransformChain } from '../../js/core/evidence/transform-chain.js';
function graphFixture(f){
 const graph=new EvidenceGraph({nodes:[{id:'bytes',family:'BinaryEvidence',binaryId:f.world.binarySet[0].binaryId,semanticKind:'test-bytes',completeness:'complete',origin:{byteRanges:[{binaryId:f.world.binarySet[0].binaryId,start:0n,length:4}]}}]});
 const readRange=async req=>({...req,bytes:Uint8Array.of(1,2,3,4)});return {graph,readRange,roots:['bytes']};
}
function checker(f,level='derivation-checked',status='verified'){
 const registry=new CertificateCheckerRegistry();registry.register({id:'test-checker',version:'1',semanticKind:'test-bytes',level,check:node=>({worldId:f.world.id,assumptionsId:f.assumptions.id,nodeId:node.id,propositionChecked:true,status})});return registry;
}
test('certificate export separates content integrity and semantic proof, with bound source bytes',async t=>{
 const f=fixture(),g=graphFixture(f),before=g.graph.revision;const {certificate:c}=await exportEvidenceCertificate({...f,...g,work:workFor(t),includeBytes:true});assert.equal(c.proofStatus,'not-checked');assert.equal(c.graphClosed,true);assert.equal(c.byteRanges[0].hex,'01020304');assert.equal(g.graph.revision,before);
 const r=await replayEvidenceCertificate(c,{...f,...g,work:workFor(t)});assert.equal(r.integrity,'verified');assert.equal(r.byteBinding,'verified');assert.equal(r.semantic,'unknown');
});
test('strong replay requires live canonical binding and an actual host checker result',async t=>{
 const f=fixture(),g=graphFixture(f),{certificate:c}=await exportEvidenceCertificate({...f,...g,work:workFor(t)});
 const r=await replayEvidenceCertificate(c,{...f,...g,work:workFor(t),checkers:checker(f),resolveCanonicalNode:id=>({worldId:f.world.id,node:g.graph.getNode(id)})});assert.equal(r.semantic,'verified');
 // This verifies the admission protocol with a deterministic checker double,
 // not instruction correctness or an independent real-world proof.
 const weak=await replayEvidenceCertificate(c,{...f,...g,work:workFor(t),checkers:checker(f,'source-binding-checked'),resolveCanonicalNode:id=>({worldId:f.world.id,node:g.graph.getNode(id)})});assert.equal(weak.semantic,'unknown');
});
for(const mutate of [c=>{c.nodes[0].payload={changed:true};},c=>{c.byteRanges[0].hex='ffffffff';},c=>{c.roots=['absent'];}])test('changed certificate content cannot retain its original digest authority',async t=>{
 const f=fixture(),g=graphFixture(f),{certificate}=await exportEvidenceCertificate({...f,...g,work:workFor(t)}),copy=structuredClone(certificate);mutate(copy);const r=await replayEvidenceCertificate(copy,{...f,...g,work:workFor(t)});assert.equal(r.integrity,'rejected');assert.equal(r.semantic,'unknown');
});
test('source bytes changed since export rejects semantic replay',async t=>{
 const f=fixture(),g=graphFixture(f),{certificate}=await exportEvidenceCertificate({...f,...g,work:workFor(t)});const r=await replayEvidenceCertificate(certificate,{...f,work:workFor(t),readRange:req=>({...req,bytes:Uint8Array.of(1,2,3,5)})});assert.equal(r.semantic,'rejected');assert.ok(r.rejected.some(x=>x.reason==='byte-content-mismatch'));
});
test('wrong source/world binding and missing proof dependencies remain explicit frontier',async t=>{
 const f=fixture(),g=graphFixture(f);g.graph.addEdge({from:'bytes',to:'missing',type:'derived-from'});const r=await exportEvidenceCertificate({...f,...g,work:workFor(t),readRange:req=>({...req,worldId:'wrong',bytes:new Uint8Array(4)})});assert.equal(r.certificate.graphClosed,false);assert.ok(r.frontier.some(x=>x.kind==='missing-evidence'));assert.ok(r.frontier.some(x=>x.kind==='byte-read-binding-rejected'));
});
test('evidence mutation during export never publishes a stale certificate',async t=>{
 const f=fixture(),g=graphFixture(f);const r=await exportEvidenceCertificate({...f,...g,work:workFor(t),readRange:req=>{g.graph.addNode({id:'late',family:'SemanticEvidence'});return g.readRange(req);}});assert.equal(r.status,'stale');assert.equal(r.certificate,null);
});
test('export budget exhaustion and pre-cancellation emit no certificate',async t=>{
 const f=fixture(),g=graphFixture(f);const r=await exportEvidenceCertificate({...f,...g,work:workFor(t,{nodes:0})});assert.equal(r.status,'budget-exhausted');assert.equal(r.certificate,null);const w=workFor(t);w.dispose();const stopped=await exportEvidenceCertificate({...f,...g,work:w});assert.equal(stopped.status,'cancelled');assert.equal(stopped.certificate,null);
});
test('incoming contradictions are included even when the root only names supporting nodes',async t=>{
 const f=fixture(),g=graphFixture(f);g.graph.addNode({id:'contradiction',family:'SemanticEvidence'});g.graph.addEdge({type:'contradicts',from:'contradiction',to:'bytes'});const r=await exportEvidenceCertificate({...f,...g,work:workFor(t)});assert.ok(r.certificate.nodes.some(x=>x.id==='contradiction'));
});
test('checker unregistration during replay prevents publication with changed authority',async t=>{
 const f=fixture(),g=graphFixture(f),registry=new CertificateCheckerRegistry();let unregister;unregister=registry.register({id:'unstable',version:'1',semanticKind:'test-bytes',check:n=>{unregister();return {worldId:f.world.id,assumptionsId:f.assumptions.id,nodeId:n.id,propositionChecked:true,status:'verified'};}});const {certificate}=await exportEvidenceCertificate({...f,...g,work:workFor(t)});await assert.rejects(replayEvidenceCertificate(certificate,{...f,...g,work:workFor(t),checkers:registry}),/membership-changed/);
});
test('checker result must bind the proposition, node, world and assumptions',async t=>{
 const f=fixture();for(const altered of [{nodeId:'wrong'},{worldId:'wrong'},{assumptionsId:'wrong'},{propositionChecked:false}]){const r=new CertificateCheckerRegistry();r.register({id:'x',version:'1',semanticKind:'x',check:n=>({worldId:f.world.id,assumptionsId:f.assumptions.id,nodeId:n.id,propositionChecked:true,status:'verified',...altered})});assert.equal((await r.check({id:'n',semanticKind:'x'},f,workFor(t))).status,'unknown');}
});
const observables=()=>({inputBindings:['x0'],outputs:['x0'],memoryFootprint:'mem',eventModel:'events',faults:'faults',termination:'preserve',fpEnvironment:'fp',concurrencyModel:'single-thread'});
const fragment=id=>({artifactId:'artifact-'+id,ownerDigest:'digest-'+id,semanticIrVersion:'v2',entityIds:[id],byteRangeIds:['range']});
function receipt(f,overrides={}){return normalizeTransformReceipt({schema:'scoped-transform-receipt/v1',worldId:f.world.id,assumptionsId:f.assumptions.id,binaryId:f.world.binarySet[0].binaryId,functionId:'fun',snapshotId:'snap',before:fragment('a'),after:fragment('b'),ruleId:'rule',ruleVersion:'1',ownerVersion:'1',observable:observables(),claim:'equivalent',sourceReceipts:[],obligations:[],queryHash:'query',evidenceId:'evidence',...overrides},{...f,snapshotId:'snap',functionId:'fun'});}
async function chain(t,f,receipts,options={},request={}){const map=new Map(receipts.map(r=>[r.id,r]));return explainTransformChain({functionId:'fun',stepIds:receipts.slice(-1).map(r=>r.id),...request},{...f,snapshotId:'snap',work:workFor(t),resolveReceipt:id=>map.has(id)?{data:map.get(id),isCurrent:()=>true}:null,...options});}
function transformRegistry(f,level='derivation-checked',status='verified'){const registry=new CertificateCheckerRegistry();registry.register({id:'test-transform',version:'1',semanticKind:'decompiler-transform',level,check:n=>({worldId:f.world.id,assumptionsId:f.assumptions.id,nodeId:n.id,propositionChecked:true,status})});return registry;}
test('transform composition without checkers remains unknown and read-only',async t=>{const f=fixture(),r=await chain(t,f,[receipt(f)]);assert.equal(r.status,'unknown');assert.equal(r.globalStaticTruth,false);assert.equal(r.exact,false);});
test('transform composition qualifies only declared observables, never global static truth',async t=>{const f=fixture(),a=receipt(f),b=receipt(f,{before:fragment('b'),after:fragment('c'),sourceReceipts:[a.id]});const r=await chain(t,f,[a,b],{checkers:transformRegistry(f)},{stepIds:[a.id,b.id],includePremises:true});assert.equal(r.status,'conditionally-verified');assert.equal(r.minimumCheck,'derivation-checked');assert.equal(r.exact,false);assert.equal(r.receipts.length,2);});
for(const [label,override,reason] of [['missing premise',{sourceReceipts:['missing']},'receipt-owner-record-missing'],['open obligation',{obligations:['unproved-precondition']},'unproved-precondition'],['refinement',{claim:'refines'},'refinement-does-not-establish-symmetric-equivalence'],['unproved termination',{observable:{...observables(),termination:'unproved'}},'termination-observable-unproved']])test(`transform ${label} blocks equivalence`,async t=>{const f=fixture(),r=await chain(t,f,[receipt(f,override)],{checkers:transformRegistry(f)});assert.equal(r.status,'unknown');assert.ok(r.remaining.includes(reason));});
test('disconnected fragment chain and changed observable model are not composable',async t=>{const f=fixture(),a=receipt(f),b=receipt(f,{before:fragment('z'),after:fragment('c'),observable:{...observables(),faults:'other-faults'}});const r=await chain(t,f,[a,b],{checkers:transformRegistry(f)},{stepIds:[a.id,b.id]});assert.equal(r.status,'unknown');assert.ok(r.remaining.includes('transform-fragment-chain-disconnected'));assert.ok(r.remaining.includes('observable-contract-changed-between-passes'));});
test('weak premise check cannot hide behind an independent final link',async t=>{const f=fixture(),a=receipt(f),b=receipt(f,{before:fragment('b'),after:fragment('c'),sourceReceipts:[a.id]});const r=await chain(t,f,[a,b],{checkers:transformRegistry(f,'source-binding-checked')});assert.equal(r.status,'unknown');assert.ok(r.remaining.includes('integrity-only-is-not-transform-proof'));});
test('bounded premise keeps composition bounded even with unbounded final receipt',async t=>{const f=fixture(),a=receipt(f,{claim:'bounded-equivalent'}),b=receipt(f,{before:fragment('b'),after:fragment('c'),sourceReceipts:[a.id]});const r=await chain(t,f,[a,b],{checkers:transformRegistry(f)});assert.equal(r.status,'conditionally-verified');assert.equal(r.scope,'bounded-equivalence-only');});
test('receipt ID and world binding reject altered DTOs',()=>{const f=fixture(),a=receipt(f);assert.throws(()=>normalizeTransformReceipt({...a,ruleId:'other'},{...f,snapshotId:'snap',functionId:'fun'}),/id-mismatch/);assert.throws(()=>normalizeTransformReceipt({...a,worldId:'other'},{...f,snapshotId:'snap',functionId:'fun'}),/world-binding/);assert.throws(()=>normalizeTransformObservables({...observables(),fakeAuthority:true}),/fields/);});
test('owner retirement during transform replay suppresses final publication',async t=>{const f=fixture(),a=receipt(f);let current=true;const checkers=new CertificateCheckerRegistry();checkers.register({id:'retiring',version:'1',semanticKind:'decompiler-transform',check:n=>{current=false;return {worldId:f.world.id,assumptionsId:f.assumptions.id,nodeId:n.id,propositionChecked:true,status:'verified'};}});await assert.rejects(chain(t,f,[a],{checkers,resolveReceipt:()=>({data:a,isCurrent:()=>current})}),/changed-during-replay/);});
