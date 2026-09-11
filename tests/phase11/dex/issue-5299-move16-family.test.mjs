import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liftDexMethod } from '../../../js/managed/dex/lifter.js';
import { lowerVMEffectsToSemanticIr } from '../../../js/managed/shared/bridge-v2.js';
import { dexMethod } from '../fixtures/medium-dex.mjs';
test('#5299: 32x move/16 variants decode full register indexes and widths',()=>{
  for(const [op,bits,name]of [[3,32,'move/16'],[6,64,'move-wide/16'],[9,32,'move-object/16']]){
    const fx=liftDexMethod(0,dexMethod([op,300,400,0x000e],{registers:512}));const b=fx.bundles[0];
    assert.equal(b.mnemonic,name);assert.equal(b.completeness,'exact');
    assert.equal(b.locationWrites[0].index,300);assert.equal(b.locationReads[0].index,400);assert.equal(b.locationWrites[0].bits,bits);
    if(op===9)assert.equal(b.locationWrites[0].type.kind,'address');
    const ir=lowerVMEffectsToSemanticIr(fx).semanticIr;
    const read=ir.nodes.find(n=>n.kind==='state-read'&&n.variable.key==='vm:dex:register:400');
    const write=ir.nodes.find(n=>n.kind==='state-write'&&n.variable.key==='vm:dex:register:300');assert.equal(write.inputs[0],read.outputs[0]);
  }
});
test('#5299: wide pairs at the register limit and reserved 32x bits are rejected',()=>{
  for(const words of [[6,7,0,0x000e],[0x0103,0,1,0x000e]])assert.notEqual(liftDexMethod(0,dexMethod(words,{registers:8})).bundles[0].completeness,'exact');
});
test('#5299: all nine move encodings preserve width and object category',()=>{
  for(const op of [1,2,3,4,5,6,7,8,9]) {
    const format=(op-1)%3, wide=op>=4&&op<=6, object=op>=7;
    const words=format===0?[0x2000|op,0xe]:format===1?[op,2,0xe]:[op,0,2,0xe];
    const effect=liftDexMethod(0,dexMethod(words)).bundles[0];
    assert.equal(effect.completeness,'exact');assert.equal(effect.locationReads[0].index,2);
    assert.equal(effect.locationWrites[0].index,0);assert.equal(effect.locationWrites[0].bits,wide?64:32);
    if(object)assert.equal(effect.locationWrites[0].type.kind,'address');
  }
});
