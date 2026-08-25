import { createMemoryAccess } from '../../../../semantics/effects/index.js';
import { createX86EffectContext, x86MemoryFaults, x86RegisterOperand } from './common.js';
import {
  FP_EVEX_BASES, SIMD_EVEX_BASES, FP_EVEX_PP, SIMD_EVEX_PP, FP_MXCSR_BASES, FP_COMPARE_BASES, EVEX_MOVE_BASES,
  baseFamily, registerName, vectorIndex, isVectorOperand, isMaskOperand, evexInfo, memoryAddress,
  trustedCapstoneInstruction, physicalIds,
} from './extended-state-helpers.js';

function inferredEvexAccess(operand,index,{compare,base,info}){
  const access=String(operand?.access||'unknown');
  if(access!=='unknown'){
    const write=access==='write'||access==='read-write';
    const mergeRead=index===0&&write&&Boolean(info.maskRegister&&!info.zeroing)&&!compare;
    return Object.freeze({read:access==='read'||access==='read-write'||mergeRead,write,inferred:false});
  }
  if(operand?.type==='register'){
    if(compare)return Object.freeze({read:true,write:false,inferred:true});
    if(isMaskOperand(operand))return Object.freeze({read:true,write:false,inferred:true});
    if(index===0)return Object.freeze({read:Boolean(info.maskRegister&&!info.zeroing),write:true,inferred:true});
    return Object.freeze({read:true,write:false,inferred:true});
  }
  if(operand?.type==='memory'){
    if(index===0&&EVEX_MOVE_BASES.has(base))return Object.freeze({read:false,write:true,inferred:true});
    if(index>0)return Object.freeze({read:true,write:false,inferred:true});
  }
  return Object.freeze({read:false,write:false,inferred:false});
}
function evexExpectedPp(category,base){return(category==='fp'?FP_EVEX_PP:SIMD_EVEX_PP).get(base);}
function activeVectorWidth(operands){const widths=operands.filter(isVectorOperand).map((operand)=>Number(operand.widthBits||0)).filter((width)=>[128,256,512].includes(width));return widths.length?Math.max(...widths):null;}
function maskedMemoryFaults(direction,widthBits,maskRegister){return x86MemoryFaults(direction,widthBits).map((fault)=>Object.freeze({...fault,condition:maskRegister?{kind:'x86-evex-active-mask-memory-access',maskRegister,memoryFault:fault.condition}:fault.condition,detail:Object.freeze({...fault.detail,...(maskRegister?{faultSuppression:'inactive-mask-elements-do-not-access-memory'}:{})})}));}
function evexMemoryAccess(ctx,operand){const address=memoryAddress(ctx,operand);if(!address)return null;return Object.freeze({access:createMemoryAccess({space:address.space,addressExpr:address.expression,widthBits:Number(operand.widthBits),endian:'little'}),address});}
function evexRoundingMode(code){return['rn','rd','ru','rz'][code]??null;}
function evexVectorWrite(ctx,operand,value){const index=vectorIndex(operand),full=index==null?null:x86RegisterOperand(`zmm${index}`);return full?ctx.writeRegister(full,value):false;}

function evexCategory(base){if(FP_EVEX_BASES.has(base))return'fp';if(SIMD_EVEX_BASES.has(base))return'simd';return null;}
export function liftEvex(instruction,context,family){
  const info=evexInfo(instruction),base=baseFamily(family),category=evexCategory(base);
  if(!info||!category||!family.startsWith('v'))return null;
  if(!trustedCapstoneInstruction(instruction,family)){const ctx=createX86EffectContext(instruction,context);return ctx.partial('x86-evex-trusted-decoder-provenance-required',['registers','memory','other'],{metadata:{family:category,operation:family,evexPhysicalStateModeled:true}});}
  const expectedPp=evexExpectedPp(category,base);if(expectedPp==null||info.map!==1||info.mandatoryPrefixCode!==expectedPp)return null;
  const ctx=createX86EffectContext(instruction,context),operands=ctx.operands,hasMemory=operands.some((operand)=>operand?.type==='memory'),activeWidth=activeVectorWidth(operands);
  const embeddedRoundingOrSae=category==='fp'&&FP_MXCSR_BASES.has(base)&&info.broadcastOrRounding&&!hasMemory;
  if(!embeddedRoundingOrSae){
    if(info.lengthOrRoundingCode===3)return ctx.partial('x86-evex-length-code-reserved-for-form',['registers','memory','other'],{metadata:{family:category,operation:family}});
    if(activeWidth!=null&&[128,256,512][info.lengthOrRoundingCode]!==activeWidth)return ctx.partial('x86-evex-vector-length-operand-mismatch',['registers','memory','other'],{metadata:{family:category,operation:family,activeWidthBits:activeWidth,encodedLengthCode:info.lengthOrRoundingCode}});
  }
  if(info.broadcastOrRounding&&!hasMemory&&category!=='fp')return ctx.partial('x86-evex-b-register-form-unmodelled',['registers','other'],{metadata:{family:category,operation:family}});
  if(info.maskRegister&&!operands.some((operand)=>isMaskOperand(operand)&&registerName(operand)===info.maskRegister))return ctx.partial('x86-evex-opmask-decoder-mismatch',['registers','other'],{metadata:{family:category,operation:family,maskRegister:info.maskRegister}});

  const inputs=[],registersRead=[],registerTargets=[],memoryReads=[],memoryWrites=[];let faults=[];
  const compare=category==='fp'&&FP_COMPARE_BASES.has(base);
  for(let index=0;index<operands.length;index+=1){
    const operand=operands[index],role=inferredEvexAccess(operand,index,{compare,base,info});
    if(operand?.access==='unknown'&&!role.inferred&&operand?.type!=='immediate')return ctx.partial('x86-evex-operand-access-unmodelled',['registers','memory','other'],{metadata:{family:category,operation:family,operandIndex:index}});
    if(operand?.type==='register'){
      if(role.read){
        const value=ctx.readRegister(operand);if(!value)return ctx.partial('x86-evex-register-read-unmodelled',['registers'],{metadata:{family:category,operation:family,operandIndex:index}});
        inputs.push(value);registersRead.push(...physicalIds(operand.register));
      }
      if(role.write)registerTargets.push({operand,index});
    }else if(operand?.type==='immediate'){
      inputs.push(ctx.constant(Number(operand.widthBits||operand.encodedWidthBits||8),operand.value));
    }else if(operand?.type==='memory'){
      const modeled=evexMemoryAccess(ctx,operand);if(!modeled)return ctx.partial('x86-evex-memory-address-unmodelled',['memory','registers'],{metadata:{family:category,operation:family,operandIndex:index}});
      const width=Number(operand.widthBits||0);if(!width)return ctx.partial('x86-evex-memory-width-unmodelled',['memory'],{metadata:{family:category,operation:family,operandIndex:index}});
      if(role.read){memoryReads.push(modeled.access);faults.push(...maskedMemoryFaults('read',width,info.maskRegister));}
      if(role.write){memoryWrites.push(modeled.access);faults.push(...maskedMemoryFaults('write',width,info.maskRegister));}
      for(const register of [operand.memory?.base,operand.memory?.index])registersRead.push(...physicalIds(register));
    }
  }
  for(const register of ctx.instruction.detail?.implicitReads||[]){const operand=x86RegisterOperand(register.id);if(!operand)continue;const value=ctx.readRegister(operand);if(!value)continue;inputs.push(value);registersRead.push(...physicalIds(register));}

  const outputKinds=[];
  if(compare){
    outputKinds.push(...['CF','PF','ZF','OF','SF','AF'].map((flag)=>({kind:'flag',flag,width:1})));
  }else{
    for(const target of registerTargets){const {operand}=target;if(isVectorOperand(operand))outputKinds.push({kind:'vector',operand,width:512});else outputKinds.push({kind:'register',operand,width:Number(operand.widthBits||operand.register?.viewBits||0)});}
    for(const register of ctx.instruction.detail?.implicitWrites||[]){const operand=x86RegisterOperand(register.id);if(operand)outputKinds.push({kind:'register',operand,width:Number(operand.widthBits||operand.register?.viewBits||0),implicit:true});}
  }
  if(outputKinds.length===0&&memoryWrites.length===0)return ctx.partial('x86-evex-output-shape-unmodelled',['registers','memory','other'],{metadata:{family:category,operation:family}});
  if(outputKinds.some((output)=>!Number.isSafeInteger(output.width)||output.width<=0))return ctx.partial('x86-evex-output-width-unmodelled',['registers','other'],{metadata:{family:category,operation:family}});

  const usesMxcsr=category==='fp'&&FP_MXCSR_BASES.has(base)&&!embeddedRoundingOrSae;
  if(embeddedRoundingOrSae){
    const mxcsr=x86RegisterOperand('mxcsr'),current=mxcsr?ctx.readRegister(mxcsr):null;
    if(!current)return ctx.partial('x86-evex-mxcsr-state-unavailable',['registers','other'],{metadata:{family:category,operation:family}});
    inputs.push(current);registersRead.push('mxcsr');
  }
  const memoryRead=memoryReads.length?{scope:'accesses',accesses:memoryReads,detail:{evex:true,maskRegister:info.maskRegister,broadcast:info.broadcastOrRounding&&hasMemory,faultSuppression:info.maskRegister?'inactive-mask-elements':'none'}}:{scope:'none'};
  const memoryWrite=memoryWrites.length?{scope:'accesses',accesses:memoryWrites,detail:{evex:true,maskRegister:info.maskRegister,faultSuppression:info.maskRegister?'inactive-mask-elements':'none'}}:{scope:'none'};
  const registersWritten=[...new Set(outputKinds.flatMap((output)=>output.kind==='flag'?[]:(isVectorOperand(output.operand)?[`ymm${vectorIndex(output.operand)}`,`zmmh${vectorIndex(output.operand)}`]:physicalIds(output.operand.register))))].sort();
  const outputs=ctx.intrinsic(`x86.evex.${family}`,inputs,outputKinds.map((output)=>output.width),{
    registersRead:[...new Set(registersRead)].sort(),registersWritten,memoryRead,memoryWrite,determinism:'input-dependent',symbolicDetail:'summary-only',
    metadata:{operation:family,category,evex:true,activeVectorWidthBits:activeWidth,maskRegister:info.maskRegister,maskSemantics:info.maskRegister?(info.zeroing?'zero':'merge'):'none',broadcast:info.broadcastOrRounding&&hasMemory,embeddedRoundingOrSae,roundingMode:embeddedRoundingOrSae?evexRoundingMode(info.lengthOrRoundingCode):null,suppressAllExceptions:embeddedRoundingOrSae,opcodeMap:info.map,mandatoryPrefixCode:info.mandatoryPrefixCode,upperBitsAboveVl:'zero-to-maxvl-512',exactArchitecturalSummary:true,...(usesMxcsr?{fpEnvironmentDependency:'MXCSR'}:{})},
  });
  for(let i=0;i<outputKinds.length;i+=1){const target=outputKinds[i],value=outputs[i];if(target.kind==='flag')ctx.writeFlag(target.flag,value,{operation:family,evex:true});else if(target.kind==='vector'){if(!evexVectorWrite(ctx,target.operand,value))return ctx.partial('x86-evex-vector-write-failed',['registers'],{metadata:{family:category,operation:family,operandIndex:target.operand.index}});}else if(!ctx.writeRegister(target.operand,value))return ctx.partial('x86-evex-register-write-failed',['registers'],{metadata:{family:category,operation:family,operandIndex:target.operand.index}});}
  if(usesMxcsr)faults.push(Object.freeze({kind:'x86-simd-floating-point-exception',condition:{kind:'mxcsr-unmasked-floating-point-exception',operation:family,...(info.maskRegister?{maskRegister:info.maskRegister}:{})},detail:{exceptionClass:'#XM',environmentContract:'x86-mxcsr/v1'}}));
  return ctx.finish({family:category,possibleFaults:faults,metadata:{operation:family,evexPhysicalStateModeled:true,maxVlBits:512,activeVectorWidthBits:activeWidth,maskRegister:info.maskRegister,maskSemantics:info.maskRegister?(info.zeroing?'zero':'merge'):'none',broadcast:info.broadcastOrRounding&&hasMemory,embeddedRoundingOrSae,roundingMode:embeddedRoundingOrSae?evexRoundingMode(info.lengthOrRoundingCode):null}});
}

