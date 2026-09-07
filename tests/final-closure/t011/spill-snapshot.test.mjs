import assert from 'node:assert/strict';
import test from 'node:test';
import { expr } from '../../../js/decompiler/ast/nodes.js';
import { recoverCommittedPhiSpillSnapshots } from '../../../js/decompiler/passes/stack-return-recovery.js';

function fixture() {
  const field = { kind:'field', key:'field:hp', text:'self->hp', name:'hp', size:4 };
  const stack = { kind:'stack', key:'stack:saved', text:'local_saved', size:4 };
  const values = [0,1].map(id => ({ id:`v${id}`, bits:32 }));
  const stores = values.map((value,block) => ({ id:10+block, op:'store', block, row:1,
    loc:field, args:[{ value }] }));
  const phi = { id:20, op:'phi', block:2, row:2,
    incoming:values.map((value,from)=>({from,value})) };
  const merged = { id:'merged', bits:32, def:phi };
  const spill = { id:21, op:'store', block:2, row:3, loc:stack, args:[{value:merged}] };
  const call = { id:22, op:'call', block:2, row:4, args:[] };
  const old = expr.variable('local_phi',32);
  const semanticStore = { location:stack, expression:old, source:{ir:[21]} };
  return { semantic:true,
    ir:{instructions:[...stores,phi,spill,call], blocks:[
      {index:0,pred:[],succ:[2],insts:[stores[0]]},
      {index:1,pred:[],succ:[2],insts:[stores[1]]},
      {index:2,pred:[0,1],succ:[],insts:[phi,spill,call]},
    ],idom:[-1,-1,-1]},
    semanticAst:{stores:[...stores.map(store=>({location:field,source:{ir:[store.id]}})),semanticStore],outputs:[]},
    cAst:{body:[
      {kind:'stmt',indent:0,text:'local_saved = local_phi;',source:{ir:[21]},semantic:{op:'store',ir:21,location:stack,expression:old}},
      {kind:'stmt',indent:0,text:'unknown_call();',source:{ir:[22]},semantic:{op:'call'}},
      {kind:'stmt',indent:0,text:'return local_saved;',source:{ir:[23]},semantic:{op:'return'}},
    ]},pseudocode:'before',lines:[],sourceMap:[] };
}
const opts = { deterministicTransforms:true };

test('a live complete PHI is captured before an unknown call without rereading afterward',()=>{
  const result=fixture();
  recoverCommittedPhiSpillSnapshots(result,opts);
  assert.equal(result.cAst.body[0].text,'local_saved = self->hp;');
  assert.equal(result.cAst.body[1].text,'unknown_call();');
  assert.equal(result.cAst.body[2].text,'return local_saved;');
  assert.equal(result.semanticAst.stores[2].expression,result.cAst.body[0].semantic.expression);
});

test('missing predecessors, detached PHIs and intervening effects withhold the snapshot',()=>{
  for(const mutate of [
    r=>r.ir.instructions.find(i=>i.op==='phi').incoming.pop(),
    r=>r.ir.instructions.splice(r.ir.instructions.findIndex(i=>i.op==='phi'),1),
    r=>{r.ir.instructions.find(i=>i.op==='call').row=2;},
    r=>{r.ir.instructions.find(i=>i.id===11).loc={kind:'field',key:'field:other',size:4};},
  ]){
    const result=fixture();mutate(result);
    recoverCommittedPhiSpillSnapshots(result,opts);
    assert.equal(result.pseudocode,'before');
    assert.equal(result.cAst.body[0].text,'local_saved = local_phi;');
  }
});

test('cancellation and printer failure retain the original snapshot publication',()=>{
  const cancelled=fixture();
  recoverCommittedPhiSpillSnapshots(cancelled,{...opts,shouldAbort:()=>true});
  assert.equal(cancelled.pseudocode,'before');
  const result=fixture();const old=result.semanticAst.stores[2].expression;
  Object.defineProperty(result.cAst.body[1],'indent',{get(){throw new Error('printer-failure');}});
  assert.throws(()=>recoverCommittedPhiSpillSnapshots(result,opts),/printer-failure/);
  assert.equal(result.pseudocode,'before');
  assert.equal(result.cAst.body[0].text,'local_saved = local_phi;');
  assert.equal(result.semanticAst.stores[2].expression,old);
});
