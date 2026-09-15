import test from 'node:test';
import assert from 'node:assert/strict';
import { symbolicExecute } from '../../../js/symbolic/executor.js';
import { OP, MK } from '../../../js/ir.js';
export const identity = Object.freeze({queryId:'q002',snapshotId:'snapshot-1',binaryId:'binary-1',functionId:'f1',architecture:'generic',addressSpace:'data',semanticsVersion:'2.0.0'});
export function fixture(endian='little') {
  const loc=(address,size)=>({kind:MK.GLOBAL,address,size,key:`global:${address}:size:${size}`});
  const a={id:'a',const:0x11223344n,bits:32};
  const b={id:'b',const:0xaan,bits:8};
  const dst={id:'loaded',bits:32};
  const insts=[
    {id:'s0',op:OP.STORE,loc:loc(0x100n,4),args:[{value:a}],row:0},
    {id:'s1',op:OP.STORE,loc:loc(0x101n,1),args:[{value:b}],row:1},
    {id:'l0',op:OP.LOAD,loc:loc(0x100n,4),args:[],dst,row:2},
    {id:'r0',op:OP.RET,args:[{value:dst}],row:3},
  ]; dst.def=insts[2];
  return {ir:{entry:0,blocks:[{index:0,insts,succ:[]}],instructions:insts},options:{byteMemory:{identity,addressBits:64,endian}}};
}
test('T033 first counterexample: production executor observes a one-byte overwrite',()=>{
  const {ir,options}=fixture(); const r=symbolicExecute(ir,options);
  assert.equal(r.paths[0]?.returnValue?.value,0x1122aa44n);
});
