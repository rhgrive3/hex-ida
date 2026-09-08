import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCil } from '../../../js/managed/cil/parser.js';
import { buildCil } from '../fixtures/medium-cil.mjs';
test('#5121: all present metadata tables after StandAloneSig are bounded',()=>{
  for(const table of [0x12,0x17,0x20,0x23,0x29,0x2a,0x2b,0x2c]) {
    const fixture=buildCil({extraRows:new Map([[table,{count:1,bytes:new Uint8Array(0)}]])});
    assert.throws(()=>parseCil(fixture.bytes),/cil-unsupported-binary/,`table ${table.toString(16)}`);
  }
});
test('#5121: late tables remain validated without any MethodDef rows',()=>{
  const fixture=buildCil({methods:[],extraRows:new Map([[0x20,{count:1,bytes:new Uint8Array(0)}]])});
  assert.throws(()=>parseCil(fixture.bytes),/cil-unsupported-binary/);
});
test('#5121: complete Assembly row does not alter earlier MethodDef extraction',()=>{
  const fixture=buildCil({extraRows:new Map([[0x20,{count:1,bytes:new Uint8Array(22)}]])});
  assert.equal(parseCil(fixture.bytes).methodBodies.length,1);
});
