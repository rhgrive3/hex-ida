import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liftDexMethod } from '../../../js/managed/dex/lifter.js';
import { lowerVMEffectsToSemanticIr, decompileManagedMethod } from '../../../js/managed/shared/bridge-v2.js';
import { dexMethod } from '../fixtures/medium-dex.mjs';
const lower=op=>lowerVMEffectsToSemanticIr(liftDexMethod(0,dexMethod([op,0,0x000e])));
test('#4836: iget writes its load result, never the receiver',()=>{
  const lowered=lower(0x1052),ir=lowered.semanticIr;
  const load=ir.nodes.find(n=>n.kind==='load'),write=ir.nodes.find(n=>n.kind==='state-write'&&n.variable.key==='vm:dex:register:0');
  assert.equal(load.outputs.length,1);assert.equal(write.inputs[0],load.outputs[0]);
  assert.doesNotThrow(()=>decompileManagedMethod(lowered));
});
test('#4836: iput derives the address from the receiver and stores the independent value',()=>{
  const ir=lower(0x1059).semanticIr;
  const store=ir.nodes.find(n=>n.kind==='store');
  const receiver=ir.nodes.find(n=>n.kind==='state-read'&&n.variable.key==='vm:dex:register:1');
  const value=ir.nodes.find(n=>n.kind==='state-read'&&n.variable.key==='vm:dex:register:0');
  const address=ir.nodes.find(n=>n.outputs.includes(store.memory.addressExpr.valueId));
  assert.ok(address.inputs.includes(receiver.outputs[0]));
  assert.deepEqual(store.inputs,[store.memory.addressExpr.valueId,value.outputs[0]]);
});
test('#4836: distinct field identities are retained in address formation',()=>{
  const image=dexMethod([0x1052,0,0x2052,1,0x000e],{fields:[{classType:'LTest;',type:'I',name:'a'},{classType:'LTest;',type:'I',name:'b'}]});
  const ir=lowerVMEffectsToSemanticIr(liftDexMethod(0,image)).semanticIr;
  const addressNodes=ir.nodes.filter(n=>n.operator==='managed.dex.instance-field-address');
  assert.equal(addressNodes.length,2);assert.notEqual(addressNodes[0].attributes.fieldIdentity,addressNodes[1].attributes.fieldIdentity);
});
