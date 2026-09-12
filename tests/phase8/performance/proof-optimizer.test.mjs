import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {analyzeGraph} from '../../../js/controlflow.js';
import {enhanceSemanticDecompilation,optimizeSemanticDecompilation} from '../../../js/decompiler/pipeline.js';
import {createTaintModels,queryTaint,verifyDeobfuscationCandidate,expr as E} from '../../../js/symbolic/index.js';
import {stableDigest} from '../../../js/core/identity/index.js';
import {identity,scalarFixture,integrationFixture} from '../../phase9/taint/fixtures.mjs';
import {projectionFixture} from '../helpers/proof-fixtures.mjs';
const locks=JSON.parse(fs.readFileSync(new URL('../../phase9/fixtures/memory-taint-performance-locks.json',import.meta.url),'utf8'));

// Preserve each locked flow/alias/sanitizer case. Add only the graph fields
// supplied by the real graph owner and numeric compatibility SSA identities
// required by the existing representation producer. Canonical source IDs stay.
function representation(ir) {
 const values=new Set();
 const add=value=>{if(value)values.add(value);};
 for(const inst of ir.instructions) {
  add(inst.dst);for(const arg of inst.args??[])add(arg.value);
  for(const incoming of inst.incoming??[])add(incoming.value);
  add(inst.addr?.base);add(inst.addr?.index);
 }
 let next=1;for(const value of values){value.semanticValueId=value.id;value.id=next++;}
 ir.values=[...values];ir.origin={instructionIds:ir.instructions.map(i=>i.id)};
 for(const block of ir.blocks){block.phis??=[];block.pred=[];block.successorEdges=block.succ.map(to=>({to,kind:'branch'}));}
 for(const block of ir.blocks)for(const succ of block.succ)ir.blocks[succ].pred.push(block.index);
 const graph=analyzeGraph(ir.blocks.map(b=>b.succ),ir.entry);
 Object.assign(ir,{idom:graph.immediateDominators,dominators:graph.dominators,ipdom:graph.immediatePostDominators,postDominators:graph.postDominators,backEdges:graph.backEdges,loops:graph.loops});
 const ret=ir.instructions.find(i=>i.op==='ret');
 return enhanceSemanticDecompilation({semantic:true,ir,types:null,metrics:{},ctx:{},
  lines:[{kind:'stmt',indent:0,text:'return pending;',row:ret.row,addr:ret.address}]},null,
  {phase8PrepareProof:true,decompilerTimeBudgetMs:1000});
}
const models=extra=>createTaintModels({id:'perf-v8',version:'1',provenance:'owned:locked-fixtures-production',sources:[{id:'external',valueId:'input'}],sinks:[{id:'sink',valueId:'out'}],...extra});

test('v8 P-TAINT locked nine cases measure the actual full production Phase 8 stage',async()=>{
 const lock=locks.profiles['P-TAINT'];assert.equal(stableDigest(lock.fixtureSet.descriptor),lock.fixtureSet.stableDigest);
 const cases=[];
 for(const caseId of lock.fixtureSet.descriptor.cases) {
  let ir=scalarFixture(),model=models(),extra={memory:{addressBits:8}},negative=null,result;
  if(['implicit-control-flow','byte-memory-flow','may-alias-store'].includes(caseId)) {
   ir=integrationFixture();extra.memory.wrapping='modular';
   if(caseId==='may-alias-store')ir.blocks[0].insts[1].addr.base={id:'other',kind:'arg',index:3,reg:'x3',bits:8};
   model=models({sources:[{id:'external',valueId:'byte'}],sinks:[{id:'sink',valueId:caseId==='implicit-control-flow'?'no':'final'}]});
  }
  if(['known-sanitizer','unknown-sanitizer'].includes(caseId))model=models({sanitizers:[{id:'san',valueId:'out',scope:caseId==='known-sanitizer'?'value':'unreviewed',removeSources:['external'],clean:true}]});
  if(caseId==='proof-timeout') {
   const x=E.createFreshSymbol(E.bvSort(4),'x');const r=await verifyDeobfuscationCandidate({identity,candidateId:caseId,beforeValueId:'before',afterValueId:'after',before:E.createBinary('add',x,x),after:E.createBinary('shl',x,E.createBv(4,1)),memoryObservables:[],effectObservables:[],timeoutMs:0});
   assert.equal(r.eligible,false);assert.equal(r.reason,'deadline');negative={reason:r.reason,eligible:false};
  }
  if(caseId==='cancel-replay') {
   const ac=new AbortController();ac.abort();const r=queryTaint(ir,{identity,models:model,...extra,signal:ac.signal});
   assert.equal(r.status,'partial');assert.equal(r.evidence,null);negative={reason:r.reason,evidence:null};
  }
  if(caseId==='proven-deobfuscation') {
   const fixture=projectionFixture(4);result=await optimizeSemanticDecompilation(fixture.result,fixture.options);
   assert.equal(result.proofOptimization.adopted,2);assert.match(result.pseudocode,/return 0;/);
  } else {
   const input=representation(ir);
   result=await optimizeSemanticDecompilation(input,{identity,abiId:'generic-v1',models:model,...extra,targets:[],timeoutMs:1000});
   assert.equal(result.proofOptimization.adopted,0);
  }
  const proof=result.proofOptimization;
  assert.equal(proof.status,'complete',`${caseId}: ${proof.reason}`);
  assert.equal(result.phase8.published,true);assert.ok(proof.taintEvidence);
  if(caseId==='known-sanitizer')assert.equal(proof.taint.sinks[0].taint.kind,'untainted');
  if(['unknown-sanitizer','explicit-data-flow','implicit-control-flow','byte-memory-flow','may-alias-store'].includes(caseId))assert.equal(proof.taint.sinks[0].taint.kind,'sources');
  if(caseId==='implicit-control-flow')assert.ok(proof.taint.edges.some(e=>e.kind==='control'));
  const metrics={...proof.taintMetrics,phase8OptimizeStage:proof.phase8OptimizeStage};
  assert.ok(metrics.phase8OptimizeStage>0,caseId);
  for(const bound of lock.blockingThresholds) {
   assert.ok(Number.isFinite(metrics[bound.metric]),`${caseId}: missing ${bound.metric}`);
   assert.ok(metrics[bound.metric]<=bound.threshold,`${caseId}: ${bound.metric}=${metrics[bound.metric]}`);
  }
  cases.push({caseId,metrics,negative,measuredTrial:negative?'fresh replay/ordinary optimization after a separately refused query':'original query',adopted:proof.adopted,passCount:result.phase8.passes?.length??null});
 }
 assert.equal(cases.length,9);
 const record={profile:'P-TAINT',fixtureSet:lock.fixtureSet,thresholds:lock.blockingThresholds,cases,
  measurement:'runPhase8Stage elapsedMs inside pipeline.fullPhase8Projection, excluding solver preparation and rendering',
  environment:{runtime:process.version,platform:process.platform,architecture:process.arch},officialCollector:'NOT RUN',iPadWebKit:'NOT RUN'};
 if(process.env.HEX_V8_METRICS_DIR){fs.mkdirSync(process.env.HEX_V8_METRICS_DIR,{recursive:true});fs.writeFileSync(path.join(process.env.HEX_V8_METRICS_DIR,'P-TAINT.phase8-production.node.json'),JSON.stringify(record,null,2)+'\n');}
 console.log('V8_PHASE8_OPTIMIZER '+JSON.stringify(cases.map(c=>({caseId:c.caseId,phase8OptimizeStage:c.metrics.phase8OptimizeStage,adopted:c.adopted}))));
});
