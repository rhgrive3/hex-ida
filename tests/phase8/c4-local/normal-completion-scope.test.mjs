import test from 'node:test';
import assert from 'node:assert/strict';
import {machineIR,identity} from '../../phase9/memory/main-fixtures.mjs';
import {symbolicExecute} from '../../../js/symbolic/executor.js';
import {isExecutionResult,isExecutionSnapshot} from '../../../js/symbolic/memory/execution-snapshot.js';
import {projectedMemoryAccessContext} from '../../../js/semantics/compat/semantic-ir-v2-to-v1-memory.js';
import {queryMemoryEquivalence} from '../../../js/symbolic/query/memory-equivalence.js';
import {observableEffectReason} from '../../../js/decompiler/phase8/dce.js';
const fixture=()=>machineIR(['strb w1,[x0]','ldrsb x2,[x0]','ret']);
const context=ir=>({...identity,...projectedMemoryAccessContext(ir),addressSpace:'memory'});
const run=ir=>symbolicExecute(ir,{captureValues:true,symbolicArgs:{0:256n,1:128n,x30:4096n},byteMemory:{identity:context(ir),addressBits:64,wrapping:'modular',accessSemantics:'canonical-normal-completion'}});
test('conditional normal-memory execution never becomes unconditional transformation evidence',async()=>{
 const ir=fixture(),r=run(ir);assert.equal(r.status,'complete',r.reason);
 assert.equal(r.assumptions.length,2,'both original memory assumptions must remain observable');
 assert.ok(r.assumptions.every(a=>a.kind==='normal-memory-completion'&&a.possibleFaults.length>0));
 assert.ok(r.paths.every(p=>p.snapshot.assumptions.length===2));
 assert.ok(ir.instructions.filter(i=>['load','store'].includes(i.op)).every(i=>observableEffectReason(i)!==null));
 const q=await queryMemoryEquivalence({identity:context(ir),beforeIr:ir,afterIr:ir,inputs:[],memory:{addressBits:64,accessSemantics:'canonical-normal-completion'}});
 assert.equal(q.eligible,false);assert.equal(q.verdict,'unknown');assert.equal(q.reason,'memory-authority-option-conflict');
});
test('new faults and unwind cannot borrow an original normal-memory assumption',()=>{
 for(const annotate of [i=>{i.possibleFaults=[{kind:'data-abort'}];},i=>{i.extra.faults=[{kind:'injected-fault'}];},i=>{i.extra.mayUnwind=true;},i=>{i.extra.unwindTarget=0xdeadn;}]){
  const ir=fixture(),r=run(ir);assert.equal(r.status,'complete',r.reason);
  assert.ok(isExecutionResult(r,context(ir),ir));annotate(ir.instructions[0]);
  assert.equal(isExecutionResult(r,context(ir),ir),false);assert.equal(isExecutionSnapshot(r.paths[0].snapshot,context(ir),ir),false);
  const invalid=run(ir);assert.equal(invalid.status,'partial');assert.deepEqual(invalid.paths,[]);
 }
});
test('RET alignment discharge never redeems an added nonterminal fault on its projections',()=>{
 for(const op of ['mov','const','ret'])for(const layer of ['direct','extra','attributes']){
  const ir=machineIR(['mov x30, #4096','ret']);const execute=()=>symbolicExecute(ir,{captureValues:true,byteMemory:{identity,addressBits:64,wrapping:'modular'}});
  const initial=execute();assert.equal(initial.status,'complete',initial.reason);
  const inst=ir.instructions.find(i=>i.row===1&&i.op===op);assert.ok(inst);
  if(layer==='direct')inst.possibleFaults=[{kind:'data-abort'}];
  if(layer==='extra')inst.extra.possibleFaults=[{kind:'data-abort'}];
  if(layer==='attributes')inst.extra.attributes={...inst.extra.attributes,possibleFaults:[{kind:'data-abort'}]};
  assert.equal(isExecutionResult(initial,identity,ir),false,'the old result must become stale');
  const result=execute();assert.equal(result.status,'partial',`${op}/${layer}: RET may discharge only its own alignment condition`);assert.deepEqual(result.paths,[]);
 }
});
