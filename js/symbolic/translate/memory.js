import { projectedMemoryAccessForInstruction } from '../../semantics/compat/semantic-ir-v2-to-v1-memory.js';
/** Execution-state bridge. Uses the same canonical scalar lowering as the
 * static translator, with already evaluated canonical Expr values. */
import { lowerScalarInstruction, floatingSemantics, literalExpression } from './scalar.js';
import { OP, MK } from '../../ir-base.js';
import { translateSemanticIR } from './semantic-ir.js';
import { createBv, createBool, createUnknownSemantic, bvSort, evaluateExpr } from '../expr/index.js';
import { inspectMemoryExpressions as collectSymbols, boundedExpressionEvaluationCost } from '../memory/expression-contract.js';
import { QueryFailure } from '../memory/query-state.js';
import { semanticValueIdentity, registerExecutionValue } from '../memory/value-identity.js';
const undef = (bits,reason) => createUnknownSemantic(bvSort(bits),reason);
function validWidth(bits) {
  if(typeof bits!=='number'||!Number.isSafeInteger(bits)||bits<1||bits>64) throw new QueryFailure('invalid-value-width');
  return bits;
}
export function translateMemoryScalar(inst, args, bits, condition = null) {
  validWidth(bits);
  const expression = lowerScalarInstruction(inst, args, bits, condition);
  const shape = collectSymbols([expression], { maxExprNodes:4096, maxExprDepth:128 });
  if (shape.limitExceeded || shape.depthExceeded) throw new QueryFailure('scalar-expression-budget');
  if (shape.unsupportedReason) return undef(bits, shape.unsupportedReason);
  // Canonical evaluation is recursive. A small shared DAG may denote a huge
  // expansion; reserve the upper bound without evaluating or expanding it.
  let inspections = 0;
  const resources = { take(_key, count = 1) { inspections += count; if (inspections > 20000) throw new QueryFailure('scalar-evaluation-budget'); } };
  if (boundedExpressionEvaluationCost([expression], resources, 65536) > 65536) throw new QueryFailure('scalar-evaluation-budget');
  const result = evaluateExpr(expression);
  return result.status === 'value' ? (expression.sort.kind === 'bv' ? createBv(bits, result.value) : createBool(result.value)) : expression;
}
export function translateExecutionValue(value,state,options={},active=new Set()) {
  state.byteMemory?.chargeExecution();
  const semanticId=registerExecutionValue(value,state);
  if(value.machineType?.kind!=null && !['bitvector','integer','bool','boolean','address','pointer'].includes(value.machineType.kind)) throw new QueryFailure('unsupported-machine-value-sort');
  const bits=validWidth(value.bits);
  if (floatingSemantics(value) || floatingSemantics(value.def)) throw new QueryFailure('unsupported-floating-semantics');
  if (value.machineType?.widthBits != null && value.machineType.widthBits !== bits) throw new QueryFailure('machine-value-width-mismatch');
  if(state.values.has(value.id)) {
    const cached=state.values.get(value.id);
    if(cached?.sort?.kind==='bv' && cached.sort.width!==bits) throw new QueryFailure('semantic-value-width-conflict');
    return cached;
  }
  // On the production execution route, pure definitions are not permission
  // to evaluate an instruction that did not execute on this path. The separate
  // pure-target lowering path deliberately supplies no execution-order state.
  if (state.enforceExecutionOrder && value.def && value.def !== state.executingInstruction) {
    throw new QueryFailure('value-definition-not-executed');
  }
  if(active.has(value.id)||active.size>=64) throw new QueryFailure('value-cycle-or-depth');
  active.add(value.id);
  let expression, inputs=[], control=state.control;
  if (value.kind === 'arg' && options.argumentExpressions?.has(value)) {
    const expression = options.argumentExpressions.get(value);
    state.byteMemory.validateExpression(expression, bits);
    if (options.symbolicArgs != null) throw new QueryFailure('canonical-argument-options-conflict');
    state.byteMemory.chargeExecution(1, 1);
    state.scalarCache.set(value.id, expression);
    state.inputExpressions.set(value.id, expression);
    state.taint?.value(semanticId, [], 'data', {control});
    active.delete(value.id);
    return expression;
  }
  const intrinsicConstant=value.def?.op===OP.CONST || value.const!=null && (!value.def || value.def.op===OP.ADDR);
  if(intrinsicConstant || value.kind==='arg') {
    if(state.scalarCache.has(value.id)) {
      expression=state.scalarCache.get(value.id);
      if(expression.sort.width!==bits) throw new QueryFailure('semantic-value-width-conflict');
    }
    else if (state.inputExpressions?.has(value.id)) {
      // Canonical input identity is query-wide; whether it has been evaluated
      // is path-local. Sharing the former must not grant snapshot membership.
      expression = state.inputExpressions.get(value.id);
      state.byteMemory?.chargeExecution(1, 1);
      state.scalarCache.set(value.id, expression);
    }
    else {
      const index=value.index ?? (/^x[0-9]+$/.test(value.reg ?? '')?Number(value.reg.slice(1)):null);
      const custom=options.symbolicArgs?.[index] ?? options.symbolicArgs?.[value.reg];
      if(custom!=null && !['bigint','number','string'].includes(typeof custom)) throw new QueryFailure('unsupported-configured-argument');
      if(typeof value.const==='number'&&!Number.isSafeInteger(value.const)||typeof custom==='number'&&!Number.isSafeInteger(custom)) throw new QueryFailure('unsafe-integer');
      expression=intrinsicConstant && value.kind!=='arg'
        ? literalExpression(value.def,bits,value)
        : translateSemanticIR({...value,const:null},{bitWidth:bits,symbolicArgs:options.symbolicArgs}).expression;
      state.byteMemory?.chargeExecution(1, 2);
      state.inputExpressions?.set(value.id, expression);
      state.scalarCache.set(value.id,expression);
    }
  } else if(value.def?.op===OP.LOAD) expression=undef(bits,'load-not-executed');
  else if(value.def?.op===OP.PHI) {
    const matches=(value.def.incoming??[]).filter(x=>x.from===state.prevBlock);
    if(matches.length!==1) expression=undef(bits,'ambiguous-phi');
    else { inputs=[semanticValueIdentity(matches[0].value)];expression=translateExecutionValue(matches[0].value,state,options,active); }
  } else if(value.def?.op===OP.SEL) {
    const inst=value.def;
    if (!inst.conditionValue || (inst.args?.length??0)!==2) expression=undef(bits,'memory-select-needs-canonical-condition');
    else {
      const values=[inst.conditionValue,...inst.args.map(a=>a.value)];
      inputs=values.slice(1).map(semanticValueIdentity);
      control=state.taint?.joinHandles(state.control,semanticValueIdentity(inst.conditionValue)) ?? state.control;
      const [condition,yes,no]=values.map(v=>translateExecutionValue(v,state,options,active));
      expression=translateMemoryScalar(inst,[yes,no],bits,condition);
    }
  } else if(value.def) {
    state.byteMemory?.chargeExecution((value.def.args??[]).length,(value.def.args??[]).length);
    const args=(value.def.args??[]).map(a=>a.value);
    inputs=args.map(semanticValueIdentity);
    expression=translateMemoryScalar(value.def,args.map(v=>translateExecutionValue(v,state,options,active)),bits);
  } else expression=undef(bits,'value-without-definition');
  active.delete(value.id);
  if (expression?.sort?.kind === 'bool' && bits !== 1) throw new QueryFailure('boolean-carrier-width-mismatch');
  if (['bool', 'boolean'].includes(value.machineType?.kind) && expression?.sort?.kind !== 'bool') throw new QueryFailure('machine-value-sort-mismatch');
  state.taint?.value(semanticId,inputs,'data',{unknown:expression?.kind==='unknown_semantic',control});
  return expression;
}
export function translateMemoryAccess(inst,state,options={}) {
  const memory=state.byteMemory;
  const size=inst.loc?.size ?? inst.addr?.size ?? inst.extra?.size;
  if(![1,2,4,8].includes(size)) throw new QueryFailure('unsupported-access-width');
  const originalDescriptor=inst.extra?.memoryAccess;
  let descriptor=originalDescriptor;
  if (descriptor && (descriptor.volatility !== false || descriptor.atomic !== false)
      && options.byteMemory?.accessSemantics === 'canonical-normal-completion') {
    const capability=projectedMemoryAccessForInstruction(inst, options._sourceIr, memory.identity);
    if (!capability) throw new QueryFailure('missing-canonical-memory-access-authority');
    descriptor=capability.memory;
    const key=capability.sourceEntityId;
    if (!options._memoryAssumptions.has(key)) {
      memory.chargeExecution(1, 1);
      options._memoryAssumptions.set(key,Object.freeze({kind:'normal-memory-completion',
        sourceEntityId:key,identity:memory.identity,artifactDigest:capability.artifactDigest,
        possibleFaults:capability.possibleFaults,statement:'Access completes normally; faulting executions are outside this query scope.'}));
    }
  }
  for(const width of [inst.loc?.size,inst.addr?.size,inst.extra?.size]) {
    if(width!=null && width!==size) throw new QueryFailure('memory-width-mismatch');
  }
  for(const bits of [inst.addr?.widthBits,inst.extra?.widthBits,descriptor?.widthBits]) {
    if(bits!=null && bits!==size*8) throw new QueryFailure('memory-width-mismatch');
  }
  for(const space of [inst.loc?.addressSpace,inst.addr?.addressSpace,descriptor?.addressSpace]) {
    if(space!=null && space!==memory.identity.addressSpace) throw new QueryFailure('address-space-mismatch');
  }
  const canonicalAddressId=descriptor?.addressExpr?.valueId;
  if(!canonicalAddressId && (inst.addr?.precise===false || inst.extra?.addressPrecise===false)) throw new QueryFailure('unresolved-memory-address');
  // Consume the actual v2→v1 descriptor. Unknown qualifiers are not authority for
  // ordinary memory, even when a legacy location key looks precise.
  if(descriptor) {
    if(descriptor.volatility===true) throw new QueryFailure('volatile-barrier');
    if(descriptor.atomic===true) throw new QueryFailure('atomic-barrier');
    if(descriptor.volatility!==false || descriptor.atomic!==false || descriptor.ordering!=null && !['unknown','none'].includes(descriptor.ordering)) throw new QueryFailure('unknown-memory-qualifiers');
    if(descriptor.endian!==memory.endian) throw new QueryFailure('memory-endian-mismatch');
  }
  let address, addressIds=[];
  // Absolute locations and the existing generic base+displacement IR contract only.
  // No name-based FIELD/STACK alias inference and no ISA index/extension decoding.
  if(canonicalAddressId!=null) {
    const value=options._semanticValues?.get(canonicalAddressId);
    if(!value || inst.extra?.completeness!=='complete') throw new QueryFailure('unresolved-canonical-memory-address');
    addressIds=[semanticValueIdentity(value)];
    address=translateExecutionValue(value,state,options);
    if(address.sort?.kind!=='bv' || address.sort.width!==memory.addressBits) throw new QueryFailure('address-width-mismatch');
    if(memory.wrapping==='reject' && !['const','fresh_symbol'].includes(address.kind)) throw new QueryFailure('effective-address-wrap-unproved');
  }
  else if(inst.loc?.kind===MK.GLOBAL && inst.loc.address!=null) address=inst.loc.address;
  else if(inst.addr?.base && !inst.addr.index && inst.addr.disp!=null) {
    addressIds=[semanticValueIdentity(inst.addr.base)];
    address=translateExecutionValue(inst.addr.base,state,options);
    if(address.sort?.kind!=='bv'||address.sort.width!==memory.addressBits) throw new QueryFailure('address-width-mismatch');
    const disp=inst.addr.disp;
    if(typeof disp!=='bigint' && !(typeof disp==='number'&&Number.isSafeInteger(disp))) throw new QueryFailure('unsafe-displacement');
    if(BigInt(disp)!==0n) {
      if(memory.wrapping==='reject' && (address.kind!=='const' || address.value+BigInt(disp)<0n || address.value+BigInt(disp)>=(1n<<BigInt(memory.addressBits)))) {
        throw new QueryFailure('effective-address-wrap-unproved');
      }
      address=translateMemoryScalar({op:OP.BIN,subOp:'add'},[address,createBv(memory.addressBits,disp)],memory.addressBits);
    }
  } else throw new QueryFailure('unresolved-memory-address');
  const access={identity:memory.identity,addressSpace:inst.loc?.addressSpace,
    volatile:[inst.volatile,inst.extra?.volatile,inst.loc?.volatile].some(value=>value!=null&&value!==false),
    atomic:[inst.atomic,inst.extra?.atomic,inst.loc?.atomic].some(value=>value!=null&&value!==false)};
  if(inst.op===OP.LOAD) {
    if(inst.dst?.bits!==size*8) throw new QueryFailure('load-width-mismatch');
    const result=memory.load(address,size,access);
    if(!result.expression) throw new QueryFailure(result.reason);
    state.taint?.value(semanticValueIdentity(inst.dst),[result.label,...addressIds],'memory-load',{control:state.control});
    return result.expression;
  }
  if(inst.op!==OP.STORE) throw new QueryFailure('not-memory-instruction');
  const v=inst.args?.[0]?.value;
  const expression=translateExecutionValue(v,state,options);
  const label=state.taint?.joinHandles(semanticValueIdentity(v),...addressIds,state.control);
  const result=memory.store(address,size,expression,{...access,label});
  if(result.status!=='stored') throw new QueryFailure(result.reason);
  return expression;
}
