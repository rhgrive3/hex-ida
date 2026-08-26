import { createX86EffectContext, x86MemoryFaults, x86RegisterOperand } from './common.js';
import { x86EffectiveAddressExpression } from './addressing.js';
import { writeX86VectorRegister, x86VectorEncodingInfo } from './simd.js';

const DECODER_SEMANTIC = 'capstone-5-x86-structured-v2';
const CAPSTONE_ABI = 'capstone-5-wasm32-x86-detail/v1';
const EXECUTION_ENV = 'sys:x86.execution-environment';
const INTERRUPTIBILITY_STATE = 'sys:x86.interruptibility-state';
const CET_STATE = 'sys:x86.CET-state';
const SSP_STATE = 'sys:x86.SSP';
const SHADOW_STACK_STATE = 'sys:x86.shadow-stack-state';
const NULL_LONG64_SEGMENT_PREFIXES = new Set([0x26, 0x2e, 0x36, 0x3e]);

function trusted(instruction) {
  return instruction?.detailAvailable === true
    && instruction?.detailStatus === 'complete'
    && instruction?.decoderSemanticVersion === DECODER_SEMANTIC
    && instruction?.detail?.abiContractVersion === CAPSTONE_ABI
    && instruction?.rawBytes instanceof Uint8Array
    && instruction.rawBytes.length === instruction.length
    && Array.isArray(instruction?.detail?.operands);
}

function raw(instruction) { return [...(instruction?.rawBytes || [])]; }
function same(actual, expected) { return actual.length === expected.length && actual.every((v, i) => v === expected[i]); }
function familyOf(instruction) { return String(instruction?.instructionFamily || '').toLowerCase(); }
function gpFault(operation, rule) {
  return Object.freeze({ kind:'general-protection', condition:Object.freeze({ kind:'x86-architectural-precondition', operation, rule }), detail:Object.freeze({ fault:'#GP(0)' }) });
}
function udFault(operation, rule) {
  return Object.freeze({ kind:'undefined-opcode', condition:Object.freeze({ kind:'x86-feature-or-encoding-precondition', operation, rule }), detail:Object.freeze({ fault:'#UD' }) });
}
function cpFault(operation, rule) {
  return Object.freeze({ kind:'control-protection', condition:Object.freeze({ kind:'x86-cet-precondition', operation, rule }), detail:Object.freeze({ fault:'#CP' }) });
}
function fpFault(operation) {
  return Object.freeze({ kind:'x86-simd-floating-point-exception', condition:Object.freeze({ kind:'mxcsr-unmasked-floating-point-exception', operation }), detail:Object.freeze({ exceptionClass:'#XM', environmentContract:'x86-mxcsr/v1' }) });
}

function nullPrefixFixed(instruction, opcode) {
  const bytes = raw(instruction);
  return bytes.length === 2 && NULL_LONG64_SEGMENT_PREFIXES.has(bytes[0]) && bytes[1] === opcode;
}

const SIMPLE_FLAG = Object.freeze({
  clc:Object.freeze({ opcode:0xf8, flag:'CF', value:0 }),
  stc:Object.freeze({ opcode:0xf9, flag:'CF', value:1 }),
  cmc:Object.freeze({ opcode:0xf5, flag:'CF', toggle:true }),
  cld:Object.freeze({ opcode:0xfc, flag:'DF', value:0 }),
  std:Object.freeze({ opcode:0xfd, flag:'DF', value:1 }),
});

function liftNullPrefixFixed(instruction, context, family) {
  const ctx = createX86EffectContext(instruction, context);
  const spec = SIMPLE_FLAG[family];
  if (spec && nullPrefixFixed(instruction, spec.opcode) && ctx.operands.length === 0) {
    const value = spec.toggle
      ? ctx.valueOp('xor', [ctx.readFlag(spec.flag), ctx.constant(1, 1n)], 1, { semantic:`x86-${family}-toggle-${spec.flag}` })
      : ctx.constant(1, BigInt(spec.value));
    ctx.writeFlag(spec.flag, value, { operation:family, ...(spec.toggle ? { toggle:true } : { fixedValue:spec.value }) });
    return ctx.finish({ family:'system', metadata:{ operation:family, long64NullSegmentPrefix:true, flag:spec.flag } });
  }
  if ((family === 'cli' || family === 'sti') && nullPrefixFixed(instruction, family === 'cli' ? 0xfa : 0xfb) && ctx.operands.length === 0) {
    ctx.intrinsic(`x86.system.${family}`, [], [], {
      registersRead:['rflags', EXECUTION_ENV, ...(family === 'sti' ? [INTERRUPTIBILITY_STATE] : [])],
      registersWritten:['rflags', EXECUTION_ENV, ...(family === 'sti' ? [INTERRUPTIBILITY_STATE] : [])],
      determinism:'input-dependent', symbolicDetail:'summary-only',
      metadata:{
        operation:family, exactArchitecturalSummary:true, long64NullSegmentPrefix:true,
        transition:family === 'cli'
          ? 'architectural CLI IF/VIF transition selected by CPL, IOPL, CR4.PVI and virtual-interrupt state'
          : 'architectural STI IF/VIF transition plus the conditional one-instruction interruptibility shadow',
        environmentDependent:true,
      },
    });
    return ctx.finish({ family:'system', possibleFaults:[gpFault(family, 'CPL/IOPL and virtual-interrupt conditions may select #GP(0)')], metadata:{ operation:family, privileged:true, environmentExact:true, long64NullSegmentPrefix:true } });
  }
  if (family === 'hlt' && nullPrefixFixed(instruction, 0xf4) && ctx.operands.length === 0) {
    ctx.intrinsic('x86.system.hlt', [], [], {
      registersRead:[EXECUTION_ENV], registersWritten:[EXECUTION_ENV],
      controlEffects:[{ kind:'fallthrough' }], determinism:'input-dependent', symbolicDetail:'summary-only',
      metadata:{ operation:'hlt', exactArchitecturalSummary:true, executionSuspension:true, long64NullSegmentPrefix:true, environmentDependent:true },
    });
    return ctx.finish({ family:'system', possibleFaults:[gpFault('hlt', 'CPL>0')], metadata:{ operation:'hlt', executionSuspension:true, privileged:true, long64NullSegmentPrefix:true } });
  }
  return null;
}

function liftHintNop(instruction, context) {
  if (familyOf(instruction) !== 'nop') return null;
  const bytes = raw(instruction);
  if (bytes.length < 3 || bytes[0] !== 0x0f || bytes[1] !== 0x19 || ((bytes[2] >>> 3) & 7) !== 0) return null;
  const ctx = createX86EffectContext(instruction, context);
  if (ctx.operands.length !== 1 || !['memory','register'].includes(ctx.operands[0]?.type)) return null;
  return ctx.finish({
    family:'control',
    statePreservation:{ proven:true, reason:'x86-amd-hint-nop-normal-path-preserves-architectural-state' },
    possibleFaults:[udFault('nop', '0F19 /0 is an AMD HINT_NOP encoding and may be reserved/unsupported on other implementations')],
    metadata:{ operation:'nop', hintNopEncoding:'0F19/0', implementationDependentAvailability:true, memoryOperandIsSyntacticOnly:true },
  });
}

function memoryAddress(ctx, operand) {
  if (operand?.type !== 'memory') return null;
  return x86EffectiveAddressExpression(ctx.instruction, operand);
}
function addressRegisters(operand) {
  if (operand?.type !== 'memory') return [];
  return [operand.memory?.base?.physicalId, operand.memory?.index?.physicalId].filter(Boolean);
}

function modrmForm(instruction, prefix, opcode, regField) {
  const bytes = raw(instruction);
  if (bytes.length !== prefix.length + opcode.length + 1) return false;
  if (!same(bytes.slice(0, prefix.length), prefix) || !same(bytes.slice(prefix.length, prefix.length + opcode.length), opcode)) return false;
  const modrm = bytes[bytes.length - 1];
  return (modrm >>> 6) !== 3 && ((modrm >>> 3) & 7) === regField;
}

function liftCacheHint(instruction, context, family) {
  const isCldemote = family === 'cldemote' && modrmForm(instruction, [], [0x0f,0x1c], 0);
  const isPrefetchwt1 = family === 'prefetchwt1' && modrmForm(instruction, [], [0x0f,0x0d], 2);
  if (!isCldemote && !isPrefetchwt1) return null;
  const ctx = createX86EffectContext(instruction, context);
  const operand = ctx.operands[0];
  const address = memoryAddress(ctx, operand);
  if (!address) return null;
  ctx.intrinsic(`x86.hint.${family}`, [], [], {
    registersRead:addressRegisters(operand), registersWritten:[], memoryRead:{ scope:'none' }, memoryWrite:{ scope:'none' },
    determinism:'input-dependent', symbolicDetail:'summary-only',
    metadata:{ operation:family, exactArchitecturalSummary:true, architecturalDataStateMutation:false, addressExpression:address.expression, implementationMayIgnoreHint:true },
  });
  return ctx.finish({ family:'system', possibleFaults:[udFault(family, 'LOCK prefix or architecturally unsupported instruction feature')], metadata:{ operation:family, cacheHintOnly:true, memoryDataAccess:false } });
}

const STRING_IO_WIDTH = Object.freeze({ insb:8, insw:16, insd:32, outsb:8, outsw:16, outsd:32 });
function validStringIoBytes(family, bytes) {
  if (family === 'insb') return same(bytes,[0x6c]);
  if (family === 'insw') return same(bytes,[0x66,0x6d]);
  if (family === 'insd') return same(bytes,[0x6d]);
  if (family === 'outsb') return same(bytes,[0x6e]);
  if (family === 'outsw') return same(bytes,[0x66,0x6f]);
  if (family === 'outsd') return same(bytes,[0x6f]);
  return false;
}
function ioAccess(direction, widthBits) {
  return Object.freeze({ space:'io', addressExpr:Object.freeze({ kind:'x86-io-port-register', register:'dx' }), widthBits, endian:'little' });
}
function liftStringIo(instruction, context, family) {
  const widthBits = STRING_IO_WIDTH[family];
  if (!widthBits || !validStringIoBytes(family, raw(instruction))) return null;
  const ctx = createX86EffectContext(instruction, context);
  const input = family.startsWith('ins');
  const pointerName = input ? 'rdi' : 'rsi';
  const pointerOperand = x86RegisterOperand(pointerName);
  const pointer = ctx.readRegister(pointerOperand);
  const df = ctx.readFlag('DF');
  const dx = ctx.readRegister(x86RegisterOperand('dx'));
  if (!pointer || !df || !dx) return null;
  const address = Object.freeze({ kind:'x86-string-io-address', base:pointerName, segment:input ? 'es' : 'ds', addressSizeBits:64, long64SegmentBaseRule:'ES/DS base treated as zero' });
  const step = ctx.valueOp('x86-string-index-step', [pointer, df], 64, { directionFlag:'DF', deltaBytes:widthBits / 8, base:pointerName });
  const faults = [gpFault(family, 'CPL/IOPL and TSS I/O-permission bitmap may deny the port access')];
  if (input) {
    const [value] = ctx.intrinsic(`x86.io.${family}`, [dx], [widthBits], {
      registersRead:['rdx'], registersWritten:[], memoryRead:{ scope:'accesses', accesses:[ioAccess('read', widthBits)] }, memoryWrite:{ scope:'none' },
      determinism:'nondeterministic', symbolicDetail:'summary-only', metadata:{ operation:family, exactArchitecturalSummary:true, ioPort:'DX' },
    });
    ctx.writeMemory(address, widthBits, value, { space:'memory', metadata:{ stringIo:true, segment:'ES' } });
    faults.push(...x86MemoryFaults('write', widthBits));
  } else {
    const value = ctx.readMemory(address, widthBits, { space:'memory', metadata:{ stringIo:true, segment:'DS' } });
    ctx.intrinsic(`x86.io.${family}`, [dx, value], [], {
      registersRead:['rdx'], registersWritten:[], memoryRead:{ scope:'none' }, memoryWrite:{ scope:'accesses', accesses:[ioAccess('write', widthBits)] },
      determinism:'input-dependent', symbolicDetail:'summary-only', metadata:{ operation:family, exactArchitecturalSummary:true, ioPort:'DX' },
    });
    faults.push(...x86MemoryFaults('read', widthBits));
  }
  ctx.writeRegister(pointerOperand, step);
  return ctx.finish({ family:'system', possibleFaults:faults, metadata:{ operation:family, widthBits, ioPort:'DX', indexRegister:pointerName, directionFlagApplied:true } });
}

function cetMemoryFaults(operation, widthBits, extra = []) {
  return Object.freeze([
    udFault(operation, 'CR4.CET / CET shadow-stack enablement or LOCK-prefix precondition'),
    gpFault(operation, `non-canonical address, privilege, or ${widthBits / 8}-byte alignment precondition`),
    ...extra,
    ...x86MemoryFaults('write', widthBits),
  ]);
}

function liftWrss(instruction, context, family) {
  const spec = {
    wrssd:{ prefix:[], opcode:[0x0f,0x38,0xf6], width:32, user:false },
    wrssq:{ prefix:[0x48], opcode:[0x0f,0x38,0xf6], width:64, user:false },
    wrussd:{ prefix:[0x66], opcode:[0x0f,0x38,0xf5], width:32, user:true },
    wrussq:{ prefix:[0x66,0x48], opcode:[0x0f,0x38,0xf5], width:64, user:true },
  }[family];
  if (!spec) return null;
  const bytes = raw(instruction);
  const expectedPrefixAndOpcode = [...spec.prefix, ...spec.opcode];
  if (bytes.length !== expectedPrefixAndOpcode.length + 1 || !same(bytes.slice(0,-1), expectedPrefixAndOpcode) || (bytes.at(-1) >>> 6) === 3) return null;
  const ctx = createX86EffectContext(instruction, context);
  const [destination, source] = ctx.operands;
  const address = memoryAddress(ctx, destination);
  const value = source?.type === 'register' ? ctx.readRegister(source) : null;
  if (!address || !value) return null;
  ctx.writeMemory(address.expression, spec.width, value, { space:'memory', alignment:spec.width / 8, metadata:{ operation:family, userAccess:spec.user, architecturalShadowStackStore:true } });
  ctx.intrinsic(`x86.cet.${family}`, [value], [], {
    registersRead:[CET_STATE, SHADOW_STACK_STATE, EXECUTION_ENV, ...addressRegisters(destination)],
    registersWritten:[], memoryRead:{ scope:'none' }, memoryWrite:{ scope:'none' }, determinism:'input-dependent', symbolicDetail:'summary-only',
    metadata:{ operation:family, exactArchitecturalSummary:true, cetShadowStackWrite:true, userAccess:spec.user, widthBits:spec.width },
  });
  return ctx.finish({ family:'system', possibleFaults:cetMemoryFaults(family, spec.width), metadata:{ operation:family, cetStateModeled:true, shadowStackWrite:true, widthBits:spec.width, userAccess:spec.user } });
}

function liftRstorssp(instruction, context) {
  if (familyOf(instruction) !== 'rstorssp' || !modrmForm(instruction,[0xf3],[0x0f,0x01],5)) return null;
  const ctx = createX86EffectContext(instruction, context);
  const operand = ctx.operands[0];
  const address = memoryAddress(ctx, operand);
  if (!address) return null;
  const token = ctx.readMemory(address.expression, 64, { space:'memory', alignment:8, atomic:true, metadata:{ operation:'rstorssp', tokenRead:true } });
  const [replacement, cf] = ctx.intrinsic('x86.cet.rstorssp', [token], [64,1], {
    registersRead:[SSP_STATE,CET_STATE,SHADOW_STACK_STATE,EXECUTION_ENV,...addressRegisters(operand)],
    registersWritten:[SSP_STATE,SHADOW_STACK_STATE],
    memoryRead:{ scope:'none' }, memoryWrite:{ scope:'none' }, determinism:'input-dependent', symbolicDetail:'summary-only',
    metadata:{ operation:'rstorssp', exactArchitecturalSummary:true, tokenValidation:true, restoredSsp:'effective-address', previousSspTokenReplacement:true },
  });
  ctx.writeMemory(address.expression,64,replacement,{ space:'memory', alignment:8, atomic:true, metadata:{ operation:'rstorssp', previousSspToken:true } });
  ctx.writeFlag('CF',cf,{ operation:'rstorssp', semantic:'restore-token-alignment-hole' });
  for (const flag of ['ZF','PF','AF','OF','SF']) ctx.writeFlag(flag,ctx.constant(1,0n),{ operation:'rstorssp', fixedValue:0 });
  return ctx.finish({ family:'system', possibleFaults:[udFault('rstorssp','CET shadow stack disabled or LOCK prefix'),gpFault('rstorssp','unaligned or non-canonical address'),cpFault('rstorssp','restore token mode/address validation failure'),...x86MemoryFaults('read',64),...x86MemoryFaults('write',64)], metadata:{ operation:'rstorssp', cetStateModeled:true, shadowStackTokenRmw:true } });
}

function liftClrssbsy(instruction, context) {
  if (familyOf(instruction) !== 'clrssbsy' || !modrmForm(instruction,[0xf3],[0x0f,0xae],6)) return null;
  const ctx = createX86EffectContext(instruction, context);
  const operand = ctx.operands[0];
  const address = memoryAddress(ctx, operand);
  if (!address) return null;
  const token = ctx.readMemory(address.expression,64,{ space:'memory', alignment:8, atomic:true, metadata:{ operation:'clrssbsy', busyTokenRead:true } });
  const [cleared, cf] = ctx.intrinsic('x86.cet.clrssbsy',[token],[64,1],{
    registersRead:[CET_STATE,SHADOW_STACK_STATE,EXECUTION_ENV,...addressRegisters(operand)], registersWritten:[SSP_STATE,SHADOW_STACK_STATE],
    memoryRead:{ scope:'none' }, memoryWrite:{ scope:'none' }, determinism:'input-dependent', symbolicDetail:'summary-only',
    metadata:{ operation:'clrssbsy', exactArchitecturalSummary:true, busyTokenCompareExchange:true, sspAfterSuccess:'0' },
  });
  ctx.writeMemory(address.expression,64,cleared,{ space:'memory', alignment:8, atomic:true, metadata:{ operation:'clrssbsy', clearBusyBit:true } });
  ctx.writeFlag('CF',cf,{ operation:'clrssbsy', semantic:'invalid-busy-token' });
  for (const flag of ['ZF','PF','AF','OF','SF']) ctx.writeFlag(flag,ctx.constant(1,0n),{ operation:'clrssbsy', fixedValue:0 });
  return ctx.finish({ family:'system', possibleFaults:[udFault('clrssbsy','CET shadow stack disabled or LOCK prefix'),gpFault('clrssbsy','CPL>0, invalid token, unaligned or non-canonical address'),...x86MemoryFaults('read',64),...x86MemoryFaults('write',64)], metadata:{ operation:'clrssbsy', cetStateModeled:true, busyTokenRmw:true, sspCleared:true } });
}

function scalarRound(ctx, family, scalarBits, vex) {
  const operands = ctx.operands;
  const destination = operands[0];
  const mergeSource = vex ? operands[1] : destination;
  const source = vex ? operands[2] : operands[1];
  const immediate = vex ? operands[3] : operands[2];
  if (destination?.type !== 'register' || mergeSource?.type !== 'register' || source?.type !== 'memory' || immediate?.type !== 'immediate') return null;
  const address = memoryAddress(ctx, source);
  const merge = ctx.readRegister(mergeSource);
  if (!address || !merge) return null;
  const input = ctx.readMemory(address.expression,scalarBits,{ space:address.space, metadata:{ operation:family, scalarFp:true } });
  const imm = ctx.constant(8, immediate.value);
  const [rounded] = ctx.intrinsic('x86.fp.round-scalar',[input,imm],[scalarBits],{
    registersRead:[mergeSource.register.physicalId], registersWritten:[destination.register.physicalId], determinism:'input-dependent', symbolicDetail:'summary-only',
    metadata:{ operation:family, scalarWidthBits:scalarBits, fpEnvironmentDependency:'MXCSR', immediateRoundingControl:true, exactArchitecturalSummary:true },
  });
  const low128 = ctx.valueOp('insert',[merge,rounded],128,{ lsb:0, widthBits:scalarBits, preserveBits:`127:${scalarBits}`, operation:family });
  const encoding = x86VectorEncodingInfo(ctx.instruction);
  if (!writeX86VectorRegister(ctx,destination,low128,encoding,128)) return null;
  return ctx.finish({ family:'fp', possibleFaults:[...x86MemoryFaults('read',scalarBits),fpFault(family)], metadata:{ operation:family, scalarWidthBits:scalarBits, immediateRoundingControl:true, encodingKind:encoding.kind } });
}

function liftResidualVector(instruction, context, family) {
  const bytes = raw(instruction);
  const ctx = createX86EffectContext(instruction, context);
  if (family === 'roundsd' && same(bytes,[0x66,0x0f,0x3a,0x0a,0x00,0x00])) return scalarRound(ctx,family,64,false);
  if (family === 'roundss' && same(bytes,[0x66,0x0f,0x3a,0x0b,0x00,0x00])) return scalarRound(ctx,family,32,false);
  if (family === 'vroundsd' && same(bytes,[0xc4,0xe3,0x79,0x0a,0x00,0x00])) return scalarRound(ctx,family,64,true);
  if (family === 'vroundss' && same(bytes,[0xc4,0xe3,0x79,0x0b,0x00,0x00])) return scalarRound(ctx,family,32,true);

  if (family === 'vcvtpd2ps' && same(bytes,[0xc5,0xf9,0x5a,0x00])) {
    const [destination, source] = ctx.operands;
    const address = memoryAddress(ctx,source);
    if (!address || destination?.type !== 'register') return null;
    const input = ctx.readMemory(address.expression,128,{ space:address.space, metadata:{ operation:family } });
    const [packed64] = ctx.intrinsic('x86.fp.cvtpd2ps',[input],[64],{ registersWritten:[destination.register.physicalId], determinism:'input-dependent', symbolicDetail:'summary-only', metadata:{ operation:family, fpEnvironmentDependency:'MXCSR', exactArchitecturalSummary:true, sourceElements:2, sourceElementBits:64, destinationElementBits:32 } });
    const low128 = ctx.coerce(packed64,64,128,false);
    const encoding = x86VectorEncodingInfo(ctx.instruction);
    if (!writeX86VectorRegister(ctx,destination,low128,encoding,128)) return null;
    return ctx.finish({ family:'fp', possibleFaults:[...x86MemoryFaults('read',128),fpFault(family)], metadata:{ operation:family, vectorWidthBits:128, encodingKind:'vex', upperXmmBits:'zero' } });
  }

  if ((family === 'vfrczsd' && same(bytes,[0x8f,0xe9,0x78,0x83,0x00])) || (family === 'vfrczss' && same(bytes,[0x8f,0xe9,0x78,0x82,0x00]))) {
    const scalarBits = family.endsWith('sd') ? 64 : 32;
    const [destination, source] = ctx.operands;
    const address = memoryAddress(ctx,source);
    if (!address || destination?.type !== 'register') return null;
    const input = ctx.readMemory(address.expression,scalarBits,{ space:address.space, metadata:{ operation:family, xop:true } });
    const [fraction] = ctx.intrinsic(`x86.xop.${family}`,[input],[scalarBits],{ registersWritten:[destination.register.physicalId], determinism:'input-dependent', symbolicDetail:'summary-only', metadata:{ operation:family, fpEnvironmentDependency:'MXCSR', exactArchitecturalSummary:true, fractionalPart:true, xop:true } });
    const physical = x86RegisterOperand(destination.register.physicalId);
    if (!physical || !ctx.writeRegister(physical,ctx.coerce(fraction,scalarBits,256,false))) return null;
    return ctx.finish({ family:'fp', possibleFaults:[udFault(family,'XOP feature unavailable'),...x86MemoryFaults('read',scalarBits),fpFault(family)], metadata:{ operation:family, xop:true, scalarWidthBits:scalarBits, upperDestinationBits:'zero-through-255' } });
  }

  if (family === 'vbroadcasti128' && same(bytes,[0xc4,0xe2,0x7d,0x5a,0x00])) {
    const [destination, source] = ctx.operands;
    const address = memoryAddress(ctx,source);
    if (!address || destination?.type !== 'register') return null;
    const input = ctx.readMemory(address.expression,128,{ space:address.space, metadata:{ operation:family } });
    const [broadcast] = ctx.intrinsic('x86.simd.broadcasti128',[input],[256],{ registersWritten:[destination.register.physicalId], determinism:'input-dependent', symbolicDetail:'summary-only', metadata:{ operation:family, exactArchitecturalSummary:true, lanes:2, sourceWidthBits:128, destinationWidthBits:256 } });
    if (!ctx.writeRegister(destination,broadcast)) return null;
    return ctx.finish({ family:'simd', possibleFaults:[udFault(family,'AVX2 feature unavailable'),...x86MemoryFaults('read',128)], metadata:{ operation:family, vectorWidthBits:256, broadcast128ToBothHalves:true } });
  }
  return null;
}

export function dispatchX86TerminalResidualEffects(instruction, context = {}) {
  if (!trusted(instruction)) return null;
  const family = familyOf(instruction);

  const fixed = liftNullPrefixFixed(instruction, context, family);
  if (fixed) return Object.freeze({ ownerId:'system', result:fixed });
  const nop = liftHintNop(instruction, context);
  if (nop) return Object.freeze({ ownerId:'control', result:nop });
  const hint = liftCacheHint(instruction, context, family);
  if (hint) return Object.freeze({ ownerId:'system', result:hint });
  const stringIo = liftStringIo(instruction, context, family);
  if (stringIo) return Object.freeze({ ownerId:'system', result:stringIo });
  const wrss = liftWrss(instruction, context, family);
  if (wrss) return Object.freeze({ ownerId:'system', result:wrss });
  const rstorssp = liftRstorssp(instruction, context);
  if (rstorssp) return Object.freeze({ ownerId:'system', result:rstorssp });
  const clrssbsy = liftClrssbsy(instruction, context);
  if (clrssbsy) return Object.freeze({ ownerId:'system', result:clrssbsy });
  const vector = liftResidualVector(instruction, context, family);
  if (vector) return Object.freeze({ ownerId:family === 'vbroadcasti128' ? 'simd' : 'fp', result:vector });
  return null;
}
