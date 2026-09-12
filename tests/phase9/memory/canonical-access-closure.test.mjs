import test from 'node:test';
import assert from 'node:assert/strict';
import { machineIR, identity } from './main-fixtures.mjs';
import { symbolicExecute, queryTaint, createTaintModels, semanticValueIdentity, expr } from '../../../js/symbolic/index.js';
import * as S from '../../../js/symbolic/index.js';
import { OP } from '../../../js/ir-base.js';
const config = { identity: { ...identity, architecture: 'arm64', addressSpace: 'memory' }, addressBits:64,
  wrapping:'modular', accessSemantics:'canonical-normal-completion' };
const make = () => machineIR(['strb w1, [x0]', 'ldrsb x2, [x0]', 'ret']);
const scopeFor = ir => ({...config.identity,...(S.projectedMemoryAccessContext?.(ir) ?? {})});
function resultOf(ir, configExtra={}) { return symbolicExecute(ir, {byteMemory:{...config,identity:scopeFor(ir),...configExtra}, captureValues:true, symbolicArgs:{0:256n,1:128n}}); }

test('real producer ordinary-access authority reaches the byte executor without inventing qualifiers', () => {
  const ir=make();const r=resultOf(ir);
  assert.equal(r.status,'complete',r.reason);
  const loaded=ir.instructions.find(i=>i.extra?.stateWrite && i.dst?.reg==='x2')?.dst;
  assert.ok(loaded);
  const value=r.paths[0].snapshot.values.find(v=>v.valueId===semanticValueIdentity(loaded));
  assert.equal(expr.evaluateExpr(value.expression).value,0xffffffffffffff80n);
  assert.ok(r.assumptions.some(a=>a.kind==='normal-memory-completion'));
});
test('actual machine source through byte store/load reaches a taint sink with provenance', () => {
  const ir=make(),input=ir.values.find(v=>v.kind==='arg'&&v.reg==='x1');
  const output=ir.instructions.find(i=>i.extra?.stateWrite && i.dst?.reg==='x2')?.dst;
  assert.ok(input&&output);
  const models=createTaintModels({id:'canonical-access',version:'1',provenance:'machine-producer',sources:[{id:'input',valueId:semanticValueIdentity(input)}],sinks:[{id:'output',valueId:semanticValueIdentity(output)}]});
  const r=queryTaint(ir,{identity:scopeFor(ir),models,memory:config,execution:{symbolicArgs:{0:256n}}});
  assert.equal(r.status,'complete',r.reason);
  assert.deepEqual(r.sinks[0].taint.sources,['input']);
  assert.ok(r.evidence);
});
test('unknown qualifiers without a producer capability still reject, and old default stays conservative', () => {
  const ir=make();assert.equal(resultOf(ir,{accessSemantics:undefined}).status,'partial');
  const copyData=(v,seen=new Map())=>{
    if(v==null||typeof v!=='object')return typeof v==='function'?undefined:v;
    if(seen.has(v))return seen.get(v);
    if(v instanceof Map)return new Map();if(v instanceof Set)return new Set();
    const out=Array.isArray(v)?[]:{};seen.set(v,out);
    for(const [k,x]of Object.entries(v))if(typeof x!=='function')out[k]=copyData(x,seen);
    return out;
  };
  const copy=copyData(ir);
  const r=resultOf(copy);assert.equal(r.status,'partial');assert.equal(r.paths.length,0);
});
test('explicit atomic/volatile/ordering and descriptor mutations are never redeemed by old authority', () => {
  for(const [field,v] of [['volatility',true],['atomic',true],['ordering','acquire'],['widthBits',16],['addressSpace','other']]) {
    const ir=make(),load=ir.instructions.find(i=>i.op===OP.LOAD);
    load.extra.memoryAccess={...load.extra.memoryAccess,[field]:v};
    const r=resultOf(ir);assert.equal(r.status,'partial',field);assert.equal(r.paths.length,0);
  }
});
test('unknown calls, acquire/release memory and wrong architecture never use ordinary-memory authority', () => {
  for(const lines of [['strb w1,[x0]','bl 0x2000','ldrsb x2,[x0]','ret'],['ldarb w2,[x0]','ret']]) {
    const r=resultOf(machineIR(lines));assert.equal(r.status,'partial');assert.equal(r.paths.length,0);
  }
  assert.equal(resultOf(make(),{identity:{...config.identity,architecture:'x86_64'}}).status,'partial');
});
