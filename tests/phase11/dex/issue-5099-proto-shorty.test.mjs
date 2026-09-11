import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseDex } from '../../../js/managed/dex/parser.js';
import { buildDex } from '../fixtures/medium-dex.mjs';
const fixture=(shorty,returnType='I',params=[])=>buildDex({methods:[{classType:'LTest;',name:'foo',returnType,params,shorty,flags:0x109,words:null}]}).bytes;
test('#5099: shorty must equal the resolved return/parameter signature',()=>{
  for(const shorty of ['V','II','','IL'])assert.throws(()=>parseDex(fixture(shorty)),/proto-shorty/);
  assert.doesNotThrow(()=>parseDex(fixture('I')));
});
test('#5099: references and arrays use L, primitives preserve their descriptor',()=>{
  const params=['I','[J','Ljava/lang/String;'];
  assert.doesNotThrow(()=>parseDex(fixture('VILL','V',params)));
  for(const s of ['VII','VIIL','VILLI'])assert.throws(()=>parseDex(fixture(s,'V',params)),/proto-shorty/);
});
