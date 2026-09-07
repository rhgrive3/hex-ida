import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { expr } from '../../../js/decompiler/ast/nodes.js';
import { generateEGraphCandidates, isEGraphCandidate, EGRAPH_LIMITS } from '../../../js/decompiler/phase8/egraph.js';
import { evaluateExpression } from '../../../js/decompiler/verify/equivalence.js';
import { stableDigest } from '../../../js/core/identity/index.js';
const source={ir:['ir:1'],rows:[1],addresses:['0x1000']};
const variable=(bits,name='x',extra={})=>expr.variable(name,bits,false,source,extra);
const constant=(value,bits)=>expr.constant(value,bits,false,source);
const binary=(op,left,right,bits=left.bits)=>expr.binary(op,left,right,bits,false,source);
const locks=JSON.parse(fs.readFileSync(new URL('../../../specs/005-analysis-final-closure/contracts/performance-locks.json',import.meta.url))).profiles['P-EGRAPH'];
const fixtures={
  'bv8-add-zero':()=>binary('add',variable(8),constant(0n,8)),
  'bv32-xor-self':()=>{const x=variable(32);return binary('xor',x,x);},
  'bv64-and-all-ones':()=>binary('and',variable(64),constant((1n<<64n)-1n,64)),
  'bv32-shift-boundary':()=>binary('shl',variable(32),constant(32n,32)),
  'bv16-ub-div-zero':()=>binary('udiv',variable(16),constant(0n,16)),
  'bv32-memory-effect-barrier':()=>binary('xor',expr.load({key:'m'},32,source),expr.load({key:'m'},32,source)),
  'bv32-width-mismatch':()=>binary('add',variable(32),constant(0n,8)),
  'bv8-cancel-replay':()=>binary('xor',variable(8),variable(8)),
};

test('locked eight-case denominator and bounded proof-only outcomes',()=>{
  assert.equal(stableDigest(locks.fixtureSet.descriptor),locks.fixtureSet.stableDigest);
  assert.deepEqual(Object.keys(fixtures),locks.fixtureSet.descriptor.cases);
  for(const [id,build] of Object.entries(fixtures)) {
    const input=build(), before=structuredClone(input);
    const result=generateEGraphCandidates(input,id==='bv8-cancel-replay'?{shouldAbort:()=>true}:{});
    assert.deepEqual(input,before,id);
    if(['bv8-add-zero','bv32-xor-self','bv64-and-all-ones'].includes(id)) {
      assert.equal(result.status,'complete',id);assert.equal(result.candidates.length,1,id);
      const candidate=result.candidates[0];assert.ok(isEGraphCandidate(candidate));
      assert.equal(candidate.proofRequired,true);assert.ok(Object.isFrozen(candidate.expression));
      assert.ok(candidate.origin.ir.includes('ir:1'));
      const values=input.bits===8?Array.from({length:256},(_,i)=>BigInt(i)):[0n,1n,0x7fffffffn,0xffffffffn,(1n<<64n)-1n];
      for(const x of values) assert.equal(evaluateExpression(input,{x}),evaluateExpression(candidate.expression,{x}),`${id}/${x}`);
    } else assert.equal(result.candidates.length,0,id);
    for(const [metric,cap] of Object.entries(EGRAPH_LIMITS)) {
      if(metric==='milliseconds') continue;
      assert.ok(result.metrics[metric]<=cap,`${id}/${metric}`);
    }
  }
});

test('metamorphic saturation, shift zero and provenance snapshots are stable without freezing inputs',()=>{
  const evidence={kind:'fixture',details:{line:1}};
  const x=expr.variable('x',8,false,{...source,evidence:[evidence]});
  const input=binary('shl',binary('and',binary('add',x,constant(0n,8)),constant(255n,8)),constant(0n,8));
  const a=generateEGraphCandidates(input),b=generateEGraphCandidates(input);
  assert.equal(a.candidates.length,1);assert.equal(a.candidates[0].inputDigest,b.candidates[0].inputDigest);
  assert.deepEqual(a.candidates,b.candidates);
  for(let i=0;i<256;i++)assert.equal(evaluateExpression(input,{x:BigInt(i)}),evaluateExpression(a.candidates[0].expression,{x:BigInt(i)}));
  assert.equal(Object.isFrozen(input),false);assert.equal(Object.isFrozen(evidence.details),false);
  evidence.details.line=2;
  assert.equal(a.candidates[0].origin.evidence[0].details.line,1);
  assert.equal(isEGraphCandidate({...a.candidates[0]}),false);
});

test('every configurable budget and cancellation prevents candidate publication, replay recovers',()=>{
  const root=fixtures['bv8-add-zero']();
  for(const key of Object.keys(EGRAPH_LIMITS)) {
    const result=generateEGraphCandidates(root,{limits:{[key]:0}});
    assert.equal(result.status,'budget',key);assert.deepEqual(result.candidates,[],key);
  }
  for(const limit of [NaN,Infinity,-1,'1',new Number(1)]) {
    assert.equal(generateEGraphCandidates(root,{limits:{workItems:limit}}).status,'unsupported');
  }
  let work=0;
  const stopped=generateEGraphCandidates(root,{shouldAbort:()=>++work>5});
  assert.equal(stopped.status,'cancelled');assert.deepEqual(stopped.candidates,[]);
  assert.equal(generateEGraphCandidates(root).candidates.length,1);
});

test('memory, undefined semantics, mismatched SSA versions and cyclic input stay unproved',()=>{
  const a=variable(8,'x',{ssaId:'x:1'}),b=variable(8,'x',{ssaId:'x:2'});
  const c=expr.variable('x',8,false,{...source,ssaDefs:['x:1']}),d=expr.variable('x',8,false,{...source,ssaDefs:['x:2']});
  for(const root of [binary('xor',a,b),binary('xor',c,d),{...fixtures['bv8-add-zero'](),undefinedResult:true}]) {
    assert.equal(generateEGraphCandidates(root).candidates.length,0);
  }
  const cyclic=fixtures['bv8-add-zero']();cyclic.left=cyclic;
  assert.equal(generateEGraphCandidates(cyclic).status,'unsupported');
  let reads=0;
  const withGetter=fixtures['bv8-add-zero']();
  Object.defineProperty(withGetter.source,'ir',{get(){reads++;return ['bad'];}});
  assert.equal(generateEGraphCandidates(withGetter).status,'unsupported');assert.equal(reads,0);
});
