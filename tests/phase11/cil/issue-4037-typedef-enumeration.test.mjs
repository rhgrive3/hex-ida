import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCil } from '../../../js/managed/cil/parser.js';
import { CilFrontend } from '../../../js/managed/cil/frontend.js';
import { buildCil, collect } from '../fixtures/medium-cil.mjs';
test('#4037: actual TypeDef names/namespaces and row ownership survive enumeration',async()=>{
  const image=parseCil(buildCil({types:[{name:'One',namespace:'A',methodList:1,fieldList:1},{name:'Two',namespace:'B',methodList:2,fieldList:2}],methods:[{name:'First',body:[0x2a]},{name:'Second',body:[0x2a]}],fields:[{name:'X'},{name:'Y'}]}).bytes);
  const frontend=new CilFrontend(),types=await collect(frontend.enumerateTypes(image)),methods=await collect(frontend.enumerateMethods(image));
  assert.deepEqual(types.map(t=>[t.name,t.namespace]),[['One','A'],['Two','B']]);
  assert.deepEqual(types.map(t=>t.token),['0x02000001','0x02000002']);
  assert.equal(methods[0].declaringTypeId,types[0].id);assert.equal(methods[1].declaringTypeId,types[1].id);
  assert.deepEqual(image.types.map(t=>t.fieldTokens),[['0x04000001'],['0x04000002']]);
});
test('#4037: an empty TypeDef table never invents MainType',async()=>{
  const image=parseCil(buildCil({types:[],methods:[]}).bytes);
  assert.deepEqual(await collect(new CilFrontend().enumerateTypes(image)),[]);
});
test('#4037: uncompressed MethodPtr order resolves real method ownership',async()=>{
  const image=parseCil(buildCil({tableName:'#-',types:[{name:'A',methodList:1},{name:'B',methodList:2}],methods:[{name:'M1',body:[0x2a]},{name:'M2',body:[0x2a]}],extraRows:new Map([[5,{count:2,bytes:Uint8Array.of(2,0,1,0)}]])}).bytes);
  assert.deepEqual(image.types.map(t=>t.methodTokens),[['0x06000002'],['0x06000001']]);
});
test('#4037: base-type tokens and metadata immutability are retained',async()=>{
  const image=parseCil(buildCil({types:[{name:'Base',methodList:1},{name:'Child',methodList:1,extends:4}]}).bytes);
  assert.equal(image.types[1].extendsToken,'0x02000001');
  assert.ok(Object.isFrozen(image.types[1]));assert.ok(Object.isFrozen(image.types[1].methodTokens));
  assert.throws(()=>parseCil(buildCil({types:[{name:'Bad',extends:12}]}).bytes),/cil-unsupported-binary/);
});
