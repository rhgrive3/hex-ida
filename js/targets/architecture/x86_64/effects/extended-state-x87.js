import { createMemoryAccess } from '../../../../semantics/effects/index.js';
import { createX86EffectContext, x86MemoryFaults, x86RegisterOperand } from './common.js';
import {
  baseFamily, registerName, vexInfo, memoryAddress, possibleFeatureFault,
  trustedCapstoneInstruction, physicalIds,
} from './extended-state-helpers.js';

export function liftVzero(instruction,context,family){
  const ctx=createX86EffectContext(instruction,context),vex=vexInfo(ctx.instruction),raw=Uint8Array.from(ctx.instruction.rawBytes||[]);
  if(!vex||vex.map!==1||vex.pp!==0||vex.vvvv!==15||raw[vex.prefixOffset+vex.prefixLength]!==0x77)return null;
  if(family==='vzeroall'&&vex.width!==256)return null;
  if(family==='vzeroupper'&&vex.width!==128)return null;
  for(let index=0;index<16;index+=1){
    const zmm=x86RegisterOperand(`zmm${index}`);if(!zmm)return ctx.partial('x86-maxvl-register-state-unavailable',['registers']);
    if(family==='vzeroall'){
      if(!ctx.writeRegister(zmm,ctx.constant(512,0n)))return ctx.partial('x86-vzeroall-zmm-write-failed',['registers']);
    }else{
      const old=ctx.readRegister(zmm);if(!old)return ctx.partial('x86-vzeroupper-zmm-read-failed',['registers']);
      const low=ctx.valueOp('extract',[old],128,{lsb:0,widthBits:128,physicalBits:512,physicalId:`zmm${index}`,view:`xmm${index}`});
      if(!ctx.writeRegister(zmm,ctx.coerce(low,128,512,false)))return ctx.partial('x86-vzeroupper-zmm-write-failed',['registers']);
    }
  }
  return ctx.finish({family:'simd',possibleFaults:[possibleFeatureFault('invalid-opcode')],metadata:{operation:family,maxVlBits:512,architecturalRegisterRange:'zmm0-zmm15',low128:family==='vzeroupper'?'preserved':'zero',bits128To511:'zero',extendedVectorStateModeled:true}});
}
export function liftEmms(instruction,context){const ctx=createX86EffectContext(instruction,context),raw=Uint8Array.from(ctx.instruction.rawBytes||[]);if(raw.length<2||raw[raw.length-2]!==0x0f||raw[raw.length-1]!==0x77)return null;const fptw=x86RegisterOperand('fptw');if(!fptw||!ctx.writeRegister(fptw,ctx.constant(16,0xffffn)))return ctx.partial('x86-emms-tag-write-failed',['registers']);return ctx.finish({family:'simd',possibleFaults:[possibleFeatureFault('device-not-available')],metadata:{operation:'emms',x87TagWord:'all-empty',mmxDataPreserved:true,mmxX87AliasModeled:true}});}
const X87_PUSH = new Set(['fld','fld1','fldz','fild']);
const X87_STORE = new Set(['fst','fist']);
const X87_STORE_POP = new Set(['fstp','fistp']);
const X87_ARITH = new Set(['fadd','fiadd','fsub','fisub','fsubr','fmul','fimul','fdiv','fidiv','fdivr']);
const X87_ARITH_POP = new Set(['faddp','fsubp','fsubrp','fmulp','fdivp','fdivrp','fyl2x']);
const X87_COMPARE = new Set(['fcom','fucom']);
const X87_COMPARE_POP = new Set(['fcomp','fucomp','fcompp','fucompp']);
const X87_UNARY = new Set(['fsqrt','frndint','fscale','fprem','fprem1','f2xm1']);
const X87_SIGN = new Set(['fchs','fabs']);

function x87Plan(base,ctx){
  const hasMemory=ctx.operands.some((op)=>op?.type==='memory');
  const pointerWrites=['fop','fip',...(hasMemory?['fdp']:[])];
  if(X87_PUSH.has(base))return{reads:['x87-stack','fpcw','fpsw','fptw'],writes:['x87-stack','fpsw','fptw',...pointerWrites],memory:'read'};
  if(X87_STORE.has(base))return{reads:['x87-stack','fpcw','fpsw','fptw'],writes:['fpsw',...pointerWrites,...(ctx.operands.some((op)=>op?.type==='register'&&/^st\(/.test(registerName(op)))?['x87-stack']:[])],memory:hasMemory?'write':'none'};
  if(X87_STORE_POP.has(base))return{reads:['x87-stack','fpcw','fpsw','fptw'],writes:['x87-stack','fpsw','fptw',...pointerWrites],memory:hasMemory?'write':'none'};
  if(X87_ARITH.has(base))return{reads:['x87-stack','fpcw','fpsw','fptw'],writes:['x87-stack','fpsw',...pointerWrites],memory:hasMemory?'read':'none'};
  if(X87_ARITH_POP.has(base))return{reads:['x87-stack','fpcw','fpsw','fptw'],writes:['x87-stack','fpsw','fptw',...pointerWrites],memory:hasMemory?'read':'none'};
  if(X87_COMPARE.has(base))return{reads:['x87-stack','fpcw','fpsw','fptw'],writes:['fpsw',...pointerWrites],memory:hasMemory?'read':'none'};
  if(X87_COMPARE_POP.has(base))return{reads:['x87-stack','fpcw','fpsw','fptw'],writes:['fpsw','fptw',...pointerWrites],memory:hasMemory?'read':'none'};
  if(base==='fxch')return{reads:['x87-stack','fpsw','fptw'],writes:['x87-stack','fpsw','fop','fip'],memory:'none'};
  if(X87_UNARY.has(base))return{reads:['x87-stack','fpcw','fpsw','fptw'],writes:['x87-stack','fpsw','fop','fip'],memory:'none'};
  if(X87_SIGN.has(base))return{reads:['x87-stack','fpsw','fptw'],writes:['x87-stack','fop','fip'],memory:'none'};
  if(base==='fldcw')return{reads:[],writes:['fpcw'],memory:'read'};
  if(base==='fnstcw')return{reads:['fpcw'],writes:[],memory:'write'};
  if(base==='fnstsw')return{reads:['fpsw'],writes:[],memory:ctx.operands.some((op)=>op?.type==='memory')?'write':'none',explicitRegisterWrite:true};
  if(base==='fwait'||base==='wait')return{reads:['fpcw','fpsw'],writes:[],memory:'none',waitOnly:true};
  return null;
}

export function liftX87(instruction,context,family){
  if(!trustedCapstoneInstruction(instruction,family)){const ctx=createX86EffectContext(instruction,context);return ctx.partial('x86-x87-trusted-decoder-provenance-required',['registers','memory','faults','other'],{metadata:{family:'fp',operation:family,x87PhysicalStateModeled:true}});}
  const base=baseFamily(family),ctx=createX86EffectContext(instruction,context),plan=x87Plan(base,ctx);if(!plan)return null;
  const inputs=[],registersRead=[],stateWriteOperands=[],memoryReads=[],memoryWrites=[];let faults=[possibleFeatureFault('device-not-available')];
  for(const name of plan.reads){const operand=x86RegisterOperand(name),value=operand?ctx.readRegister(operand):null;if(!operand||!value)return ctx.partial('x86-x87-state-unavailable',['registers'],{metadata:{operation:family,state:name}});inputs.push(value);registersRead.push(...physicalIds(operand.register));}
  for(const name of plan.writes){const operand=x86RegisterOperand(name);if(!operand)return ctx.partial('x86-x87-state-unavailable',['registers'],{metadata:{operation:family,state:name}});stateWriteOperands.push(operand);}
  for(const operand of ctx.operands){
    if(operand?.type==='memory'){
      const address=memoryAddress(ctx,operand),width=Number(operand.widthBits||0);if(!address||!width)return ctx.partial('x86-x87-memory-shape-unmodelled',['memory','registers'],{metadata:{operation:family}});
      const access=createMemoryAccess({space:address.space,addressExpr:address.expression,widthBits:width,endian:'little'});
      if(plan.memory==='read'){inputs.push(ctx.readMemory(address.expression,width,{space:address.space,metadata:{...address.metadata,x87:true}}));memoryReads.push(access);faults.push(...x86MemoryFaults('read',width));}
      else if(plan.memory==='write'){memoryWrites.push({operand,address,width,access});faults.push(...x86MemoryFaults('write',width));}
      else return ctx.partial('x86-x87-memory-direction-unmodelled',['memory','other'],{metadata:{operation:family}});
    } else if(operand?.type==='immediate') inputs.push(ctx.constant(Number(operand.widthBits||operand.encodedWidthBits||8),operand.value));
  }
  if(!family.startsWith('fn'))faults.push(Object.freeze({kind:'x87-floating-point-exception',condition:{kind:'x87-control-status-dependent'},detail:{exceptionClass:'#MF'}}));
  if(plan.waitOnly)return ctx.finish({family:'fp',possibleFaults:faults,metadata:{operation:family,x87PhysicalStateModeled:true,x87EnvironmentModeled:true,waitInstruction:true}});
  const explicitRegisterWrites=[];
  if(plan.explicitRegisterWrite){for(const operand of ctx.operands)if(operand?.type==='register'&&!/^st\(/.test(registerName(operand)))explicitRegisterWrites.push(operand);}
  const outputTargets=[...stateWriteOperands.map((operand)=>({kind:'state',operand,width:Number(operand.widthBits||operand.register.viewBits)})),...explicitRegisterWrites.map((operand)=>({kind:'register',operand,width:Number(operand.widthBits||operand.register.viewBits)})),...memoryWrites.map((item)=>({kind:'memory',...item,width:item.width}))];
  if(outputTargets.length===0)return ctx.finish({family:'fp',possibleFaults:faults,metadata:{operation:family,x87PhysicalStateModeled:true,x87EnvironmentModeled:true,topRelativeStack:true}});
  const registersWritten=[...new Set(outputTargets.flatMap((target)=>target.kind==='memory'?[]:physicalIds(target.operand.register)))].sort();
  const outputs=ctx.intrinsic(`x86.x87.${family}`,inputs,outputTargets.map((target)=>target.width),{registersRead:[...new Set(registersRead)].sort(),registersWritten,memoryRead:memoryReads.length?{scope:'accesses',accesses:memoryReads}:{scope:'none'},memoryWrite:memoryWrites.length?{scope:'accesses',accesses:memoryWrites.map(({access})=>access)}:{scope:'none'},determinism:'input-dependent',symbolicDetail:'summary-only',metadata:{operation:family,x87EnvironmentContract:'x86-x87-state/v1',topRelativeStack:true,tagWordModeled:true,exactArchitecturalSummary:true}});
  for(let i=0;i<outputTargets.length;i+=1){const target=outputTargets[i],value=outputs[i];if(target.kind==='memory')ctx.writeMemory(target.address.expression,target.width,value,{space:target.address.space,metadata:{...target.address.metadata,x87:true}});else if(!ctx.writeRegister(target.operand,value))return ctx.partial('x86-x87-state-write-failed',['registers'],{metadata:{operation:family,target:registerName(target.operand)}});}
  return ctx.finish({family:'fp',possibleFaults:faults,metadata:{operation:family,x87PhysicalStateModeled:true,x87EnvironmentModeled:true,topRelativeStack:true,stateWrites:Object.freeze(plan.writes)}});
}
