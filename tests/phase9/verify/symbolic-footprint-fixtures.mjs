import { OP, MK } from '../../../js/ir-base.js';
import { expr as E } from '../../../js/symbolic/index.js';
import { identity } from '../memory/main-fixtures.mjs';
export { identity, E };
export const literal = (id,bits,value) => ({id,bits,const:BigInt(value)});
export function argument(id,bits) { return {id,kind:'arg',reg:id,bits}; }
export function store(pointer,value,size=1,displacement=0n) {
  return {op:OP.STORE,loc:{kind:MK.UNKNOWN,size},addr:{base:pointer,disp:displacement,size},args:[{value}]};
}
export function load(pointer,dst,size=1,displacement=0n) {
  const inst={op:OP.LOAD,loc:{kind:MK.UNKNOWN,size},addr:{base:pointer,disp:displacement,size},args:[],dst};dst.def=inst;return inst;
}
export function program(insts,ret=literal('return',8,0)) {
  const instructions=[...insts,{op:OP.RET,args:ret==null?[]:[{value:ret}]}];
  instructions.forEach((inst,index)=>Object.assign(inst,{id:inst.id??`i${index}`,row:index,address:BigInt(index*4)}));
  return {entry:0,instructions,blocks:[{index:0,insts:instructions,succ:[]}]};
}
export function pairedStores(bits=64,swap=false) {
  const make=flipped=>{const p=argument('p',bits),q=argument('q',bits);const writes=[store(p,literal('one',8,1)),store(q,literal('two',8,2))];return {p,q,ir:program(flipped?writes.reverse():writes)};};
  const before=make(false),after=make(swap);
  const p=E.createFreshSymbol(E.bvSort(bits),'witness_input_p'),q=E.createFreshSymbol(E.bvSort(bits),'witness_input_q');
  const inputs=[{before:before.p,after:after.p,expression:p},{before:before.q,after:after.q,expression:q}];
  const memory={addressBits:bits,wrapping:'modular',proofMode:'symbolic-writes'};
  return {before,after,p,q,request:{identity,beforeIr:before.ir,afterIr:after.ir,memory,inputs,preconditions:[],backendTier:'tiered',timeoutMs:2000}};
}
