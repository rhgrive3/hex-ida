import test from 'node:test';
import assert from 'node:assert/strict';
import { symbolicExecute, expr, queryTaint, createTaintModels } from '../../../js/symbolic/index.js';
import { OP, MK } from '../../../js/ir-base.js';
import { identity } from '../taint/fixtures.mjs';
// Oracle arithmetic below uses only integer arithmetic, not the production
// translator, folding, bitvector helpers or memory helpers. evaluateExpr is DUT.
const modulo = (x, width) => { const m=2n**BigInt(width); return ((x%m)+m)%m; };
const signed = (x, width) => x>=2n**BigInt(width-1) ? x-2n**BigInt(width) : x;
function scalar(op, sub, width, outputWidth=width, extra={}) {
  const inputs=[0,1].map(index=>({id:`a${index}`,bits:width,kind:'arg',reg:`x${index}`,index}));
  const value={id:'result',bits:outputWidth};
  const inst={id:'operation',op,sub,args:inputs.slice(0,op===OP.UN||op===OP.MOV?1:2).map(value=>({value})),dst:value,row:0,address:0n,...extra};
  value.def=inst;
  const ret={id:'ret',op:OP.RET,args:[{value}],row:1,address:4n};
  const ir={entry:0,blocks:[{index:0,insts:[inst,ret],succ:[]}],instructions:[inst,ret]};
  const result=symbolicExecute(ir,{byteMemory:{identity}});
  assert.equal(result.status,'complete',`${op}/${sub}/${width}: ${result.reason}`);
  return result.paths[0].returnValue;
}
function binary(operation,a,b,w) {
  const sa=signed(a,w),sb=signed(b,w),mask=2n**BigInt(w)-1n;
  switch(operation) {
    case 'add':return modulo(a+b,w);case 'sub':return modulo(a-b,w);case 'mul':return modulo(a*b,w);
    case 'and':return a&b;case 'or':return a|b;case 'xor':return a^b;
    case 'shl':return b>=BigInt(w)?0n:modulo(a*(2n**b),w);
    case 'lshr':return b>=BigInt(w)?0n:a/(2n**b);
    case 'ashr':return b>=BigInt(w)?(sa<0n?mask:0n):modulo(sa>>b,w);
    case 'udiv':return b===0n?mask:a/b;case 'urem':return b===0n?a:a%b;
    case 'sdiv':return b===0n?(sa<0n?1n:mask):modulo(sa/sb,w);
    case 'srem':return b===0n?a:modulo(sa%sb,w);
    default:throw Error('oracle operation');
  }
}
function actual(expression,a,b=0n) {
  const result=expr.evaluateExpr(expression,{arg_x0:a,arg_x1:b});
  assert.equal(result.status,'value',result.reason);return result.value;
}
test('independent exhaustive small-domain arithmetic oracle covers 4420 production observations',()=>{
  let count=0;
  for(const w of [1,2,3,4]) for(const op of ['add','sub','mul','and','or','xor','shl','lshr','ashr','udiv','urem','sdiv','srem']) {
    const expression=scalar(OP.BIN,op,w);
    for(let a=0n;a<2n**BigInt(w);a++) for(let b=0n;b<2n**BigInt(w);b++) {
      assert.equal(actual(expression,a,b),binary(op,a,b,w),`${op}/${w}/${a}/${b}`);count++;
    }
  }
  assert.equal(count,4420);
});
test('independent signed and unsigned comparison oracle covers 3400 production observations',()=>{
  let count=0;
  for(const w of [1,2,3,4]) for(const cond of ['eq','ne','lt','le','gt','ge']) for(const isSigned of (['eq','ne'].includes(cond)?[false]:[false,true])) {
    const expression=scalar(OP.CMP,cond,w,1,{cond,signed:isSigned});
    for(let a=0n;a<2n**BigInt(w);a++) for(let b=0n;b<2n**BigInt(w);b++) {
      const x=isSigned?signed(a,w):a,y=isSigned?signed(b,w):b;
      const expected=({eq:x===y,ne:x!==y,lt:x<y,le:x<=y,gt:x>y,ge:x>=y})[cond];
      assert.equal(actual(expression,a,b),expected,`${cond}/${isSigned}/${w}/${a}/${b}`);count++;
    }
  }
  assert.equal(count,3400);
});
test('independent casts and unary oracle covers all small values plus 32/64-bit boundary values',()=>{
  let count=0;
  for(const w of [1,2,3,4,8,16,32,64]) {
    const values=w<=4?Array.from({length:2**w},(_,n)=>BigInt(n)):[0n,1n,2n**BigInt(w-1)-1n,2n**BigInt(w-1),2n**BigInt(w)-1n];
    for(const op of ['not','neg']) {
      const expression=scalar(OP.UN,op,w);
      for(const n of values){assert.equal(actual(expression,n),modulo(op==='not'?-n-1n:-n,w));count++;}
    }
    for(const target of [1,2,3,4,8,16,32,64].filter(target=>target!==w)) for(const op of (target<w?['trunc']:['zext','sext'])) {
      const expression=scalar(OP.MOV,op,w,target);
      for(const n of values){assert.equal(actual(expression,n),modulo(op==='sext'?signed(n,w):n,target));count++;}
    }
  }
  assert.equal(count,622);
});
test('loop-carried PHIs execute every iteration and final memory/taint retain the correct path',()=>{
  for(const start of [0n,1n,2n]) {
    const input={id:'driver',kind:'arg',index:0,reg:'x0',bits:8},n={id:'n',bits:8},next={id:'next',bits:8};
    const phi={id:'phi',op:OP.PHI,args:[],incoming:[{from:-1,value:input},{from:1,value:next}],dst:n};n.def=phi;
    const store={id:'store',op:OP.STORE,args:[{value:n}],loc:{kind:MK.GLOBAL,address:0n,size:1},row:0,address:0n};
    const branch={id:'test',op:OP.CBR,args:[{value:n}],extra:{kind:'cbnz',target:8n},row:1,address:4n};
    const sub={id:'decrement',op:OP.BIN,sub:'sub',args:[{value:n},{value:{id:'one',bits:8,const:1n}}],dst:next,row:2,address:8n};next.def=sub;
    const back={id:'back',op:OP.BR,args:[],extra:{target:0n},row:3,address:12n};
    const ret={id:'ret',op:OP.RET,args:[{value:n}],row:4,address:16n};
    const ir={entry:0,blocks:[{index:0,phis:[phi],insts:[store,branch],succ:[1,2]},{index:1,insts:[sub,back],succ:[0]},{index:2,insts:[ret],succ:[]}],instructions:[phi,store,branch,sub,back,ret]};
    const models=createTaintModels({id:'loop',version:'1',provenance:'independent-countdown',sources:[{id:'input',valueId:'driver'}],memorySinks:[{id:'out',observationId:'byte'}]});
    const result=queryTaint(ir,{identity,models,execution:{symbolicArgs:{0:start}},memoryObservations:[{id:'byte',address:0n,size:1}]});
    assert.equal(result.status,'complete',result.reason);assert.equal(result.execution.paths[0].returnValue.value,0n);
    assert.equal(result.execution.paths[0].memoryObservations[0].expression.value,0n);
    assert.deepEqual(result.sinks[0].taint.sources,['input']);
  }
});
