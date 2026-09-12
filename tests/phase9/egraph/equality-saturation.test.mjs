import test from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../../../js/symbolic/index.js';
import {identity,scalarFixture} from '../taint/fixtures.mjs';
import {OP} from '../../../js/ir-base.js';
const E=S.expr, b=(op,x,y)=>E.createBinary(op,x,y), c=(n,w=4)=>E.createBv(w,BigInt(n));
const x=E.createFreshSymbol(E.bvSort(4),'egraph_x'), y=E.createFreshSymbol(E.bvSort(4),'egraph_y');
const run=(expression,extra={})=>S.queryEqualitySaturation({expression,valueId:'value',identity,memoryObservables:[],effectObservables:[],timeoutMs:2000,...extra});
const same=(a,b)=>E.computeStructuralHash(a)===E.computeStructuralHash(b);
const adopted=(r)=>r.candidates.filter(c=>c.eligible);

test('C4-05: nested rewriting reaches a rebuilt congruence fixed point',async()=>{
 const before=b('add',x,b('sub',y,y));const r=await run(before);
 assert.equal(r.status,'complete',r.reason);assert.equal(r.saturated,true);assert.ok(r.metrics.iterations>=2);
 const result=adopted(r).find(p=>same(p.after,x));assert.ok(result,'subexpression union must propagate to its parent');
 assert.equal(S.isAdoptableCandidate(result.verification),true);assert.equal(S.isAdoptableCandidate({...result.verification}),false);
 assert.ok(r.metrics.enodes>0 && r.metrics.unions>0 && r.metrics.verificationQueries>0);
});
test('C4-05: equivalent association/discovery order gives the same minimum representative',async()=>{
 for(const expression of [b('xor',b('xor',x,y),y),b('xor',y,b('xor',y,x)),b('add',b('sub',y,y),x)]) {
  const r=await run(expression);assert.equal(r.status,'complete',r.reason);assert.ok(adopted(r).some(p=>same(p.after,x)));
 }
});
test('C4-05: factoring/constant folding/strength reduction compose beyond one rewrite',async()=>{
 const before=b('add',b('mul',x,c(3)),b('mul',x,c(5)));const r=await run(before);
 assert.equal(r.status,'complete',r.reason);assert.ok(adopted(r).length);
 assert.ok(adopted(r).some(p=>p.cost.expensiveOps===0),'extracted shift eliminates multiply');
});
test('C4-05: pure Bool terms are separate from BV and use genuine verification',async()=>{
 const p=E.createFreshSymbol(E.boolSort(),'egraph_bool');
 const r=await run(E.createConnective('or',p,E.createConnective('not',p)));
 assert.equal(r.status,'complete',r.reason);assert.ok(adopted(r).some(a=>a.after.kind==='const' && a.after.value===true));
});
test('C4-05: real opt-in tiered backend proves 32/64-bit candidates',async()=>{
 for(const width of [32,64]) {
  const symbol=E.createFreshSymbol(E.bvSort(width),`wide_${width}`),r=await run(b('xor',symbol,symbol),{backendTier:'tiered'});
  assert.equal(r.status,'complete',r.reason);assert.ok(adopted(r).some(a=>a.after.value===0n));
 }
});
test('C4-05: contradictory preconditions never authorize an extracted term',async()=>{
 const r=await run(b('sub',x,x),{preconditions:[E.createBool(false)]});
 assert.equal(r.status,'complete',r.reason);assert.equal(adopted(r).length,0);assert.ok(r.candidates.every(a=>!a.eligible));
});
test('C4-05: memory, unknown semantics and injected proof/rules fail closed',async()=>{
 for(const extra of [{memoryObservables:[{id:'heap'}]},{effectObservables:[{id:'call'}]},{rules:[]},{verified:true},{backend:{check:()=>({status:'unsat'})}},{executionSnapshot:{}}]){
  const r=await run(b('sub',x,x),extra);assert.equal(r.status,'partial');assert.deepEqual(r.candidates,[]);
 }
 const unknown=await run(E.createUnknownSemantic(E.bvSort(4),'load'));assert.equal(unknown.status,'partial');assert.deepEqual(unknown.candidates,[]);
});
test('C4-05: N-1/N/N+1 node ceiling is checked before allocation',async()=>{
 for(const limit of [0,1,2]) {
  const r=await run(x,{limits:{enodes:limit,eclasses:limit}});
  assert.equal(r.status,limit===0?'partial':'complete',r.reason);assert.ok(r.metrics.enodes<=limit);assert.deepEqual(r.candidates,[]);
 }
});
test('C4-05: work/iteration ceilings never publish an earlier candidate as a completed batch',async()=>{
 for(const limits of [{workItems:0},{iterations:0},{unions:0},{candidates:0}]){
  const r=await run(b('sub',x,x),{limits});assert.equal(r.status,'partial');assert.deepEqual(r.candidates,[]);
 }
});
test('C4-05: cancellation, stale identity and expired deadline publish no receipts',async()=>{
 const ac=new AbortController();const p=run(b('sub',x,x),{signal:ac.signal});ac.abort();
 for(const r of [await p,await run(b('sub',x,x),{timeoutMs:0}),await run(b('sub',x,x),{getCurrentIdentity:()=>({...identity,snapshotId:'stale'})})]){
  assert.equal(r.status,'partial');assert.deepEqual(r.candidates,[]);
 }
});
test('C4-05: repeat query is immutable/deterministic without cross-snapshot cached authority',async()=>{
 const expr=b('add',x,b('sub',y,y));const a=await run(expr),d=await run(expr);
 assert.deepEqual(a.candidates.map(c=>c.candidateId),d.candidates.map(c=>c.candidateId));assert.ok(Object.isFrozen(a.candidates));
 const bResult=await run(expr,{identity:{...identity,snapshotId:'new'}});
 assert.ok(adopted(bResult).length);assert.equal(S.isAdoptableCandidate(adopted(a)[0].verification,{identity:bResult.identity}),false);
});
function oracle(node,env){
 if(node.kind==='const')return node.value;if(node.kind==='fresh_symbol')return env[node.symbolId];
 const mask=(1n<<BigInt(node.sort.width))-1n;
 if(node.kind==='unary')return (node.op==='not'?~oracle(node.arg,env):-oracle(node.arg,env))&mask;
 const a=oracle(node.left,env),d=oracle(node.right,env);
 switch(node.op){case 'add':return(a+d)&mask;case 'sub':return(a-d)&mask;case 'mul':return(a*d)&mask;case 'xor':return a^d;case 'or':return a|d;case 'and':return a&d;case 'shl':return d>=BigInt(node.sort.width)?0n:(a<<d)&mask;default:throw Error(`independent oracle unsupported ${node.op}`);}
}
test('C4-05: independent concrete oracle checks every published candidate on the full small domain',async()=>{
 const corpus=[b('xor',b('xor',x,y),y),b('and',x,b('or',x,y)),b('or',x,b('and',x,y)),b('add',b('mul',x,c(2)),b('mul',x,c(2)))];
 let comparisons=0;
 for(const before of corpus){const r=await run(before);assert.equal(r.status,'complete',r.reason);assert.ok(adopted(r).length);
  for(const p of adopted(r))for(let a=0n;a<16n;a++)for(let d=0n;d<16n;d++){
   const env={[x.symbolId]:a,[y.symbolId]:d};assert.equal(oracle(before,env),oracle(p.after,env));comparisons++;
  }
 }
 console.log(JSON.stringify({oracle:'independent-egraph-bv4',comparisons}));
});
test('C4-05: production source -> taint -> actual IR target -> egraph -> proof -> evidence',async()=>{
 const ir=scalarFixture(),inst=ir.blocks[0].insts[0];inst.op=OP.BIN;inst.sub='xor';inst.args.push(inst.args[0]);
 const models=S.createTaintModels({id:'eqs',version:'1',provenance:'regression',sources:[{id:'source',valueId:'input'}],sinks:[{id:'sink',valueId:'out'}]});
 const r=await S.querySymbolicAnalysis(ir,{identity,models,memory:{addressBits:8},targets:[inst.dst],candidateStrategy:'equality-saturation',timeoutMs:2000,backendTier:'tiered'});
 assert.equal(r.status,'complete',r.reason);assert.deepEqual(r.taint.sinks[0].taint.sources,['source']);assert.ok(r.taint.evidence);
 assert.ok(r.targets[0].candidates.some(p=>p.rule==='equality-saturation' && p.eligible));assert.ok(S.isSymbolicAnalysisResult(r));
 inst.sub='or';assert.equal(S.isSymbolicAnalysisResult(r),false);
});
