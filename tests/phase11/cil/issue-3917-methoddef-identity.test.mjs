import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCil } from '../../../js/managed/cil/parser.js';
import { CilFrontend } from '../../../js/managed/cil/frontend.js';
import { liftCilMethod } from '../../../js/managed/cil/lifter.js';
import { buildCil, collect } from '../fixtures/medium-cil.mjs';
test('#3917: bodyless rows preserve their own token and the next body token', async () => {
  const image = parseCil(buildCil({ methods: [{name:'Abstract',body:null},{name:'Run',body:[0x2a]}] }).bytes);
  const frontend = new CilFrontend(), methods = await collect(frontend.enumerateMethods(image));
  assert.deepEqual(methods.map(m=>m.token), ['0x06000001','0x06000002']);
  assert.equal(methods[0].bodyIndex, null); assert.equal(methods[1].bodyIndex,0);
  const decoded = await frontend.decodeMethod(methods[1], {image});
  assert.equal(decoded.methodId, methods[1].id);
  assert.notEqual((await frontend.decodeMethod(methods[0], {image})).aggregateCompleteness,'exact');
});
test('#3917: distinct definitions sharing an RVA retain two method identities', async () => {
  const image = parseCil(buildCil({methods:[{name:'A',body:[0x2a]},{name:'B',body:[0x2a],shareWith:0}]}).bytes);
  const methods = await collect(new CilFrontend().enumerateMethods(image));
  assert.equal(methods.length,2); assert.notEqual(methods[0].id,methods[1].id);
  assert.equal(image.methodBodies[0].codeOffset,image.methodBodies[1].codeOffset);
  assert.notEqual(liftCilMethod(0,image).methodId,liftCilMethod(1,image).methodId);
});
test('#3917: row sixteen uses an eight-digit MethodDef token',async()=>{
  const image = parseCil(buildCil({methods:Array.from({length:16},(_,i)=>({name:`M${i}`,body:[0x2a]}))}).bytes);
  const methods = await collect(new CilFrontend().enumerateMethods(image));
  assert.equal(methods[15].token,'0x06000010');assert.equal(liftCilMethod(15,image).methodId,methods[15].id);
});
