import { fixture } from './ir-fixtures.mjs';
import { expr,sourceOf } from '../../../js/decompiler/ast/nodes.js';
export const identity=Object.freeze({queryId:'v8-projection',binaryId:'binary',snapshotId:'snapshot',functionId:'function',architecture:'generic',addressSpace:'data',semanticsVersion:'2'});
export function proofFixture(bits=8) {
 const f=fixture('solver_constant');f.block(0);
 const input=f.opaque(bits);input.index=0;input.reg='x0';
 const target=f.binary('xor',input,input,bits);f.ret();
 const ir=f.build();ir.instructions=ir.blocks.flatMap(b=>[...b.phis,...b.insts]);ir.instructions.at(-1).args=[{value:target}];
 const source=sourceOf({row:0,address:0x1000n,ssaDef:target.id,ir:'xor'});
 const arg=expr.variable('a1',bits,false,sourceOf({ssaDef:input.id}));
 const expression=expr.binary('xor',arg,arg,bits,false,source);
 const result={semantic:true,ir,types:null,semanticAst:{values:[{valueId:target.id,expression,source}],stores:[],outputs:[{expression}],conditions:[]},
 cAst:{kind:'CProgram',body:[{kind:'stmt',indent:0,text:'return a1 ^ a1;',semantic:{op:'return',expression},source}]},metrics:{},ctx:{},pseudocode:'return a1 ^ a1;'};
 return {ir,target,input,result,options:{identity,abiId:'generic-v1',memory:{addressBits:8},targets:[target],timeoutMs:1000,backendTier:'tiered'}};
}

// The real representation producer, rather than a manually asserted AST/ID map.
import { enhanceSemanticDecompilation } from '../../../js/decompiler/pipeline.js';
export function projectionFixture(bits=8) {
 const f=fixture('solver_mba');f.block(0);
 const input=f.opaque(bits);input.index=0;input.reg='x0';
 const other=f.opaque(bits);other.index=1;other.reg='x1';
 const left=f.binary('xor',input,other,bits), right=f.binary('xor',other,input,bits);
 const target=f.binary('xor',left,right,bits), output=f.copy(target,bits);f.ret();
 const ir=f.build();ir.instructions=ir.blocks.flatMap(b=>[...b.phis,...b.insts]);
 ir.instructions.forEach((inst,i)=>{inst.address=0x1000n+BigInt(i*4);inst.id=`ir_${i}`;});
 const ret=ir.instructions.at(-1);ret.args=[{value:output}];
 const result=enhanceSemanticDecompilation({semantic:true,ir,types:null,
   lines:[{kind:'stmt',indent:0,text:'return pending;',row:ret.row,addr:ret.address}],metrics:{},ctx:{}},null,
   {phase8PrepareProof:true,decompilerTimeBudgetMs:1000,returnType:`uint${bits}`});
 return {ir,target,input,other,result,options:{identity,abiId:'generic-v1',memory:{addressBits:8},
   targets:[target,output],timeoutMs:1000,backendTier:'tiered',candidateStrategy:'equality-saturation'}};
}
