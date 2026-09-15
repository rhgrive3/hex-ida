import { OP, MK } from '../../../js/ir.js';
export const identity=Object.freeze({queryId:'taint-test',snapshotId:'s1',binaryId:'b1',functionId:'f1',architecture:'generic',addressSpace:'data',semanticsVersion:'2'});
export function scalarFixture() {
  const input={id:'input',kind:'arg',reg:'x0',index:0,bits:8},out={id:'out',bits:8};
  const inst={id:'copy',op:OP.MOV,args:[{value:input}],dst:out,row:0,address:0n};out.def=inst;
  const ret={id:'ret',op:OP.RET,args:[{value:out}],row:1,address:4n};
  return {entry:0,blocks:[{index:0,insts:[inst,ret],succ:[]}],instructions:[inst,ret]};
}
export function integrationFixture() {
  const ptr={id:'ptr',kind:'arg',reg:'x0',index:0,bits:8};
  const word={id:'word',kind:'arg',reg:'x1',index:1,bits:16};
  const byte={id:'byte',kind:'arg',reg:'x2',index:2,bits:8};
  const loaded={id:'loaded',bits:8},yesValue={id:'yes',bits:8},noValue={id:'no',bits:8},final={id:'final',bits:8};
  const loc=size=>({kind:MK.UNKNOWN,size});
  const write={id:'write-word',op:OP.STORE,loc:loc(2),addr:{base:ptr,disp:0n,size:2},args:[{value:word}],row:0,address:0n};
  const partial={id:'write-byte',op:OP.STORE,loc:loc(1),addr:{base:ptr,disp:1n,size:1},args:[{value:byte}],row:1,address:4n};
  const load={id:'read-byte',op:OP.LOAD,loc:loc(1),addr:{base:ptr,disp:1n,size:1},args:[],dst:loaded,row:2,address:8n};loaded.def=load;
  const branch={id:'branch',op:OP.CBR,args:[{value:loaded}],extra:{kind:'cbnz',target:16n},row:3,address:12n};
  const yes={id:'yes-inst',op:OP.MOV,args:[{value:loaded}],dst:yesValue,row:4,address:16n};yesValue.def=yes;
  const no={id:'no-inst',op:OP.MOV,args:[{value:{id:'zero',const:0n,bits:8}}],dst:noValue,row:6,address:24n};noValue.def=no;
  const br1={id:'br1',op:OP.BR,args:[],extra:{target:32n},row:5,address:20n};
  const br2={id:'br2',op:OP.BR,args:[],extra:{target:32n},row:7,address:28n};
  const phi={id:'phi',op:OP.PHI,args:[],incoming:[{from:1,value:yesValue},{from:2,value:noValue}],dst:final};final.def=phi;
  const ret={id:'ret',op:OP.RET,args:[{value:final}],row:8,address:32n};
  return {entry:0,blocks:[
    {index:0,insts:[write,partial,load,branch],succ:[1,2]},
    {index:1,insts:[yes,br1],succ:[3]},
    {index:2,insts:[no,br2],succ:[3]},
    {index:3,phis:[phi],insts:[ret],succ:[]},
  ],instructions:[write,partial,load,branch,yes,br1,no,br2,phi,ret]};
}
