import {
  createBitVectorValue, createMachineEffectBundle, createMachineOperation, createRegisterValue,
} from '../../../../semantics/effects/index.js';
import { x86RegisterOperand } from './common.js';
import { X87_FAMILIES, baseFamily, exactBase, vexInfo, vectorIndex } from './extended-state-helpers.js';
import { liftVzero, liftEmms, liftX87 } from './extended-state-x87.js';
import { liftEvex } from './extended-state-evex.js';

export function liftX86ExtendedStateEffects(instruction,context={}){
  const family=String(instruction?.instructionFamily||'').toLowerCase(),base=baseFamily(family);
  if(X87_FAMILIES.has(base))return liftX87(instruction,context,family);
  if(family==='emms')return liftEmms(instruction,context);
  if(family==='vzeroall'||family==='vzeroupper')return liftVzero(instruction,context,family);
  if(String(instruction?.detail?.prefixes?.vector?.kind||'').toLowerCase()==='evex')return liftEvex(instruction,context,family);
  return null;
}

export function integrateX86ExtendedStateAliases(instruction,bundle,context={}){
  if(!exactBase(bundle))return bundle;
  const family=String(instruction?.instructionFamily||'').toLowerCase();if(!family.startsWith('v'))return bundle;
  const vex=vexInfo(instruction);if(!vex)return bundle;
  const destination=instruction?.detail?.operands?.[0],index=vectorIndex(destination);if(index==null||index<0||index>15)return bundle;
  const lowPhysicalId=`ymm${index}`;
  // A leading vector operand is not necessarily a destination (for example
  // VUCOMISS/VCOMISS only update flags).  MAXVL zeroing is architectural only
  // when the instruction actually writes the corresponding XMM/YMM view.
  if(!bundle.operations.some((operation)=>operation.kind==='register-write'&&operation.register?.registerId===lowPhysicalId))return bundle;
  if(bundle.operations.some((operation)=>operation.kind==='register-write'&&operation.register?.registerId===`zmmh${index}`))return bundle;
  const operation=createMachineOperation({id:`${bundle.instructionId}:effect:${bundle.operations.length+1}`,kind:'register-write',register:createRegisterValue(`zmmh${index}`,256,{view:`zmm${index}`}),value:createBitVectorValue(256,0n),metadata:{sourceInstructionFamily:family,originInstructionId:bundle.instructionId,view:`zmm${index}`,writePolicy:'vex-zero-upper-maxvl',maxVlBits:512}},context.machineEffectsOptions??context.options??{});
  return createMachineEffectBundle({instructionId:bundle.instructionId,architectureId:bundle.architectureId,mode:bundle.mode,operations:[...bundle.operations,operation],controlEffect:bundle.controlEffect,possibleFaults:bundle.possibleFaults,origin:bundle.origin,completeness:bundle.completeness,...(bundle.unknownEffects?{unknownEffects:bundle.unknownEffects}:{}),...(bundle.statePreservation?{statePreservation:bundle.statePreservation}:{}),metadata:{...(bundle.metadata||{}),maxVlAliasModeled:true,maxVlBits:512,vexUpperState:'bits-VL-through-511-zero'}},context.machineEffectsOptions??context.options??{});
}
