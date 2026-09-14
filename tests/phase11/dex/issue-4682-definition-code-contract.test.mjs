import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseDex } from '../../../js/managed/dex/parser.js';
import { liftDexMethod } from '../../../js/managed/dex/lifter.js';
import { buildDex, dexMethod } from '../fixtures/medium-dex.mjs';
test('#4682: parser rejects body/access-flag contradictions in either direction',()=>{
  for(const m of [{flags:9,words:null},{flags:0x109,words:[0x000e]},{flags:0x401,words:[0x000e]}]) {
    assert.throws(()=>parseDex(buildDex({methods:[{classType:'LTest;',name:'foo',returnType:'V',...m}]}).bytes),/code.*(?:required|forbidden)/);
  }
});
test('#4682: public lifter refuses exact semantics for malformed definitions',()=>{
  for(const [flags,codeOff]of [[9,0],[0x109,4],[0x401,4]]){
    const image=dexMethod();image.classes[0].directMethods[0]={methodIdx:0,accessFlags:flags,codeOff};
    const fx=liftDexMethod(0,image);assert.notEqual(fx.aggregateCompleteness,'exact');
    assert.equal(fx.bundles.flatMap(b=>b.controlEffects).length,0);
  }
});
test('#4682: legal concrete/native/abstract definitions remain distinct',()=>{
  for(const [flags,words]of [[9,[0x000e]],[0x109,null],[0x401,null]])assert.doesNotThrow(()=>parseDex(buildDex({methods:[{classType:'LTest;',name:'foo',returnType:'V',flags,words}]}).bytes));
});
