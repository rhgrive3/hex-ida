import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseDex } from '../../../js/managed/dex/parser.js';
import { captureDexValidationMetadata } from '../../../js/managed/dex/validation.js';
import { buildDex, dexMethod } from '../fixtures/medium-dex.mjs';

test('#5642: referenced ULEB string length cannot wrap above uint32', () => {
  for (const high of [0x10,0x20,0x40,0x7f]) {
    const {bytes,layout}=buildDex({strings:['unused']}); const view=new DataView(bytes.buffer);
    bytes.set([0x80,0x80,0x80,0x80,high,0],layout.stringDataEnd);
    view.setUint32(layout.strings+layout.stringsList.indexOf('unused')*4,layout.stringDataEnd,true);
    assert.throws(()=>parseDex(bytes),/uleb128/, `fifth payload ${high}`);
  }
});
test('#5642: validation must reject overflowing handler addresses and signed sizes',()=>{
  for(const handler of [ [1,1,0,0x80,0x80,0x80,0x80,0x10], [1,0x80,0x80,0x80,0x80,0x10,1] ]) {
    const image=dexMethod([0x000e,0x000e],{tries:[{start:0,count:1,handlerOff:1}],handlers:handler});
    assert.equal(captureDexValidationMetadata(0,image).exceptionComplete,false);
  }
});
test('#5642: ordinary ULEB and signed catch-all records remain readable',()=>{
  assert.doesNotThrow(()=>parseDex(buildDex().bytes));
  const image=dexMethod([0x000e,0x000e],{tries:[{start:0,count:1,handlerOff:1}],handlers:[1,0,1]});
  assert.equal(captureDexValidationMetadata(0,image).exceptionComplete,true);
});
