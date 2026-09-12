import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSemanticModel } from '../../../js/blocks.js';
import { decompile,decompileWithProof,optimizeSemanticDecompilation } from '../../../js/decompile.js';
import { proofFixture,projectionFixture,identity } from '../helpers/proof-fixtures.mjs';
import { preparePhase8RewritePlan,createAnalysisState } from '../../../js/decompiler/phase8/index.js';
import {runProofRewritePass,readProvedRewrites} from '../../../js/decompiler/phase8/pass-validation.js';
import { enhanceSemanticDecompilation, producerUsesProofOnlyRewrites } from '../../../js/decompiler/pipeline.js';
import { fixture as irFixture } from '../helpers/ir-fixtures.mjs';
import { applyPhase8Projection } from '../../../js/decompiler/phase8/projection.js';
import { analysis as viewAnalysis, inductionFact } from '../provenance/fixture.js';

function deferredFixture({bits=4,op='xor',defer=true,store=false,mutateOptions=false,options={}}={}) {
 const f=irFixture('deferred-scalar');f.block(0);
 const input=f.opaque(bits);input.reg='x0';input.index=0;
 const target=f.binary(op,input,input,bits);
 if(store)f.store(target,{locKind:'global',locKey:'global:32768'});
 f.ret();const ir=f.build();ir.instructions=ir.blocks.flatMap(b=>b.insts);
 ir.instructions.forEach((inst,index)=>{inst.id=`defer_${index}`;inst.address=0x1000n+BigInt(index*4);});
 const ret=ir.instructions.at(-1);ret.args=[{value:target}];target.uses.push(ret);
 const canonical=structuredClone(ir);
 const seed={semantic:true,ir,types:null,lines:ir.instructions.filter(inst=>['ret','store'].includes(inst.op)).map(inst=>({
  kind:'stmt',indent:0,text:inst.op==='ret'?'return old;':'old = value;',row:inst.row,addr:inst.address})),metrics:{},ctx:{}};
 const opts={phase8PrepareProof:true,phase8ProofOnlyRewrites:defer,deterministicTransforms:true,decompilerTimeBudgetMs:1000,...options};
 if(mutateOptions)opts.symbolFor=()=>{opts.phase8ProofOnlyRewrites=!defer;return 'global_value';};
 const result=enhanceSemanticDecompilation(seed,null,opts);
 return {ir,input,target,result,canonical,opts,proof:{identity,abiId:'generic-v1',memory:{addressBits:8},targets:[target],
  timeoutMs:1000,backendTier:'tiered',candidateStrategy:'representation-rules',requireProofOnlyRewrites:true}};
}

test('C4-04 proof preparation retains the real pre-rule expression across six widths and three existing strategies',async()=>{
 for(const bits of [1,4,8,16,32,64]) {
  const ordinary=deferredFixture({bits,defer:false}),f=deferredFixture({bits});
  assert.ok(ordinary.result.rewriteProof.some(row=>row.rule==='xor-self'));
  assert.equal(ordinary.result.pseudocode,'return 0;');
  assert.ok(!f.result.rewriteProof.some(row=>row.rule==='xor-self'));
  assert.match(f.result.pseudocode,/\^/);
  assert.equal(f.result.rewriteStats.applications,0);
  assert.equal(f.result.rewriteStats.deferred,'phase8-proof-projection');
  assert.equal(producerUsesProofOnlyRewrites(f.result),true);
  for(const candidateStrategy of ['local-rewrites','representation-rules','equality-saturation']) {
   const r=await optimizeSemanticDecompilation(f.result,{...f.proof,candidateStrategy});
   assert.equal(r.proofOptimization.status,'complete',r.proofOptimization.reason);
   assert.equal(r.proofOptimization.rewritePolicy,'deferred-optional-scalar-rewrites');
   assert.equal(r.proofOptimization.adopted,1);assert.equal(r.pseudocode,'return 0;');
   assert.ok(r.phase8Projection.transforms.every(row=>row.kind==='solver-constant'&&row.queryHash));
   assert.match(f.result.pseudocode,/\^/);assert.deepEqual(structuredClone(f.ir),f.canonical);
  }
 }
});

test('C4-04 a refuted BV1 proposal leaves the exact prepared expression and no adoption',async()=>{
 const f=deferredFixture({bits:1,op:'add'}),before=f.result.pseudocode;
 const r=await optimizeSemanticDecompilation(f.result,f.proof);
 assert.equal(r.proofOptimization.status,'complete',r.proofOptimization.reason);
 assert.equal(r.proofOptimization.targetDecisions[0].disposition,'refuted');
 assert.equal(r.proofOptimization.adopted,0);assert.equal(r.pseudocode,before);
 assert.deepEqual(r.phase8Projection.transforms,[]);
 assert.deepEqual(structuredClone(f.ir),f.canonical);
});

test('C4-04 unknown, exhausted and cancelled proof requests preserve the prepared AST',async()=>{
 for(const options of [{timeoutMs:0},{isCancelled:()=>true},{phase8WorkBudget:0}]) {
  const f=deferredFixture(),r=await optimizeSemanticDecompilation(f.result,{...f.proof,...options});
  assert.equal(r.proofOptimization.status,'partial');assert.equal(r.proofOptimization.adopted,0);
  assert.equal(r.pseudocode,f.result.pseudocode);assert.equal(r.cAst,f.result.cAst);assert.equal(r.semanticAst,f.result.semanticAst);
  assert.ok(!(r.phase8Projection?.transforms??[]).length);
  assert.deepEqual(structuredClone(f.ir),f.canonical);
 }
});

test('C4-04 proof-only policy survives replays and cannot be downgraded through request metadata',async()=>{
 const f=deferredFixture(),r=await optimizeSemanticDecompilation(f.result,f.proof);
 const replay=await optimizeSemanticDecompilation({...r,phase8ProofOnlyRewrites:false,
  proofOptimization:{...r.proofOptimization,rewritePolicy:'existing-projection'}},
  {...f.proof,phase8ProofOnlyRewrites:false,requireProofOnlyRewrites:false});
 assert.equal(replay.proofOptimization.status,'complete',replay.proofOptimization.reason);
 assert.equal(replay.proofOptimization.adopted,0);assert.equal(replay.pseudocode,r.pseudocode);
 assert.equal(producerUsesProofOnlyRewrites(replay),true);
 assert.equal(replay.proofOptimization.rewritePolicy,'deferred-optional-scalar-rewrites');
 const legacy=deferredFixture({defer:false});
 const refused=await optimizeSemanticDecompilation({...legacy.result,phase8ProofOnlyRewrites:true,
  proofOptimization:{rewritePolicy:'deferred-optional-scalar-rewrites'}},legacy.proof);
 assert.equal(refused.proofOptimization.reason,'proof-only-preparation-required');
 assert.equal(refused.proofOptimization.adopted,0);assert.equal(refused.cAst,legacy.result.cAst);
});

test('C4-04 ordinary projection facts cannot bypass a privately prepared proof-only policy',()=>{
 const ordinary=deferredFixture({defer:false,options:{argNames:['v123']}}),f=deferredFixture({options:{argNames:['v123']}});
 const a=applyPhase8Projection(ordinary.result,viewAnalysis(inductionFact(ordinary.input.id)));
 assert.ok(a.phase8Projection.transforms.some(row=>row.kind==='induction-variable'));
 const b=applyPhase8Projection(f.result,viewAnalysis(inductionFact(f.input.id)),{phase8ProofOnlyRewrites:false});
 assert.deepEqual(b.phase8Projection.transforms,[]);
 assert.equal(b.pseudocode,f.result.pseudocode);
});

test('C4-04 late configuration changes cannot relabel which preparation path actually ran',()=>{
 for(const defer of [false,true]) {
  const f=deferredFixture({defer,store:true,mutateOptions:true});
  assert.equal(f.opts.phase8ProofOnlyRewrites,!defer,'the real location renderer invoked the callback');
  assert.equal(producerUsesProofOnlyRewrites(f.result),defer);
  assert.equal(f.result.rewriteProof.some(row=>row.rule==='xor-self'),!defer);
 }
});

test('C4-04 deadline fallback cannot silently re-enable optional scalar rewrites',async()=>{
 const f=deferredFixture({options:{deterministicTransforms:false,decompilerTimeBudgetMs:1e-12}});
 assert.ok(f.result.passMetrics.some(pass=>pass.skipped));
 assert.match(f.result.pseudocode,/\^/);assert.ok(!f.result.rewriteProof.some(row=>row.rule==='xor-self'));
 assert.equal(producerUsesProofOnlyRewrites(f.result),true);
 const r=await optimizeSemanticDecompilation(f.result,{...f.proof,timeoutMs:0});
 assert.equal(r.proofOptimization.adopted,0);assert.equal(r.pseudocode,f.result.pseudocode);
});

test('C4-04 proof API does not re-decompile or certify an already simplified canonical snapshot',async()=>{
 const f=deferredFixture({defer:false});
 const r=await decompileWithProof({__canonicalDecompiler:f.result},{phase8ProofOnlyRewrites:true},
  {...f.proof,requireProofOnlyRewrites:false});
 assert.equal(r.proofOptimization.reason,'proof-only-preparation-required');
 assert.equal(r.proofOptimization.adopted,0);assert.equal(r.pseudocode,f.result.pseudocode);
 assert.equal(r.ir,f.ir);assert.equal(r.cAst,f.result.cAst);
});

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
 assert.equal(r.proofOptimization.adopted,5);
 assert.equal(r.phase8Projection.transforms.filter(t=>t.kind==='solver-constant').length,2);
 assert.equal(r.phase8Projection.transforms.filter(t=>t.kind==='solver-scalar').length,3);
 assert.equal(r.proofOptimization.targetDecisions.filter(t=>t.disposition==='adopted').length,5);
 assert.match(r.pseudocode,/return 0;/);assert.doesNotMatch(r.pseudocode,/\^/);
 assert.ok(r.ir.instructions.some(i=>i.op==='bin'&&i.sub==='xor'),'original instruction effects remain');
 for(const transform of r.phase8Projection.transforms) {
  assert.equal(transform.generatorAudit?.strategy,'equality-saturation');
  assert.equal(transform.generatorAudit.proofQueryHash,transform.queryHash);
  assert.ok(r.renderProvenance.ledger.some(row=>row.queryHash===transform.queryHash
   && row.generatorAudit?.candidateId===transform.generatorAudit.candidateId));
 }
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

test('C4-05 rule schedules reach the real producer and proof plan without conflating schedule with proof authority',async()=>{
 const f=projectionFixture(4),plans=[],outputs=[];
 for(const ruleOrder of ['canonical','reverse','discovery']) {
  const options={...f.options,ruleOrder},plan=await preparePhase8RewritePlan(f.ir,options);
  assert.equal(plan.status,'complete',plan.reason);assert.equal(plan.ruleOrder,ruleOrder);
  assert.ok(plan.targetDecisions.every(row=>row.ruleOrder===ruleOrder));
  const r=await optimizeSemanticDecompilation(f.result,options);
  assert.equal(r.proofOptimization.status,'complete',r.proofOptimization.reason);
  assert.equal(r.proofOptimization.adopted,2);
  assert.ok(r.proofOptimization.targetDecisions.every(row=>row.ruleOrder===ruleOrder));
  assert.match(r.pseudocode,/return 0;/);assert.equal(r.ir,f.ir);
  assert.ok(r.phase8Projection.transforms.every(t=>t.queryHash && t.planId));
  plans.push(plan.planId);outputs.push(r.pseudocode);
 }
 assert.equal(new Set(plans).size,3,'schedule is part of plan audit identity');
 assert.equal(new Set(outputs).size,1);
 assert.match(f.result.pseudocode,/\^/,'original producer output is retained');
 const invalid=await optimizeSemanticDecompilation(f.result,{...f.options,ruleOrder:'random'});
 assert.equal(invalid.proofOptimization.status,'partial');assert.equal(invalid.proofOptimization.adopted,0);
 assert.equal(invalid.pseudocode,f.result.pseudocode);
});
