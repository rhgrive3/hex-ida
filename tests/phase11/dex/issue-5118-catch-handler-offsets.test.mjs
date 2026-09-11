import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liftDexMethod } from '../../../js/managed/dex/lifter.js';
import { lowerVMEffectsToSemanticIr } from '../../../js/managed/shared/bridge-v2.js';
import { dexMethod } from '../fixtures/medium-dex.mjs';
test('#5118: handler_off resolves the encoded list, not the try end',()=>{
  const image=dexMethod([0x0027,0x000e,0x000e,0x000e],{tries:[{start:0,count:1,handlerOff:1}],handlers:[1,1,0,3]});
  const fx=liftDexMethod(0,image);assert.equal(fx.exceptionRegions[0].handlerOffset,6);
  assert.equal(fx.exceptionRegions[0].catchType,'LTest;');
  const lowered=lowerVMEffectsToSemanticIr(fx);
  assert.ok(lowered.cfg.blocks.find(b=>b.id==='bb_0x0').successors.some(e=>e.kind==='exception'&&e.to==='bb_0x6'));
});
test('#5118: signed count retains typed handlers plus the real catch-all',()=>{
  const image=dexMethod([0x0027,0x000e,0x000e,0x000e],{tries:[{start:0,count:1,handlerOff:1}],handlers:[1,0x7f,0,2,3]});
  const fx=liftDexMethod(0,image);
  assert.deepEqual(fx.exceptionRegions.map(r=>[r.handlerOffset,r.catchType]),[[4,'LTest;'],[6,null]]);
  assert.equal(new Set(fx.exceptionRegions.map(r=>r.id)).size,2);
});
test('#5118: invalid handler offsets/targets do not publish invented edges',()=>{
  for(const [off,addr]of [[0,2],[2,2],[1,4]]){
    const fx=liftDexMethod(0,dexMethod([0x0027,0x000e,0x000e],{tries:[{start:0,count:1,handlerOff:off}],handlers:[1,1,0,addr]}));
    assert.notEqual(fx.aggregateCompleteness,'exact');assert.deepEqual(fx.exceptionRegions,[]);
  }
});
test('#5118: a protected range starting inside a basic block gets its own exception edge',()=>{
  const fx=liftDexMethod(0,dexMethod([0x0000,0x0027,0x000e,0x000e],{tries:[{start:1,count:1,handlerOff:1}],handlers:[1,0,3]}));
  const cfg=lowerVMEffectsToSemanticIr(fx).cfg;
  assert.ok(cfg.blocks.find(b=>b.id==='bb_0x2')?.successors.some(e=>e.kind==='exception'&&e.to==='bb_0x6'));
  assert.ok(!cfg.blocks.find(b=>b.id==='bb_0x0').successors.some(e=>e.kind==='exception'));
});
