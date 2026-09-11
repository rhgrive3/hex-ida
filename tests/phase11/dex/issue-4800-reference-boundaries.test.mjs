import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liftDexMethod } from '../../../js/managed/dex/lifter.js';
import { DexFrontend } from '../../../js/managed/dex/frontend.js';
import { dexMethod } from '../fixtures/medium-dex.mjs';
test('#4800: invalid string/type/field/method operands keep no invented effects', async()=>{
  for(const op of [0x1a,0x22,0x52,0x59,0x71]){
    const words=[op,1,...(op===0x71?[0]:[]),0x000e];const image=dexMethod(words);
    const b=liftDexMethod(0,image).bundles[0];
    assert.notEqual(b.completeness,'exact');
    for(const field of ['producedValues','locationWrites','memoryEffects','callEffects'])assert.deepEqual(b[field],[]);
    const frontend=new DexFrontend();const decoded=await frontend.decodeMethod({methodIdx:0},{image});
    const report=await frontend.validateMethod(decoded,{image});assert.equal(report.status,'invalid');
  }
});
test('#4800: valid final table indexes and an actual empty string are preserved',()=>{
  const image=dexMethod([0x001a,0,0x000e]);const b=liftDexMethod(0,image).bundles[0];
  assert.equal(b.completeness,'exact');assert.equal(b.producedValues[0].stringRef,'');
});
