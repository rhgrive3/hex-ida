import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCil } from '../../../js/managed/cil/parser.js';
import { buildCil } from '../fixtures/medium-cil.mjs';
test('#4033: duplicate heaps and alternative table streams cannot select a winner',()=>{
  for(const name of ['#Strings','#~','#-']) {
    const fixture=buildCil({extraStreams:[{name,bytes:new Uint8Array(4)}]});
    assert.throws(()=>parseCil(fixture.bytes),/cil-unsupported-binary/);
  }
});
test('#4033: names are bounded NUL-terminated ASCII and sizes are aligned',()=>{
  for(const stream of [{name:'x'.repeat(33),bytes:new Uint8Array(4)},{name:Uint8Array.of(0xff),bytes:new Uint8Array(4)},{name:'#Extra',bytes:new Uint8Array(3)}]) {
    assert.throws(()=>parseCil(buildCil({extraStreams:[stream]}).bytes),/cil-unsupported-binary/);
  }
});
test('#4033: distinct valid streams and bounded unknown streams remain accepted',()=>{
  assert.equal(parseCil(buildCil({extraStreams:[{name:'x'.repeat(31),bytes:new Uint8Array(4)}]}).bytes).methodBodies.length,1);
});
