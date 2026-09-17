import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { symbolicExecute, expr as E } from '../../../js/symbolic/index.js';
import { inspectMemoryExpressions as collectSymbols } from '../../../js/symbolic/memory/expression-contract.js';
import { OP, MK } from '../../../js/ir.js';
import { identity, integrationFixture } from '../taint/fixtures.mjs';

export function memoryFixture({endian='little',partial=false}={}) {
  const loc=(address,size)=>({kind:MK.GLOBAL,address,size,key:`global:${address}:size:${size}`});
  const word={id:'word',const:0x11223344n,bits:32},byte={id:'byte',const:0xaan,bits:8},out={id:'out',bits:32};
  const store={id:'store',op:OP.STORE,loc:loc(0n,4),args:[{value:word}],row:0,address:0n};
  const overwrite={id:'overwrite',op:OP.STORE,loc:loc(1n,1),args:[{value:byte}],row:1,address:4n};
  const load={id:'load',op:OP.LOAD,loc:loc(0n,4),args:[],dst:out,row:2,address:8n};out.def=load;
  const ret={id:'return',op:OP.RET,args:[{value:out}],row:3,address:12n};
  const insts=partial?[store,overwrite,load,ret]:[store,load,ret];
  return {ir:{entry:0,blocks:[{index:0,insts,succ:[]}],instructions:insts},options:{byteMemory:{identity,addressBits:8,endian}}};
}
export function aggregateTrials(trials) {
  const keys=new Set(trials.flatMap(trial=>Object.keys(trial.metrics)));
  return Object.fromEntries([...keys].map(key=>[key,Math.max(...trials.map(trial=>trial.metrics[key]??NaN))]));
}
export function measureMemoryCase(caseId) {
  const started=performance.now(),trials=[];
  const run=(ir,options)=> { const result=symbolicExecute(ir,options);trials.push(result);return result; };
  const {ir,options}=memoryFixture({endian:caseId==='big-endian-full-load'?'big':'little',partial:caseId==='partial-overwrite'});
  if(['little-endian-full-load','big-endian-full-load','partial-overwrite'].includes(caseId)) {
    const r=run(ir,options);assert.equal(r.status,'complete',r.reason);
    assert.equal(r.paths[0].returnValue.value,caseId==='partial-overwrite'?0x1122aa44n:0x11223344n);
  } else if(caseId==='concrete-to-symbolic-escalation') {
    const pointer={id:'pointer',kind:'arg',reg:'x0',index:0,bits:8};
    ir.blocks[0].insts.splice(1,0,{id:'symbolic-store',op:OP.STORE,loc:{kind:MK.UNKNOWN,size:1},addr:{base:pointer,disp:0n,size:1},args:[{value:{id:'new-byte',const:0xaan,bits:8}}]});
    const r=run(ir,options);assert.equal(r.status,'complete',r.reason);
    const expression=r.paths[0].returnValue,symbols=collectSymbols([expression]).symbols;
    assert.equal(symbols.length,1);const pointerSymbol=symbols[0];
    for(const [address,expected] of [[0n,0x112233aan],[1n,0x1122aa44n],[8n,0x11223344n]]) {
      assert.equal(E.evaluateExpr(expression,{[pointerSymbol.symbolId]:address}).value,expected);
    }
  } else if(caseId==='may-alias-fork') {
    const fixture=integrationFixture();
    fixture.blocks[0].insts[1].addr.base={id:'other',kind:'arg',index:3,reg:'x3',bits:8};
    const r=run(fixture,{byteMemory:{identity,addressBits:8,wrapping:'modular'}});
    assert.equal(r.status,'complete',r.reason);assert.equal(r.paths.length,2);assert.ok(r.metrics.aliasForks>0);
  } else if(caseId==='unknown-clobber') {
    ir.blocks[0].insts.splice(1,0,{id:'clobber',op:OP.CLOBBER,args:[]});
    const r=run(ir,options);assert.equal(r.status,'partial');assert.equal(r.paths.length,0);
  } else if(caseId==='volatile-barrier'||caseId==='atomic-barrier') {
    ir.blocks[0].insts[1][caseId==='volatile-barrier'?'volatile':'atomic']=true;
    const r=run(ir,options);assert.equal(r.status,'partial');assert.equal(r.reason,caseId);assert.equal(r.paths.length,0);
  } else if(caseId==='cancel-replay') {
    let checks=0;const stopped=run(ir,{...options,isCancelled:()=>++checks>30});
    assert.equal(stopped.status,'partial');assert.equal(stopped.reason,'cancelled');assert.equal(stopped.paths.length,0);
    const replay=run(ir,options);assert.equal(replay.status,'complete');assert.equal(replay.paths[0].returnValue.value,0x11223344n);
  } else throw new Error(`unimplemented locked case: ${caseId}`);
  const metrics=aggregateTrials(trials);
  metrics.wallClock=performance.now()-started;
  return {caseId,metrics,trials:trials.map(result=>({status:result.status,reason:result.reason,metrics:result.metrics})),assertions:'executed'};
}
