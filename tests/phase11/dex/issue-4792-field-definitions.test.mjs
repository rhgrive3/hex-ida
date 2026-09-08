import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseDex } from '../../../js/managed/dex/parser.js';
import { buildDex } from '../fixtures/medium-dex.mjs';
test('#4792: keep independent static/instance field deltas and flags',()=>{
  const image=parseDex(buildDex({fields:[{classType:'LTest;',type:'I',name:'a',flags:0x19},{classType:'LTest;',type:'I',name:'b',static:false,flags:2}]}).bytes);
  assert.deepEqual(image.classes[0].staticFields,[{fieldIdx:0,accessFlags:0x19}]);
  assert.deepEqual(image.classes[0].instanceFields,[{fieldIdx:1,accessFlags:2}]);
  assert.ok(Object.isFrozen(image.classes[0].staticFields));
});
test('#4792: a definition cannot borrow another class field',()=>{
  const {bytes}=buildDex({classNames:['LOther;','LTest;'],fields:[{classType:'LOther;',type:'I',name:'x',owner:'LTest;'}]});
  assert.throws(()=>parseDex(bytes),/field.*owner/);
});
test('#4792: repeated field index is not a second definition',()=>{
  const {bytes,layout}=buildDex({fields:[{classType:'LTest;',type:'I',name:'a'},{classType:'LTest;',type:'I',name:'b'}]});
  bytes[layout.classData[0]+6]=0;
  assert.throws(()=>parseDex(bytes),/field.*order|duplicate/);
});
