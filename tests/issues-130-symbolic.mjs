import assert from 'node:assert/strict';
import { buildSemanticModel } from '../js/blocks.js';
import { irFor, OP } from '../js/ir.js';
import { symbolicExecute } from '../js/symbolic/executor.js';

const BASE=0x100000000n;
function modelOf(lines){
  const rows=lines.map((line,i)=>{const p=line.indexOf(' ');return {row:i,address:BASE+BigInt(i*4),mn:p<0?line:line.slice(0,p),ops:p<0?'':line.slice(p+1)}});
  const rowOfAddress=(addr)=>{const d=addr-BASE;return d>=0n&&d<BigInt(lines.length*4)?Number(d/4n):null};
  return buildSemanticModel(rows,{startRow:0,endRow:rows.length-1,rowOfAddress});
}

const model=modelOf(['ldr w8, [x0, #0x20]','str w1, [x0, #0x20]','add w0, w8, #1','ret']);
const ir=irFor(model), ret=ir.instructions.find((i)=>i.op===OP.RET);
assert.equal(ret.args?.length||0,0,'RET remains ABI-unknown');
const path=symbolicExecute(ir,{timeoutMs:1000}).paths.find((p)=>p.status==='complete');
assert.ok(path); assert.match(path.returnText,/field\(/); assert.equal(path.returnInferred,true);

const ambiguous=symbolicExecute(irFor(modelOf(['mov x0, #7','ret'])),{timeoutMs:1000}).paths.find((p)=>p.status==='complete');
assert.ok(ambiguous); assert.equal(ambiguous.returnValue,null); assert.equal(ambiguous.returnText,'?'); assert.equal(ambiguous.returnInferred,false);

const argValue=(id,reg,bits=64)=>({id,reg,bits,kind:'arg',const:null,def:null,uses:[]});
const constantValue=(id,value)=>({id,reg:null,bits:64,kind:'const',const:BigInt(value),def:null,uses:[]});
const compareValue=(id,reg,left,right,row,bits=64)=>{
  const dst={id:id+'-value',reg,bits,kind:'def',const:null,def:null,uses:[]};
  const inst={id,op:OP.CMP,sub:'sub',row,address:0x2000n+BigInt(row*4),block:0,args:[{value:left,bits:left.bits},{value:right,bits:right.bits}],dst};
  dst.def=inst;
  return {inst,dst};
};

// A compare-defined data arm must not become the SEL condition carrier. The
// canonical carrier is args[2], after the two selected values.
{
  const left=argValue('sel-left','x0');
  const right=argValue('sel-right','x1');
  const conditionLeft=argValue('condition-left','x2');
  const conditionRight=argValue('condition-right','x3');
  const wrong=compareValue('data-cmp','x8',left,right,0);
  const correct=compareValue('condition-cmp','nzcv',conditionLeft,conditionRight,1,4);
  const one=constantValue('sel-one',1n);
  const dst={id:'sel-dst',reg:'x0',bits:64,kind:'def',const:null,def:null,uses:[]};
  const sel={id:'sel',op:OP.SEL,sub:'sel',cond:'eq',row:2,address:0x2008n,block:0,
    args:[{value:wrong.dst,bits:64},{value:one,bits:64},{value:correct.dst,bits:4}],dst};
  dst.def=sel;
  const ret={id:'sel-ret',op:OP.RET,row:3,address:0x200cn,block:0,args:[]};
  const instructions=[wrong.inst,correct.inst,sel,ret];
  const selectionIR={entry:0,instructions,values:[left,right,conditionLeft,conditionRight,wrong.dst,correct.dst,one,dst],
    blocks:[{index:0,idom:-1,insts:instructions,succ:[]}],args:new Map()};
  const result=symbolicExecute(selectionIR,{timeoutMs:1000}).paths.find((p)=>p.status==='complete');
  assert.ok(result);
  assert.equal(result.returnValue.condition.args[0].name,'arg2');
  assert.equal(result.returnValue.condition.args[1].name,'arg3');
  assert.doesNotMatch(result.returnText,/arg0 == arg1/);
}

// Conditional branches keep their canonical flags carrier at the last
// argument. Current builders emit one carrier, so this is also args[0].
{
  const left=argValue('branch-left','x4');
  const right=argValue('branch-right','x5');
  const comparison=compareValue('branch-cmp','nzcv',left,right,0,4);
  const branch={id:'branch',op:OP.CBR,cond:'eq',row:1,address:0x3004n,block:0,
    args:[{value:comparison.dst,bits:4}],extra:{kind:'cond',target:0x4000n}};
  const taken={id:'taken-ret',op:OP.RET,row:2,address:0x4000n,block:1,args:[]};
  const fallthrough={id:'fallthrough-ret',op:OP.RET,row:3,address:0x5000n,block:2,args:[]};
  const instructions=[comparison.inst,branch,taken,fallthrough];
  const branchIR={entry:0,instructions,values:[left,right,comparison.dst],blocks:[
    {index:0,idom:-1,insts:[comparison.inst,branch],succ:[1,2]},
    {index:1,idom:0,insts:[taken],succ:[]},
    {index:2,idom:0,insts:[fallthrough],succ:[]},
  ],args:new Map()};
  const paths=symbolicExecute(branchIR,{timeoutMs:1000}).paths.filter((p)=>p.status==='complete');
  assert.equal(paths.length,2);
  assert.deepEqual(paths.map((p)=>p.constraintText[0]).sort(),['i64(arg4 != arg5)','i64(arg4 == arg5)']);
}

// A data CMP before the CBR carrier must not hijack the condition. The
// positional CBR contract uses the final argument, even when a multi-arg
// compatibility fixture contains a compare-defined data value first.
{
  const dataLeft=argValue('branch-data-left','x0');
  const dataRight=argValue('branch-data-right','x1');
  const conditionLeft=argValue('branch-condition-left','x2');
  const conditionRight=argValue('branch-condition-right','x3');
  const wrong=compareValue('branch-data-cmp','x8',dataLeft,dataRight,0);
  const correct=compareValue('branch-condition-cmp','nzcv',conditionLeft,conditionRight,1,4);
  const branch={id:'branch-with-data-decoy',op:OP.CBR,cond:'eq',row:2,address:0x5008n,block:0,
    args:[{value:wrong.dst,bits:64},{value:correct.dst,bits:4}],extra:{kind:'cond',target:0x6000n}};
  const taken={id:'decoy-taken-ret',op:OP.RET,row:3,address:0x6000n,block:1,args:[]};
  const fallthrough={id:'decoy-fallthrough-ret',op:OP.RET,row:4,address:0x7000n,block:2,args:[]};
  const instructions=[wrong.inst,correct.inst,branch,taken,fallthrough];
  const branchIR={entry:0,instructions,values:[dataLeft,dataRight,conditionLeft,conditionRight,wrong.dst,correct.dst],blocks:[
    {index:0,idom:-1,insts:[wrong.inst,correct.inst,branch],succ:[1,2]},
    {index:1,idom:0,insts:[taken],succ:[]},
    {index:2,idom:0,insts:[fallthrough],succ:[]},
  ],args:new Map()};
  const paths=symbolicExecute(branchIR,{timeoutMs:1000}).paths.filter((p)=>p.status==='complete');
  assert.equal(paths.length,2);
  assert.deepEqual(paths.map((p)=>p.constraintText[0]).sort(),['i64(arg2 != arg3)','i64(arg2 == arg3)']);
}

console.log('issue-130 symbolic compatibility: ok');
