import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseDex } from '../../../js/managed/dex/parser.js';
import { buildDex } from '../fixtures/medium-dex.mjs';
test('#5074: string references cannot point into the file header',()=>{
  const {bytes,layout}=buildDex(); const v=new DataView(bytes.buffer);
  bytes.set([1,0x56,0],12);v.setUint32(layout.strings+layout.stringsList.indexOf('V')*4,12,true);
  assert.throws(()=>parseDex(bytes),/data.*(?:range|section|outside)|string-data-offset/);
});
test('#5074: class_data cannot be borrowed from header bytes',()=>{
  const {bytes,layout}=buildDex();const v=new DataView(bytes.buffer);
  bytes.set([0,0,0,0],12);v.setUint32(layout.classes+24,12,true);
  assert.throws(()=>parseDex(bytes),/data.*(?:range|section|outside)|class-data-offset/);
});
test('#5074: code references require a whole data-owned header',()=>{
  const {bytes,layout}=buildDex(); const p=layout.classData[0];
  bytes[p+8]=4; bytes[p+9]=0;
  assert.throws(()=>parseDex(bytes),/code.*(?:offset|range)|data.*(?:range|section|outside)/);
});
test('#5074: normally owned strings/classes/code remain readable',()=>assert.doesNotThrow(()=>parseDex(buildDex().bytes)));
test('#5074: parsed data ownership remains explicit for downstream decoding',()=>{
  const {bytes,layout}=buildDex();const image=parseDex(bytes),v=new DataView(bytes.buffer);
  assert.deepEqual(image.dataSection,{offset:v.getUint32(108,true),size:v.getUint32(104,true)});
  assert.ok(Object.isFrozen(image.dataSection));
});
