import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSemanticModel } from '../../../js/blocks.js';
import { decompile,decompileWithProof,optimizeSemanticDecompilation } from '../../../js/decompile.js';
import { proofFixture,projectionFixture,identity } from '../helpers/proof-fixtures.mjs';
import { preparePhase8RewritePlan,createAnalysisState } from '../../../js/decompiler/phase8/index.js';
import {runProofRewritePass,readProvedRewrites} from '../../../js/decompiler/phase8/pass-validation.js';

test('v8 production optimizer commits, projects and preserves source/IR identity',async()=>{
 const f=projectionFixture();const item=f.result.semanticAst.values.find(v=>v.valueId===f.target.id);const original=item.expression;const originalText=f.result.pseudocode;
 const r=await optimizeSemanticDecompilation(f.result,f.options);
 assert.equal(r.proofOptimization.status,'complete',r.proofOptimization.reason);
 assert.equal(r.proofOptimization.adopted,2);assert.match(r.pseudocode,/return 0;/);
 assert.equal(f.result.pseudocode,originalText);assert.match(originalText,/\^/);assert.equal(item.expression,original);
 assert.equal(r.ir,f.ir);assert.equal(f.target.def.sub,'xor');
 const t=r.phase8Projection.transforms.find(t=>t.kind==='solver-constant');assert.ok(t.queryHash);
 assert.ok(t.origin.rows.includes(f.target.def.row));assert.ok(t.origin.addresses.includes(f.target.def.address));
 assert.ok(r.semanticAst.values.find(v=>v.valueId===f.target.id).expression.source.evidence.some(e=>e.reason.includes(t.queryHash)));
 assert.ok(r.proofOptimization.phase8OptimizeStage>0);
});
test('v8 true machine->decompiler entry optimizes an MBA cancellation; no helper-only wiring',async()=>{
 const base=0x1000n,lines=['eor x2, x0, x1','eor x3, x1, x0','eor x0, x2, x3','ret'];
 const raw=lines.map((t,row)=>{const i=t.indexOf(' ');return {row,address:base+BigInt(row*4),mn:i<0?t:t.slice(0,i),ops:i<0?'':t.slice(i+1)};});
 const rowOfAddress=a=>Number((a-base)/4n);
 const model=buildSemanticModel(raw,{startRow:0,endRow:3,rowOfAddress});
 const opts={addr:base,name:'cancel_mba',rowOfAddress,beginner:false,returnType:'uint64',decompilerTimeBudgetMs:5000};
 const baseline=decompile(model,opts);assert.match(baseline.pseudocode,/\^/);
 const r=await decompileWithProof(model,opts,{identity:{...identity,architecture:'arm64'},abiId:'aapcs64',candidateStrategy:'equality-saturation',timeoutMs:1000});
 assert.equal(r.proofOptimization.status,'complete',r.proofOptimization.reason);
 assert.equal(r.proofOptimization.adopted,2);assert.match(r.pseudocode,/return 0;/);assert.doesNotMatch(r.pseudocode,/\^/);
 assert.ok(r.ir.instructions.some(i=>i.op==='bin'&&i.sub==='xor'),'original instruction effects remain');
});
test('v8 staging alone, arbitrary state facades and seeded artifacts cannot authorize a rewrite',async()=>{
 const f=proofFixture(),plan=await preparePhase8RewritePlan(f.ir,f.options);let artifact;
 const context={ir:f.ir,proofIdentity:identity,abiId:f.options.abiId,proofRewritePlan:plan};
 runProofRewritePass(context,{}, {stage(_key,value){artifact=value;}});
 for(const state of [{get:()=>artifact},createAnalysisState({provedRewrites:artifact})]) assert.equal(readProvedRewrites(state,context),null);
});
test('v8 expired optimizer leaves the original result and semantic AST untouched',async()=>{
 const f=projectionFixture(),expression=f.result.semanticAst.values[0].expression;
 const r=await optimizeSemanticDecompilation(f.result,{...f.options,phase8TimeBudgetMs:0});
 assert.equal(r.proofOptimization.status,'partial');assert.equal(r.proofOptimization.adopted,0);
 assert.equal(f.result.semanticAst.values[0].expression,expression);assert.equal(r.pseudocode,f.result.pseudocode);
});
test('v8 conditional proofs and missing ABI never authorize whole-projection rewrites',async()=>{
 for(const bad of [{abiId:null},{preconditions:[true]},{correspondence:{inputs:[{before:'a',after:'b'}]}}]) {
  const f=projectionFixture(),r=await optimizeSemanticDecompilation(f.result,{...f.options,...bad});
  assert.equal(r.proofOptimization.status,'partial');assert.equal(r.pseudocode,f.result.pseudocode);
 }
});
test('v8 independent BV oracle for projected constants at width 1/4/8/32/64',async()=>{
 let comparisons=0;
 for(const width of [1,4,8,32,64]) {
  const f=projectionFixture(width),r=await optimizeSemanticDecompilation(f.result,f.options);
  assert.equal(r.proofOptimization.status,'complete',r.proofOptimization.reason);
  const emitted=r.semanticAst.values.find(v=>v.valueId===f.target.id).expression.value;
  // Direct BigInt byte-width arithmetic, not Expr evaluator or lowering code.
  const count=width<=8?2**width:256;
  for(let k=0;k<count;k++) {const x=BigInt(k)* (width>8?0x123456789n:1n);const mask=(1n<<BigInt(width))-1n;assert.equal(emitted,(((x&mask)^((x+7n)&mask))^(((x+7n)&mask)^(x&mask)))&mask);comparisons++;}
 }
 assert.equal(comparisons,786);console.log(`V8_PROJECTION_ORACLE ${comparisons}`);
});
test('v8 forged semantic projection must not consume a genuine IR proof',async()=>{
 const f=proofFixture();f.result.semanticAst.values[0].expression.op='add';
 const r=await optimizeSemanticDecompilation(f.result,f.options);
 assert.equal(r.proofOptimization.status,'partial');assert.equal(r.proofOptimization.adopted,0);
});
test('v8 producer projection rejects same-id IR mutation before proof planning',async()=>{
 const f=projectionFixture(8,'or'),original=f.result.pseudocode,targetId=f.target.id;
 assert.match(original,/\|/);
 // Keep the same IR/value objects and SSA id while changing the definition from
 // the producer-rendered OR into an XOR that the later solver can prove zero.
 f.target.def.sub='xor';
 assert.equal(f.target.id,targetId);
 const r=await optimizeSemanticDecompilation(f.result,f.options);
 assert.equal(r.proofOptimization.status,'partial');
 assert.equal(r.proofOptimization.reason,'unissued-or-stale-projection');
 assert.equal(r.proofOptimization.adopted,0);
 assert.equal(r.pseudocode,original);
});
test('v8 final optimizer callback cannot change canonical IR while publishing an eligible projection',async()=>{
 const first=projectionFixture();let calls=0;
 const control=await optimizeSemanticDecompilation(first.result,{...first.options,isCancelled(){calls++;return false;}});
 assert.equal(control.proofOptimization.status,'complete',control.proofOptimization.reason);assert.ok(calls>0);
 const f=projectionFixture();let actual=0;
 const result=await optimizeSemanticDecompilation(f.result,{...f.options,isCancelled(){if(++actual===calls)f.target.def.sub='or';return false;}});
 assert.equal(actual,calls);assert.equal(result.proofOptimization.status,'partial');assert.equal(result.proofOptimization.adopted,0);assert.equal(result.pseudocode,f.result.pseudocode);
});
