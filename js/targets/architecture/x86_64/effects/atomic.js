import { createX86EffectContext, x86MemoryFaults, x86RegisterOperand } from './common.js';
import { x86EffectiveAddressExpression } from './addressing.js';
import { emitX86ArithmeticFlags } from './flags.js';
import { createRegisterValue } from '../../../../semantics/effects/index.js';

const ATOMIC_FAMILIES = new Set(['xchg','xadd','cmpxchg','cmpxchg8b','cmpxchg16b']);
const WIDTHS = new Set([8,16,32,64]);
const LOCKED_ORDERING_AUTHORITY = 'Intel SDM Vol.3 locked-instruction total-order/no-reordering rules';
const LOCKED_ORDERING_CONTRACT = 'x86-locked-rmw-seq-cst/v1';

function supportedWidth(widthBits) { return WIDTHS.has(Number(widthBits)); }
function hasLock(instruction) { return [...(instruction?.detail?.prefixes?.legacy || [])].includes(0xf0); }
function memoryOperands(operands) { return operands.filter((operand) => operand?.type === 'memory'); }
function addressFor(ctx, operand) {
  if (operand?.type !== 'memory' || !supportedWidth(operand.widthBits)) return null;
  return x86EffectiveAddressExpression(ctx.instruction, operand);
}
function accumulatorName(widthBits) { return ({8:'al',16:'ax',32:'eax',64:'rax'})[widthBits] || null; }
function rmwId(ctx, family) { return `${ctx.instructionId}:atomic-rmw:${family}`; }
function memoryConfig(address, relationshipId, phase, atomic, metadata = {}) {
  return { space:address.space, atomic, metadata:{ ...address.metadata, rmwId:relationshipId, rmwPhase:phase, atomicRmw:atomic, sameInstructionRelationship:true, ...metadata } };
}
function orderingPartial(ctx, family, faults, metadata = {}, detail = {}) {
  return ctx.partial('x86-atomic-ordering-not-mapped-by-frozen-p5-0-contract', ['memory'], {
    possibleFaults:faults,
    detail:{ atomicity:'exact', ordering:'intentionally-unmapped', overclaimAvoided:'seq-cst-not-assigned', ...detail },
    metadata:{ family:'atomic', operation:family, atomic:true, orderingMapping:'unmapped-not-seq-cst', ...metadata },
  });
}
function implicitReadIds(ctx) {
  return new Set((ctx.instruction?.detail?.implicitReads || []).map((register) => register?.id).filter(Boolean));
}
function implicitWriteIds(ctx) {
  return new Set((ctx.instruction?.detail?.implicitWrites || []).map((register) => register?.id).filter(Boolean));
}
function hasAccumulatorDetail(ctx, widthBits) {
  const accumulator = accumulatorName(widthBits);
  return accumulator != null && implicitReadIds(ctx).has(accumulator);
}
function viewFromPhysical(ctx, operand, physicalValue) {
  const descriptor = operand?.register;
  if (!descriptor || !physicalValue) return null;
  if (descriptor.viewBits === descriptor.physicalBits && descriptor.lsb === 0) return physicalValue;
  return ctx.valueOp('extract', [physicalValue], descriptor.viewBits, {
    lsb:descriptor.lsb,
    widthBits:descriptor.viewBits,
    physicalBits:descriptor.physicalBits,
    physicalId:descriptor.physicalId,
    view:descriptor.id,
    semantic:'x86-atomic-snapshot-view',
  });
}
function physicalRead(ctx, operand) {
  const descriptor = operand?.register;
  if (!descriptor) return null;
  const physicalOperand = x86RegisterOperand(descriptor.physicalId);
  const full = physicalOperand ? ctx.readRegister(physicalOperand) : null;
  if (!physicalOperand || !full) return null;
  return { descriptor, physicalOperand, full, view:viewFromPhysical(ctx,operand,full) };
}
function physicalViewWriteValue(ctx, descriptor, basePhysical, value) {
  if (!descriptor || !basePhysical || !value) return null;
  if (descriptor.writePolicy === 'replace' && descriptor.viewBits === descriptor.physicalBits && descriptor.lsb === 0) return value;
  if (descriptor.writePolicy === 'zero-extend-32') return ctx.coerce(value, descriptor.viewBits, descriptor.physicalBits, false);
  return ctx.valueOp('insert', [basePhysical,value], descriptor.physicalBits, {
    lsb:descriptor.lsb,
    widthBits:descriptor.viewBits,
    physicalBits:descriptor.physicalBits,
    physicalId:descriptor.physicalId,
    view:descriptor.id,
    writePolicy:'preserve-unaffected',
    semantic:'x86-atomic-view-write-candidate',
  });
}
function writePhysical(ctx, physicalId, value) {
  const operand = x86RegisterOperand(physicalId);
  return operand != null && ctx.writeRegister(operand, value);
}
function accumulatorPhysicalState(ctx, widthBits) {
  const accumulator = x86RegisterOperand(accumulatorName(widthBits));
  const physical = x86RegisterOperand('rax');
  const full = physical ? ctx.readRegister(physical) : null;
  const view = accumulator && full ? viewFromPhysical(ctx,accumulator,full) : null;
  return accumulator && physical && full && view ? { accumulator, descriptor:accumulator.register, physical, full, view } : null;
}
function accumulatorFailurePhysical(ctx, state, failureValue) {
  return physicalViewWriteValue(ctx,state.descriptor,state.full,failureValue);
}
function lockedMetadata(locked) {
  return locked ? {
    orderingMapping:'seq-cst',
    orderingAuthority:LOCKED_ORDERING_AUTHORITY,
    orderingContract:LOCKED_ORDERING_CONTRACT,
    orderingScope:'proven-atomic-rmw-only',
  } : { orderingMapping:'not-applicable' };
}

function liftRegisterXchg(ctx) {
  const [left, right] = ctx.operands;
  if (ctx.operands.length !== 2 || left?.type !== 'register' || right?.type !== 'register'
    || left.widthBits !== right.widthBits || !supportedWidth(left.widthBits)) {
    return ctx.partial('x86-xchg-register-shape-unmodelled', ['registers']);
  }

  // Snapshot both operand views before any write. For distinct physical
  // registers the canonical context writer is sufficient. For overlapping
  // views (notably AL/AH), compose both view writes against one physical
  // snapshot and emit the sequential physical states under the original view
  // labels so the final write cannot discard the first update.
  const leftValue = ctx.readRegister(left);
  const rightValue = ctx.readRegister(right);
  if (!leftValue || !rightValue) return ctx.partial('x86-xchg-register-state-unmodelled', ['registers']);
  const samePhysical = left.register.physicalId === right.register.physicalId;
  if (!samePhysical) {
    if (!ctx.writeRegister(left,rightValue) || !ctx.writeRegister(right,leftValue)) {
      return ctx.partial('x86-xchg-register-write-unmodelled', ['registers']);
    }
  } else {
    const physicalOperand = x86RegisterOperand(left.register.physicalId);
    const full = physicalOperand ? ctx.readRegister(physicalOperand) : null;
    if (!full) return ctx.partial('x86-xchg-register-physical-state-unmodelled', ['registers']);
    const first = physicalViewWriteValue(ctx,left.register,full,rightValue);
    const second = physicalViewWriteValue(ctx,right.register,first,leftValue);
    if (!first || !second) return ctx.partial('x86-xchg-register-write-candidate-unmodelled', ['registers']);
    const physicalRegister = createRegisterValue(left.register.physicalId,left.register.physicalBits,{view:left.register.id});
    ctx.addOperation({ kind:'register-write', register:physicalRegister, value:first, metadata:{ view:left.register.id, writePolicy:left.register.writePolicy, overlappingPhysicalRegister:true, composedAtomicExchange:true } });
    ctx.addOperation({ kind:'register-write', register:createRegisterValue(right.register.physicalId,right.register.physicalBits,{view:right.register.id}), value:second, metadata:{ view:right.register.id, writePolicy:right.register.writePolicy, overlappingPhysicalRegister:true, composedAtomicExchange:true } });
  }
  return ctx.finish({
    family:'atomic',
    metadata:{ operation:'xchg', atomic:false, registerExchange:true, widthBits:left.widthBits, overlappingPhysicalRegister:samePhysical },
  });
}

function liftRegisterXadd(ctx) {
  const [destination,source] = ctx.operands;
  if (ctx.operands.length !== 2 || destination?.type !== 'register' || source?.type !== 'register'
    || destination.widthBits !== source.widthBits || !supportedWidth(destination.widthBits)) {
    return ctx.partial('x86-xadd-register-shape-unmodelled',['registers','flags']);
  }
  const samePhysical = destination.register.physicalId === source.register.physicalId;
  let destinationState;
  let sourceState;
  if (samePhysical) {
    const physicalOperand = x86RegisterOperand(destination.register.physicalId);
    const full = physicalOperand ? ctx.readRegister(physicalOperand) : null;
    if (!physicalOperand || !full) return ctx.partial('x86-xadd-register-state-unmodelled',['registers','flags']);
    destinationState = { descriptor:destination.register, full, view:viewFromPhysical(ctx,destination,full) };
    sourceState = { descriptor:source.register, full, view:viewFromPhysical(ctx,source,full) };
  } else {
    destinationState = physicalRead(ctx,destination);
    sourceState = physicalRead(ctx,source);
  }
  if (!destinationState?.view || !sourceState?.view) return ctx.partial('x86-xadd-register-state-unmodelled',['registers','flags']);
  const result = ctx.valueOp('add',[destinationState.view,sourceState.view],destination.widthBits,{semantic:'x86-xadd-destination-result',registerRmw:true});
  emitX86ArithmeticFlags(ctx,'add',destinationState.view,sourceState.view,result,destination.widthBits);
  if (samePhysical) {
    let next = physicalViewWriteValue(ctx,source.register,sourceState.full,destinationState.view);
    next = physicalViewWriteValue(ctx,destination.register,next,result);
    if (!next || !writePhysical(ctx,destination.register.physicalId,next)) return ctx.partial('x86-xadd-register-write-unmodelled',['registers','flags']);
  } else {
    const sourceNext = physicalViewWriteValue(ctx,source.register,sourceState.full,destinationState.view);
    const destinationNext = physicalViewWriteValue(ctx,destination.register,destinationState.full,result);
    if (!sourceNext || !destinationNext || !writePhysical(ctx,source.register.physicalId,sourceNext) || !writePhysical(ctx,destination.register.physicalId,destinationNext)) {
      return ctx.partial('x86-xadd-register-write-unmodelled',['registers','flags']);
    }
  }
  return ctx.finish({ family:'atomic', metadata:{ operation:'xadd', atomic:false, registerRmw:true, widthBits:destination.widthBits, sourceReceivesOldDestination:true, overlappingPhysicalRegister:samePhysical } });
}

function liftRegisterCmpxchg(ctx) {
  const [destination,source] = ctx.operands;
  if (ctx.operands.length !== 2 || destination?.type !== 'register' || source?.type !== 'register'
    || destination.widthBits !== source.widthBits || !supportedWidth(destination.widthBits)) {
    return ctx.partial('x86-cmpxchg-register-shape-unmodelled',['registers','flags']);
  }
  if (!hasAccumulatorDetail(ctx,destination.widthBits)) {
    return ctx.partial('x86-cmpxchg-structured-implicit-accumulator-missing',['registers','flags'],{metadata:{family:'atomic',operation:'cmpxchg',requiredImplicitAccumulator:accumulatorName(destination.widthBits)}});
  }

  const accumulator = accumulatorPhysicalState(ctx,destination.widthBits);
  if (!accumulator) return ctx.partial('x86-cmpxchg-register-accumulator-state-unmodelled',['registers','flags']);
  const sameAccumulatorPhysical = destination.register.physicalId === 'rax';
  let destinationFull;
  let destinationValue;
  if (sameAccumulatorPhysical) {
    destinationFull = accumulator.full;
    destinationValue = viewFromPhysical(ctx,destination,accumulator.full);
  } else {
    const state = physicalRead(ctx,destination);
    destinationFull = state?.full;
    destinationValue = state?.view;
  }
  const sourceValue = ctx.readRegister(source);
  if (!destinationFull || !destinationValue || !sourceValue) return ctx.partial('x86-cmpxchg-register-state-unmodelled',['registers','flags']);

  const compareResult = ctx.valueOp('sub',[accumulator.view,destinationValue],destination.widthBits,{compareOnly:true,semantic:'x86-cmpxchg-accumulator-minus-destination'});
  emitX86ArithmeticFlags(ctx,'cmp',accumulator.view,destinationValue,compareResult,destination.widthBits);
  const success = ctx.valueOp('eq',[accumulator.view,destinationValue],1,{semantic:'x86-cmpxchg-success',equivalentFlag:'ZF=1'});
  const destinationSuccess = physicalViewWriteValue(ctx,destination.register,destinationFull,sourceValue);
  const accumulatorFailure = accumulatorFailurePhysical(ctx,accumulator,destinationValue);
  if (!destinationSuccess || !accumulatorFailure) return ctx.partial('x86-cmpxchg-register-write-candidate-unmodelled',['registers','flags']);

  if (sameAccumulatorPhysical) {
    const next = ctx.valueOp('select',[success,destinationSuccess,accumulatorFailure],64,{semantic:'x86-cmpxchg-shared-physical-result',successPath:'destination-source',failurePath:'destination-to-accumulator'});
    if (!writePhysical(ctx,'rax',next)) return ctx.partial('x86-cmpxchg-register-write-unmodelled',['registers','flags']);
  } else {
    const destinationNext = ctx.valueOp('select',[success,destinationSuccess,destinationFull],64,{semantic:'x86-cmpxchg-destination-physical-result',successPath:'source-to-destination',failurePath:'destination-preserved'});
    const accumulatorNext = ctx.valueOp('select',[success,accumulator.full,accumulatorFailure],64,{semantic:'x86-cmpxchg-accumulator-physical-result',successPath:'physical-accumulator-preserved',failurePath:'old-destination-to-accumulator'});
    if (!writePhysical(ctx,destination.register.physicalId,destinationNext) || !writePhysical(ctx,'rax',accumulatorNext)) {
      return ctx.partial('x86-cmpxchg-register-write-unmodelled',['registers','flags']);
    }
  }
  return ctx.finish({
    family:'atomic',
    metadata:{ operation:'cmpxchg', atomic:false, conditional:true, registerDestination:true, implicitAccumulator:accumulatorName(destination.widthBits), widthBits:destination.widthBits, overlappingAccumulatorPhysical:sameAccumulatorPhysical },
  });
}

function liftXchg(ctx) {
  if (memoryOperands(ctx.operands).length !== 1 || ctx.operands.length !== 2) return ctx.partial('x86-xchg-memory-shape-unmodelled',['memory','registers']);
  const memory = ctx.operands.find((operand) => operand.type === 'memory'), register = ctx.operands.find((operand) => operand.type === 'register');
  if (!memory || !register || !supportedWidth(memory.widthBits) || memory.widthBits !== register.widthBits) return ctx.partial('x86-xchg-memory-width-or-register-unmodelled',['memory','registers']);
  const address = addressFor(ctx,memory), registerValue = ctx.readRegister(register);
  if (!address || !registerValue) return ctx.partial('x86-xchg-memory-address-or-register-unmodelled',['memory','registers']);
  const relationshipId = rmwId(ctx,'xchg');
  const oldMemory = ctx.readMemory(address.expression,memory.widthBits,memoryConfig(address,relationshipId,'read',true,{implicitAtomicity:true,explicitLockPrefix:hasLock(ctx.instruction)}));
  ctx.writeMemory(address.expression,memory.widthBits,registerValue,memoryConfig(address,relationshipId,'write',true,{implicitAtomicity:true,exchangedWithRegister:register.register.id}));
  if (!ctx.writeRegister(register,oldMemory)) return ctx.partial('x86-xchg-register-write-unmodelled',['registers','memory']);
  return orderingPartial(ctx,'xchg',x86MemoryFaults('read-write',memory.widthBits),{rmwId:relationshipId,sameCanonicalAddress:true,implicitAtomicWithoutLock:true,explicitLockPrefix:hasLock(ctx.instruction),address:address.metadata});
}
function liftXadd(ctx) {
  const [destination,source] = ctx.operands;
  if (destination?.type !== 'memory' || source?.type !== 'register' || memoryOperands(ctx.operands).length !== 1 || !supportedWidth(destination.widthBits) || destination.widthBits !== source.widthBits) return ctx.partial('x86-xadd-memory-shape-unmodelled',['memory','registers','flags']);
  const address = addressFor(ctx,destination), sourceValue = ctx.readRegister(source);
  if (!address || !sourceValue) return ctx.partial('x86-xadd-memory-address-or-source-unmodelled',['memory','registers','flags']);
  const locked = hasLock(ctx.instruction), relationshipId = rmwId(ctx,'xadd');
  const oldDestination = ctx.readMemory(address.expression,destination.widthBits,memoryConfig(address,relationshipId,'read',locked,{operation:'xadd'}));
  const result = ctx.valueOp('add',[oldDestination,sourceValue],destination.widthBits,{semantic:'x86-xadd-destination-result',rmwId:relationshipId,preservesOldDestinationForSource:true});
  ctx.writeMemory(address.expression,destination.widthBits,result,memoryConfig(address,relationshipId,'write',locked,{operation:'xadd',oldDestinationTransferredToSource:true}));
  if (!ctx.writeRegister(source,oldDestination)) return ctx.partial('x86-xadd-source-register-write-unmodelled',['registers','memory','flags']);
  emitX86ArithmeticFlags(ctx,'add',oldDestination,sourceValue,result,destination.widthBits);
  const faults = x86MemoryFaults('read-write',destination.widthBits), metadata = {rmwId:relationshipId,sameCanonicalAddress:true,sourceReceivesOldDestination:true,explicitLockPrefix:locked,address:address.metadata};
  if (locked) return orderingPartial(ctx,'xadd',faults,metadata);
  return ctx.finish({family:'atomic',possibleFaults:faults,metadata:{operation:'xadd',atomic:false,...metadata}});
}

function legacyCmpxchgPartial(ctx,destination,source) {
  const address = addressFor(ctx,destination), accumulator = x86RegisterOperand(accumulatorName(destination.widthBits)), sourceValue = ctx.readRegister(source), accumulatorValue = accumulator ? ctx.readRegister(accumulator) : null;
  if (!address || !sourceValue || !accumulatorValue) return ctx.partial('x86-cmpxchg-memory-address-or-implicit-state-unmodelled',['memory','registers','flags']);
  const locked = hasLock(ctx.instruction), relationshipId = rmwId(ctx,'cmpxchg');
  const oldDestination = ctx.readMemory(address.expression,destination.widthBits,memoryConfig(address,relationshipId,'read',locked,{operation:'cmpxchg',conditionalRmw:true}));
  const compareResult = ctx.valueOp('sub',[accumulatorValue,oldDestination],destination.widthBits,{compareOnly:true,semantic:'x86-cmpxchg-accumulator-minus-destination',rmwId:relationshipId});
  emitX86ArithmeticFlags(ctx,'cmp',accumulatorValue,oldDestination,compareResult,destination.widthBits);
  const success = ctx.valueOp('eq',[accumulatorValue,oldDestination],1,{semantic:'x86-cmpxchg-success',equivalentFlag:'ZF=1',rmwId:relationshipId});
  const memoryResult = ctx.valueOp('select',[success,sourceValue,oldDestination],destination.widthBits,{semantic:'x86-cmpxchg-memory-result',successPath:'source-to-destination',failurePath:'destination-unchanged',rmwId:relationshipId});
  ctx.writeMemory(address.expression,destination.widthBits,memoryResult,memoryConfig(address,relationshipId,'conditional-write-overapproximation',locked,{operation:'cmpxchg',conditionalWrite:true,writeCondition:'accumulator == oldDestination',failurePathArchitecturalWrite:false,representationIsConservativeMayWrite:true}));
  const accumulatorResult = ctx.valueOp('select',[success,accumulatorValue,oldDestination],destination.widthBits,{semantic:'x86-cmpxchg-accumulator-result',successPath:'accumulator-preserved',failurePath:'old-destination-to-accumulator',rmwId:relationshipId});
  if (!ctx.writeRegister(accumulator,accumulatorResult)) return ctx.partial('x86-cmpxchg-accumulator-write-unmodelled',['registers','memory','flags']);
  const faults = x86MemoryFaults('read-write',destination.widthBits);
  return ctx.partial(locked ? 'x86-cmpxchg-conditional-store-and-atomic-ordering-not-fully-representable' : 'x86-cmpxchg-conditional-store-not-fully-representable',['memory'],{
    possibleFaults:faults,
    detail:{conditionalStore:'structured implicit accumulator detail is required before exact physical-state modeling; legacy fallback preserves the previous conservative may-write representation',successPath:'destination=source; accumulator preserved; ZF=1',failurePath:'destination unchanged; accumulator=old destination; ZF=0',ordering:locked ? 'mapped by common atomic integration only' : 'not atomic without LOCK'},
    metadata:{family:'atomic',operation:'cmpxchg',rmwId:relationshipId,sameCanonicalAddress:true,conditional:true,explicitLockPrefix:locked,atomic:locked,orderingMapping:locked ? 'unmapped-not-seq-cst' : 'not-applicable',successValue:success,address:address.metadata,structuredImplicitAccumulatorMissing:true},
  });
}

function liftCmpxchg(ctx) {
  const [destination,source] = ctx.operands;
  if (destination?.type !== 'memory' || source?.type !== 'register' || memoryOperands(ctx.operands).length !== 1 || !supportedWidth(destination.widthBits) || destination.widthBits !== source.widthBits) return ctx.partial('x86-cmpxchg-memory-shape-unmodelled',['memory','registers','flags']);
  if (!hasAccumulatorDetail(ctx,destination.widthBits)) return legacyCmpxchgPartial(ctx,destination,source);
  const address = addressFor(ctx,destination), accumulator = accumulatorPhysicalState(ctx,destination.widthBits), sourceValue = ctx.readRegister(source);
  if (!address || !accumulator || !sourceValue) return ctx.partial('x86-cmpxchg-memory-address-or-implicit-state-unmodelled',['memory','registers','flags']);
  const locked = hasLock(ctx.instruction), relationshipId = rmwId(ctx,'cmpxchg');
  const oldDestination = ctx.readMemory(address.expression,destination.widthBits,memoryConfig(address,relationshipId,'read',locked,{operation:'cmpxchg',conditionalRmw:true,architecturalWriteCycle:true}));
  const compareResult = ctx.valueOp('sub',[accumulator.view,oldDestination],destination.widthBits,{compareOnly:true,semantic:'x86-cmpxchg-accumulator-minus-destination',rmwId:relationshipId});
  emitX86ArithmeticFlags(ctx,'cmp',accumulator.view,oldDestination,compareResult,destination.widthBits);
  const success = ctx.valueOp('eq',[accumulator.view,oldDestination],1,{semantic:'x86-cmpxchg-success',equivalentFlag:'ZF=1',rmwId:relationshipId});
  const memoryResult = ctx.valueOp('select',[success,sourceValue,oldDestination],destination.widthBits,{semantic:'x86-cmpxchg-memory-result',successPath:'source-to-destination',failurePath:'old-destination-written-back',rmwId:relationshipId});
  ctx.writeMemory(address.expression,destination.widthBits,memoryResult,memoryConfig(address,relationshipId,'write',locked,{operation:'cmpxchg',conditionalValue:true,writeCondition:'accumulator == oldDestination',failurePathArchitecturalWrite:true,failurePathWritesOldDestination:true,architecturalWriteCycleRegardlessOfComparison:true}));
  const accumulatorFailure = accumulatorFailurePhysical(ctx,accumulator,oldDestination);
  if (!accumulatorFailure) return ctx.partial('x86-cmpxchg-accumulator-write-candidate-unmodelled',['registers','memory','flags']);
  const accumulatorNext = ctx.valueOp('select',[success,accumulator.full,accumulatorFailure],64,{semantic:'x86-cmpxchg-accumulator-physical-result',successPath:'physical-accumulator-preserved',failurePath:'old-destination-to-accumulator-view',rmwId:relationshipId});
  if (!writePhysical(ctx,'rax',accumulatorNext)) return ctx.partial('x86-cmpxchg-accumulator-write-unmodelled',['registers','memory','flags']);
  return ctx.finish({
    family:'atomic',
    possibleFaults:x86MemoryFaults('read-write',destination.widthBits),
    metadata:{ family:'atomic', operation:'cmpxchg', rmwId:relationshipId, sameCanonicalAddress:true, conditional:true, explicitLockPrefix:locked, atomic:locked, implicitAccumulator:accumulatorName(destination.widthBits), architecturalWriteCycleRegardlessOfComparison:true, address:address.metadata },
  });
}

function wideExpectedDetail(family) {
  if (family === 'cmpxchg16b') return { widthBits:128, reads:['rax','rbx','rcx','rdx'], writes:['rax','rdx','rflags'], requiredFeature:'cx16', alignment:16 };
  return { widthBits:64, reads:['eax','ebx','ecx','edx'], writes:['eax','edx','rflags'], requiredFeature:'cx8', alignment:null };
}
function wideDetailMatches(ctx,family) {
  const expected = wideExpectedDetail(family), reads = implicitReadIds(ctx), writes = implicitWriteIds(ctx);
  return expected.reads.every((id) => reads.has(id)) && expected.writes.every((id) => writes.has(id));
}
function legacyWidePartial(ctx,family) {
  const [destination] = ctx.operands, expected = wideExpectedDetail(family);
  const address = destination?.type === 'memory' ? x86EffectiveAddressExpression(ctx.instruction,destination) : null;
  const faults = destination?.type === 'memory' ? [...x86MemoryFaults('read-write',expected.widthBits),...(family === 'cmpxchg16b' ? [{kind:'general-protection',condition:{kind:'x86-cmpxchg16b-misaligned',requiredAlignment:16},detail:{vector:'#GP',alignmentBytes:16}}] : [])] : [];
  return ctx.partial(`x86-${family}-wide-atomic-pair-semantics-not-representable-by-frozen-p5-0-contract`,['memory','registers','flags'],{possibleFaults:faults,detail:{p5Classification:'P5-I-INTEGRATION-REQUIRED',expectedMemoryWidthBits:expected.widthBits,implicitRegisterPairs:true,conditionalWideAtomicRmw:true,alignmentRequirement:expected.alignment,structuredImplicitDetailRequired:true},metadata:{family:'atomic',operation:family,address:address?.metadata ?? null,exactWideAtomicClaim:false}});
}
function liftWideCmpxchg(ctx,family) {
  const [destination] = ctx.operands, expected = wideExpectedDetail(family);
  if (ctx.operands.length !== 1 || destination?.type !== 'memory' || destination.widthBits !== expected.widthBits) {
    return ctx.partial(`x86-${family}-memory-shape-or-width-unmodelled`,['memory','registers','flags'],{metadata:{family:'atomic',operation:family,expectedMemoryWidthBits:expected.widthBits}});
  }
  if (!wideDetailMatches(ctx,family)) return legacyWidePartial(ctx,family);
  const address = x86EffectiveAddressExpression(ctx.instruction,destination);
  if (!address) return ctx.partial(`x86-${family}-memory-address-unmodelled`,['memory','registers','flags']);
  const rax = ctx.readRegister(x86RegisterOperand('rax'));
  const rdx = ctx.readRegister(x86RegisterOperand('rdx'));
  const rbx = ctx.readRegister(x86RegisterOperand('rbx'));
  const rcx = ctx.readRegister(x86RegisterOperand('rcx'));
  if (!rax || !rdx || !rbx || !rcx) return ctx.partial(`x86-${family}-implicit-register-state-unmodelled`,['registers','memory','flags']);
  const locked = hasLock(ctx.instruction), relationshipId = rmwId(ctx,family);
  const access = {
    space:address.space,
    addressExpr:address.expression,
    widthBits:expected.widthBits,
    endian:'little',
    atomic:locked,
    ...(locked ? { ordering:'seq-cst' } : {}),
    ...(expected.alignment == null ? {} : { alignment:expected.alignment }),
  };
  const [nextRax,nextRdx,zf] = ctx.intrinsic(`x86.atomic.${family}`, [rax,rdx,rbx,rcx], [64,64,1], {
    registersRead:[],
    registersWritten:[],
    memoryRead:{ scope:'accesses', accesses:[access], detail:{ rmwId:relationshipId, phase:'read', sameInstructionRelationship:true } },
    memoryWrite:{ scope:'accesses', accesses:[access], detail:{ rmwId:relationshipId, phase:'write', sameInstructionRelationship:true, architecturalWriteCycleRegardlessOfComparison:true } },
    determinism:'input-dependent',
    symbolicDetail:'summary-only',
    metadata:{
      family:'atomic',
      operation:family,
      rmwId:relationshipId,
      exactArchitecturalSummary:true,
      semanticModel:`intel-amd-${family}-conditional-wide-rmw/v1`,
      expectedPair:family === 'cmpxchg16b' ? 'RDX:RAX' : 'EDX:EAX',
      replacementPair:family === 'cmpxchg16b' ? 'RCX:RBX' : 'ECX:EBX',
      success:'ZF=1; memory receives replacement pair; RDX:RAX physical state preserved',
      failure:family === 'cmpxchg16b' ? 'ZF=0; memory value written back; RDX:RAX receives old memory' : 'ZF=0; memory value written back; EDX:EAX receives old memory and zero-extends into RDX:RAX',
      unaffectedFlags:['CF','PF','AF','SF','OF'],
      requiredFeature:expected.requiredFeature,
      alignmentBytes:expected.alignment,
      atomic:locked,
      explicitLockPrefix:locked,
      ...lockedMetadata(locked),
    },
  });
  if (!writePhysical(ctx,'rax',nextRax) || !writePhysical(ctx,'rdx',nextRdx)) return ctx.partial(`x86-${family}-implicit-register-write-unmodelled`,['registers','memory','flags']);
  ctx.writeFlag('ZF',zf,{operation:family,definedness:'defined',semantic:'wide-compare-equality'});
  const faults = [
    ...x86MemoryFaults('read-write',expected.widthBits),
    ...(family === 'cmpxchg16b' ? [{kind:'general-protection',condition:{kind:'x86-cmpxchg16b-misaligned',requiredAlignment:16},detail:{vector:'#GP(0)',alignmentBytes:16}}] : []),
    ...(family === 'cmpxchg16b' ? [{kind:'invalid-opcode',condition:{kind:'x86-required-feature-absent',feature:'cx16'},detail:{vector:'#UD',cpuid:'CPUID.01H:ECX.CMPXCHG16B[13]'}}] : []),
  ];
  return ctx.finish({
    family:'atomic',
    possibleFaults:faults,
    metadata:{
      operation:family,
      atomic:locked,
      explicitLockPrefix:locked,
      rmwId:relationshipId,
      sameCanonicalAddress:true,
      implicitRegisterPairs:true,
      expectedPair:family === 'cmpxchg16b' ? 'RDX:RAX' : 'EDX:EAX',
      replacementPair:family === 'cmpxchg16b' ? 'RCX:RBX' : 'ECX:EBX',
      requiredFeature:expected.requiredFeature,
      alignmentBytes:expected.alignment,
      exactWideAtomicClaim:true,
      architecturalWriteCycleRegardlessOfComparison:true,
      address:address.metadata,
      ...lockedMetadata(locked),
    },
  });
}
export function liftX86AtomicEffects(instruction,context = {}) {
  const family = String(instruction?.instructionFamily || '').toLowerCase(), locked = hasLock(instruction);
  if (!ATOMIC_FAMILIES.has(family) && !locked) return null;
  const ctx = createX86EffectContext(instruction,context);
  if (!ATOMIC_FAMILIES.has(family)) return ctx.partial('x86-lock-prefixed-family-not-modelled-in-p5-2',['memory','registers','flags','other'],{metadata:{family:'atomic',operation:family,lockPrefix:true,lockIgnored:false}});
  if (memoryOperands(ctx.operands).length === 0) {
    if (locked) return ctx.partial('x86-lock-prefix-without-memory-operand',['memory','registers','flags','other'],{metadata:{family:'atomic',operation:family,lockPrefix:true,lockIgnored:false}});
    if (family === 'xchg') return liftRegisterXchg(ctx);
    if (family === 'xadd') return liftRegisterXadd(ctx);
    if (family === 'cmpxchg') return liftRegisterCmpxchg(ctx);
    return ctx.partial(`x86-${family}-requires-memory-operand`,['memory','registers','flags'],{metadata:{family:'atomic',operation:family}});
  }
  if (family === 'xchg') return liftXchg(ctx);
  if (family === 'xadd') return liftXadd(ctx);
  if (family === 'cmpxchg') return liftCmpxchg(ctx);
  if (family === 'cmpxchg8b' || family === 'cmpxchg16b') return liftWideCmpxchg(ctx,family);
  return null;
}
