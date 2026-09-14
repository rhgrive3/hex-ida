import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liftDexMethod } from '../../../js/managed/dex/lifter.js';
import { lowerVMEffectsToSemanticIr } from '../../../js/managed/shared/bridge-v2.js';
import { dexMethod } from '../fixtures/medium-dex.mjs';
const variants=[['I',4,null],['J',8,null],['LTest;',4,null],['Z',1,'zext'],['B',1,'sext'],['C',2,'zext'],['S',2,'sext']];
test('#4821: all instance field variants preserve storage width and signed extension',()=>{
  variants.forEach(([type,bytes,extend],i)=>{
    for(const store of [false,true]){
      const fx=liftDexMethod(0,dexMethod([0x1052+i+(store?7:0),0,0x000e],{fields:[{classType:'LTest;',name:'x',type}]}));const b=fx.bundles[0];
      assert.equal(b.completeness,'exact');assert.equal(b.memoryEffects[0].byteWidth,bytes);
      const ir=lowerVMEffectsToSemanticIr(fx).semanticIr;const mem=ir.nodes.find(n=>n.kind===(store?'store':'load'));
      assert.equal(mem.memory.widthBits,bytes*8);
      if(extend)assert.ok(ir.nodes.some(n=>n.kind===(store?'trunc':extend)));
      if(type==='J')assert.equal((store?b.locationReads.find(r=>r.index===0):b.locationWrites[0]).bits,64);
      if(type==='LTest;')assert.equal((store?b.locationReads.find(r=>r.index===0):b.locationWrites[0]).type.kind,'address');
    }
  });
});
test('#4821: field descriptor/opcode contradictions cannot mint exact memory',()=>{
  for(const [op,type]of [[0x53,'I'],[0x52,'J'],[0x54,'I'],[0x55,'B']]){
    const b=liftDexMethod(0,dexMethod([0x1000+op,0,0x000e],{fields:[{classType:'LTest;',name:'x',type}]})).bundles[0];
    assert.notEqual(b.completeness,'exact');assert.deepEqual(b.memoryEffects,[]);
  }
});
