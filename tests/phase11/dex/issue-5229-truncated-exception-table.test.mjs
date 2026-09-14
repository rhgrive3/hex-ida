import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liftDexMethod } from '../../../js/managed/dex/lifter.js';
import { dexMethod } from '../fixtures/medium-dex.mjs';
test('#5229: declared try records and handler lists cannot silently disappear',()=>{
  for(const options of [{triesSize:1},{tries:[{start:0,count:1,handlerOff:1}],handlers:[]},{tries:[{start:0,count:1,handlerOff:1}],handlers:[1,1,0]}]){
    const fx=liftDexMethod(0,dexMethod([0x0027,0x000e],options));
    assert.notEqual(fx.aggregateCompleteness,'exact');assert.deepEqual(fx.exceptionRegions,[]);
    assert.ok(fx.bundles.some(b=>b.unknownEffects.some(e=>/try|handler|exception/.test(e.reason))));
  }
});
test('#5229: zero tries remains a complete ordinary instruction stream',()=>{
  assert.equal(liftDexMethod(0,dexMethod([0x000e])).aggregateCompleteness,'exact');
});
