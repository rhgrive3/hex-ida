import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liftDexMethod } from '../../../js/managed/dex/lifter.js';
import { lowerVMEffectsToSemanticIr, decompileManagedMethod } from '../../../js/managed/shared/bridge-v2.js';
import { dexMethod } from '../fixtures/medium-dex.mjs';
function callImage(type,move){return dexMethod([0x0071,1,0,move,0x000e],{methods:[{name:'m',classType:'LTest;',proto:{returnType:'V',params:[]}},{name:'callee',classType:'LTest;',proto:{returnType:type,params:[]}}]});}
test('#5256: invoke results have a typed producer/consumer relation through the real bridge',()=>{
  for(const [type,op,bits]of [['I',0x0a,32],['J',0x0b,64],['LTest;',0x0c,32]]){
    const fx=liftDexMethod(0,callImage(type,op));
    assert.equal(fx.bundles[0].producedValues[0]?.bits,bits);
    assert.equal(fx.bundles[1].locationReads[0]?.name,'result');
    const lowered=lowerVMEffectsToSemanticIr(fx),ir=lowered.semanticIr;
    const call=ir.nodes.find(n=>n.kind==='call'),resultWrite=ir.nodes.find(n=>n.kind==='state-write'&&n.variable.key==='vm:dex:runtime:result');
    assert.equal(resultWrite.inputs[0],call.outputs[0]);
    const read=ir.nodes.find(n=>n.kind==='state-read'&&n.variable.key==='vm:dex:runtime:result');
    const write=ir.nodes.find(n=>n.kind==='state-write'&&n.variable.key==='vm:dex:register:0');assert.equal(write.inputs[0],read.outputs[0]);
    const val=ir.values.find(v=>v.id===read.outputs[0]);assert.equal(val.machineType.widthBits,bits);if(op===0x0c)assert.equal(val.machineType.kind,'address');
    assert.doesNotThrow(()=>decompileManagedMethod(lowered));
  }
});
test('#5256: stray, mismatched, delayed, or void move-result cannot write a fabricated value',()=>{
  const delayed=callImage('I',0x0000);new DataView(delayed.rawBytes.buffer).setUint16(28,0x000a,true);
  for(const image of [callImage('V',0x0a),callImage('J',0x0a),dexMethod([0x000a,0x000e]),delayed]){
    const fx=liftDexMethod(0,image);assert.notEqual(fx.aggregateCompleteness,'exact');
    assert.doesNotThrow(()=>lowerVMEffectsToSemanticIr(fx));
    for(const b of fx.bundles.filter(b=>b.opcode===0x0a))assert.equal(b.locationWrites.length,0);
  }
});
test('#5256: move-exception reads handler entry state, never the invocation result',()=>{
  const image=dexMethod([0x0027,0x000d,0x000e],{tries:[{start:0,count:1,handlerOff:1}],handlers:[1,0,1]});
  const fx=liftDexMethod(0,image);assert.equal(fx.bundles[1].locationReads[0]?.kind,'runtime');
  assert.equal(fx.bundles[1].locationReads[0]?.name,'exception:2');assert.equal(fx.bundles[1].locationReads[0]?.type.kind,'address');
  assert.doesNotThrow(()=>lowerVMEffectsToSemanticIr(fx));
  const stray=liftDexMethod(0,dexMethod([0x000d,0x000e]));assert.notEqual(stray.bundles[0].completeness,'exact');assert.equal(stray.bundles[0].locationWrites.length,0);
});
