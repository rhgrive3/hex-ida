import test from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../../../js/symbolic/index.js';
import { OP } from '../../../js/ir-base.js';
import { identity } from '../memory/main-fixtures.mjs';
const E=S.expr;
test('raw translator rejects nested metadata accessors without invoking them',()=>{
  for(const target of ['attributes','machineEffects','destination']) {
    let calls=0;
    const extra={};
    const destination={id:'dst',bits:8};
    const inst={op:OP.CONST,extra,dst:destination,value:1n,args:[]};destination.def=inst;
    const get=()=>{calls++;return {};};
    if(target==='attributes')Object.defineProperty(extra,'attributes',{enumerable:true,get});
    if(target==='machineEffects'){extra.attributes={};Object.defineProperty(extra.attributes,'machineEffects',{enumerable:true,get});}
    if(target==='destination'){destination.extra={};Object.defineProperty(destination.extra,'attributes',{enumerable:true,get});}
    const result=S.translate.translateSemanticIR(inst);
    assert.notEqual(result.status,'exact');assert.equal(calls,0,target);
  }
});
test('pure proof adoption does not delegate condition equality to caller methods',async()=>{
  const x=E.createFreshSymbol(E.bvSort(2),'scope_x'),zero=E.createBv(2,0n);
  const P=E.createCompare('eq',x,zero);
  const result=await S.verifyDeobfuscationCandidate({candidateId:'review',beforeValueId:'before',afterValueId:'after',
    identity,before:x,after:zero,preconditions:[P],correspondence:{inputs:[]},memoryObservables:[],effectObservables:[]});
  assert.equal(result.eligible,true,result.reason);
  const wrong=[E.createBool(true)];wrong.some=()=>false;
  assert.equal(S.isAdoptableCandidate(result,{identity,preconditions:wrong}),false);
  assert.equal(S.isAdoptableCandidate(result,{identity,preconditions:[P]}),true);
});
test('proof submission snapshots array elements without caller slice or iterator methods',async()=>{
  const x=E.createFreshSymbol(E.bvSort(2),'submission_x'),zero=E.createBv(2,0n);
  const provided=[E.createBool(true)];provided.slice=()=>[E.createCompare('eq',x,zero)];
  const result=await S.verifyDeobfuscationCandidate({candidateId:'review-input',beforeValueId:'b',afterValueId:'a',
    identity,before:x,after:zero,preconditions:provided,correspondence:{inputs:[]},memoryObservables:[],effectObservables:[]});
  assert.equal(result.eligible,false);
});
test('proof solver work is reserved before any backend evaluation',async()=>{
  const x=E.createFreshSymbol(E.bvSort(2),'bounded_x');
  const result=await S.verifyDeobfuscationCandidate({candidateId:'bounded',beforeValueId:'b',afterValueId:'a',
    identity,before:x,after:x,preconditions:[],correspondence:{inputs:[]},memoryObservables:[],effectObservables:[],limits:{reservedEvaluations:0}});
  assert.equal(result.eligible,false);assert.equal(result.reason,'budget:reservedEvaluations');
});
test('instruction and value entrypoints agree on explicitly declared Bool/BV result sorts',()=>{
  const a={id:'a',const:1n,bits:8},b={id:'b',const:2n,bits:8};
  const dst={id:'comparison',bits:8};const inst={op:OP.CMP,cond:'lt',args:[{value:a},{value:b}],dst};dst.def=inst;
  assert.notEqual(S.translate.translateSemanticIR(inst).status,'exact');
  assert.notEqual(S.translate.translateSemanticIR(dst).status,'exact');
  const scalar={op:OP.CONST,value:1n,args:[],dst:{id:'wrong-bool',bits:1,machineType:{kind:'bool',widthBits:1}}};
  assert.notEqual(S.translate.translateSemanticIR(scalar).status,'exact');
});
test('choosing one PHI predecessor remains explicitly path-scoped rather than universally exact',()=>{
  const phi={id:'phi-scope',op:OP.PHI,dst:{id:'v',bits:8},args:[],incoming:[{from:0,value:{id:'a',bits:8,const:1n}},{from:1,value:{id:'b',bits:8,const:2n}}]};
  const r=S.translate.translateSemanticIR(phi,{fromBlock:0});
  assert.notEqual(r.status,'exact');assert.equal(E.evaluateExpr(r.expression,{}).value,1n);
  assert.equal(r.completeness.queryScope,'partial');assert.ok(r.assumptions.some(a=>a.kind==='phi-predecessor-scope'));
});
test('scalar folding reserves expanded work for shared constant DAGs before evaluation',async()=>{
  const {translateMemoryScalar}=await import('../../../js/symbolic/translate/memory.js');
  let shared=E.createBv(8,1n);for(let i=0;i<16;i++)shared=E.createBinary('add',shared,shared);
  for(const [inst,args,bits,condition]of [
    [{op:OP.MOV},[shared],8,null],
    [{op:OP.MOV,sub:'zext'},[shared],16,null],
    [{op:OP.SEL},[shared,E.createBv(8,0n)],8,E.createBool(true)],
  ])assert.throws(()=>translateMemoryScalar(inst,args,bits,condition),/scalar-evaluation-budget/);
});
test('production candidate batches cannot erase a contradictory submitted precondition through slice',async()=>{
  const x=E.createFreshSymbol(E.bvSort(2),'batch_scope');
  const conditions=[E.createBool(false)];conditions.slice=()=>[];
  const r=await S.queryDeobfuscationCandidates({identity,expression:E.createBinary('xor',x,x),valueId:'target',
    preconditions:conditions,memoryObservables:[],effectObservables:[]});
  assert.equal(r.status,'complete',r.reason);assert.ok(r.candidates.length>0);assert.ok(r.candidates.every(c=>!c.eligible));
});
