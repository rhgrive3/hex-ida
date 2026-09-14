import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liftDexMethod } from '../../../js/managed/dex/lifter.js';
import { dexMethod } from '../fixtures/medium-dex.mjs';
const first=(words,options)=>liftDexMethod(0,dexMethod(words,options)).bundles[0];
test('#5123: out-of-file register operands cannot have exact effects',()=>{
  for(const words of [[0x1f12,0x000e],[0xf101,0x000e],[0x010f],[0x0027],[0x0152,0,0x000e]]){
    const b=first(words,{registers:words[0]===0x0027?0:1});
    assert.notEqual(b.completeness,'exact');assert.equal(b.locationWrites.length,0);assert.equal(b.memoryEffects.length,0);
  }
});
test('#5123: both halves of a wide register must fit',()=>{
  assert.notEqual(first([0x0016,1,0x000e],{registers:1}).completeness,'exact');
  assert.equal(first([0x0016,1,0x000e],{registers:2}).completeness,'exact');
});
test('#5123: explicit invocation register words obey registers_size',()=>{
  const image=dexMethod([0x1071,1,0x000f,0x000e],{registers:1,methods:[{name:'m',classType:'LTest;',proto:{returnType:'V',params:[]}},{name:'target',classType:'LTest;',proto:{returnType:'V',params:['I']}}]});
  const b=liftDexMethod(0,image).bundles[0];assert.notEqual(b.completeness,'exact');assert.equal(b.callEffects.length,0);
});
