import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liftDexMethod } from '../../../js/managed/dex/lifter.js';
import { lowerVMEffectsToSemanticIr } from '../../../js/managed/shared/bridge-v2.js';
import { dexMethod } from '../fixtures/medium-dex.mjs';
test('#5293: sget/sput variants have explicit static storage, widths, and value flow',()=>{
  ['I','J','LTest;','Z','B','C','S'].forEach((type,i)=>{
    for(const store of [false,true]){
      const bcode=[0x0060+i+(store?7:0),0,0x000e];const fx=liftDexMethod(0,dexMethod(bcode,{fields:[{classType:'LTest;',type,name:'x'}]}));const b=fx.bundles[0];
      assert.equal(b.completeness,'exact');assert.ok(b.mnemonic.startsWith(store?'sput':'sget'));
      assert.equal(b.memoryEffects[0].space,'static-field');assert.equal(b.locationReads.length,store?1:0);
      const ir=lowerVMEffectsToSemanticIr(fx).semanticIr;assert.ok(ir.nodes.some(n=>n.kind===(store?'store':'load')));
      assert.ok(ir.nodes.some(n=>n.operator==='managed.dex.static-field-address'));
    }
  });
});
test('#5293: invalid static field references and variant conflicts remain partial',()=>{
  for(const [op,index]of [[0x60,1],[0x61,0]]){const b=liftDexMethod(0,dexMethod([op,index,0x000e])).bundles[0];assert.notEqual(b.completeness,'exact');assert.deepEqual(b.memoryEffects,[]);}
});
