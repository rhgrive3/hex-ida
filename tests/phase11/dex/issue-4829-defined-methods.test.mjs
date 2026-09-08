import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DexFrontend } from '../../../js/managed/dex/frontend.js';
import { liftDexMethod } from '../../../js/managed/dex/lifter.js';
import { parseDex } from '../../../js/managed/dex/parser.js';
import { buildDex, dexMethod } from '../fixtures/medium-dex.mjs';
test('#4829: enumerate definitions, not every method reference', async()=>{
  const image=parseDex(buildDex({methods:[{classType:'LTest;',name:'external',returnType:'V',words:null,defined:false},{classType:'LTest;',name:'local',returnType:'V',words:[0x000e],flags:9}]}).bytes);
  const methods=[]; for await (const method of new DexFrontend().enumerateMethods(image))methods.push(method);
  assert.deepEqual(methods.map(m=>m.methodIdx),[1]);
  const fx=liftDexMethod(1,image); assert.equal(fx.aggregateCompleteness,'exact');
});
test('#4829: a direct external lookup cannot become a pure abstract return',()=>{
  const image=dexMethod([0x000e],{classes:[]});
  const fx=liftDexMethod(0,image);
  assert.notEqual(fx.aggregateCompleteness,'exact');
  assert.equal(fx.bundles.flatMap(b=>b.controlEffects).length,0);
});
