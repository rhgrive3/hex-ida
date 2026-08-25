import {
  createBitVectorValue,
  createIntrinsicEffectSummary,
  createMachineEffectBundle,
  createMachineOperation,
  createMemoryAccess,
} from '../../../../semantics/effects/index.js';
import {
  Arm64AddressingError,
  arm64AddressOffset,
  arm64ConstantExpr,
  arm64RegisterOperand,
  arm64Temporary,
  buildArm64EffectiveAddress,
  createArm64RegisterRead,
  createArm64RegisterWrite,
} from './addressing.js';
import { ARM64_ATOMIC_EFFECT_MNEMONICS, isArm64AtomicInstruction, liftArm64AtomicEffects } from './atomic.js';
import { arm64DecodedEncodingWord } from '../encoding-word.js';

export const LEGACY_ARM64_MEMORY_INVENTORY = Object.freeze({
  loads: Object.freeze(['ldr','ldrb','ldrh','ldrsb','ldrsh','ldrsw','ldur','ldurb','ldurh','ldursb','ldursh','ldursw','ldp','ldpsw','ldnp','ldar','ldarb','ldarh','ldxr','ldaxr','ldtr']),
  stores: Object.freeze(['str','strb','strh','stur','sturb','sturh','stp','stnp','stlr','stlrb','stlrh','sttr','stxr','stlxr']),
  atomicHandlers: Object.freeze(['cas','casa','casl','casal','swp','swpa','swpl','swpal','ldadd','ldadda','ldaddl','ldaddal','ldset','ldclr','ldeor']),
  barriersAndHints: Object.freeze(['dmb','dsb','isb','clrex','prfm','prfum']),
  simdMemoryDeferred: Object.freeze(['ld1','ld2','ld3','ld4','st1','st2','st3','st4']),
});

const SIMPLE_LOADS = new Set(['ldr','ldrb','ldrh','ldrsb','ldrsh','ldrsw','ldur','ldurb','ldurh','ldursb','ldursh','ldursw','ldtr','ldar','ldarb','ldarh']);
const SIMPLE_STORES = new Set(['str','strb','strh','stur','sturb','sturh','sttr','stlr','stlrb','stlrh']);
const PAIR_LOADS = new Set(['ldp','ldnp','ldpsw']);
const PAIR_STORES = new Set(['stp','stnp']);
const PREFETCH_MNEMONICS = new Set(['prfm','prfum']);
const NON_ATOMIC_MEMORY_MNEMONICS = Object.freeze([...SIMPLE_LOADS, ...SIMPLE_STORES, ...PAIR_LOADS, ...PAIR_STORES, ...PREFETCH_MNEMONICS]);
const ALL_NON_ATOMIC = new Set(NON_ATOMIC_MEMORY_MNEMONICS);
export const ARM64_MEMORY_EFFECT_MNEMONICS = Object.freeze([...NON_ATOMIC_MEMORY_MNEMONICS, ...ARM64_ATOMIC_EFFECT_MNEMONICS]);
const SIGNED_LOADS = new Set(['ldrsb','ldrsh','ldrsw','ldursb','ldursh','ldursw','ldpsw']);
const ACQUIRE_LOADS = new Set(['ldar','ldarb','ldarh']);
const RELEASE_STORES = new Set(['stlr','stlrb','stlrh']);
const BASE_ONLY = new Set([...ACQUIRE_LOADS, ...RELEASE_STORES]);
const UNSCALED_ONLY = /^(?:ldur|stur|ldtr|sttr)/;
const NON_TEMPORAL_PAIR = new Set(['ldnp','stnp']);
const UNPRIVILEGED = new Set(['ldtr','sttr']);
const LEGACY_UNSCALED_ALIASES = new Set(['ldr','str','ldrb','strb','ldrh','strh','ldrsb','ldrsh','ldrsw']);

const WIDTH_OVERRIDE = Object.freeze({
  ldrb:8, ldrsb:8, ldurb:8, ldursb:8, ldarb:8,
  strb:8, sturb:8, stlrb:8,
  ldrh:16, ldrsh:16, ldurh:16, ldursh:16, ldarh:16,
  strh:16, sturh:16, stlrh:16,
  ldrsw:32, ldursw:32, ldpsw:32,
});

function mnemonicOf(decoded) { return String(decoded?.mnemonic || '').trim().toLowerCase(); }
function contextOf(decoded, context = {}) {
  const instructionId = String(context.instructionId || decoded?.instructionId || '').trim();
  if (!instructionId) throw new TypeError('arm64-machine-effects-instruction-id-required');
  return {
    instructionId,
    architectureId: String(context.architectureId || decoded?.architectureId || 'arm64'),
    mode: String(context.mode || decoded?.mode || 'a64'),
    dataEndianness: String(context.dataEndianness || decoded?.dataEndianness || context.endian || decoded?.endian || 'little'),
    origin: context.origin || decoded?.origin || { instructionIds:[instructionId] },
    options: context.options || {},
  };
}

function bundle(decoded, context, body) {
  const ctx = contextOf(decoded, context);
  return createMachineEffectBundle({
    instructionId:ctx.instructionId,
    architectureId:ctx.architectureId,
    mode:ctx.mode,
    operations:body.operations || [],
    controlEffect:body.controlEffect || { kind:'fallthrough' },
    possibleFaults:body.possibleFaults || [],
    origin:ctx.origin,
    completeness:body.completeness || 'exact',
    ...(body.unknownEffects ? { unknownEffects:body.unknownEffects } : {}),
    ...(body.metadata ? { metadata:body.metadata } : {}),
  }, ctx.options);
}

function partial(decoded, context, reason, categories = ['memory','registers','faults']) {
  return bundle(decoded, context, {
    completeness:'partial',
    operations:[],
    unknownEffects:{ categories, reason },
    metadata:{ family:'arm64-memory', unsupported:true, mnemonic:mnemonicOf(decoded) },
  });
}

function operands(decoded) {
  return Array.isArray(decoded?.ops) ? decoded.ops : Array.isArray(decoded?.operands) ? decoded.operands : [];
}
function dataRegisters(decoded) { return operands(decoded).map((operand) => arm64RegisterOperand(operand)).filter(Boolean); }
function memoryOperand(decoded) { return operands(decoded).find((operand) => operand?.k === 'mem' || operand?.kind === 'memory') || null; }
function immediateOperand(decoded) { return operands(decoded).find((operand, index) => index > 0 && (operand?.k === 'imm' || operand?.kind === 'immediate')) || null; }
function immediateValue(operand) {
  const value = operand?.value;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^-?(?:0x[0-9a-f]+|\d+)$/i.test(value)) return BigInt(value);
  return null;
}

function memoryWidthBits(mnemonic, reg) {
  if (WIDTH_OVERRIDE[mnemonic]) return WIDTH_OVERRIDE[mnemonic];
  if (!reg) return null;
  return Number(reg.bits || 0) || null;
}
function accessAlignment(mnemonic, widthBits) {
  if (ACQUIRE_LOADS.has(mnemonic) || RELEASE_STORES.has(mnemonic)) return Math.max(1, widthBits / 8);
  return undefined;
}
function accessFor({ ctx, addressExpr, widthBits, atomic = null, ordering = null, alignment = null, volatility = null }) {
  const input = { space:'memory', addressExpr, widthBits, endian:ctx.dataEndianness };
  if (alignment) input.alignment = alignment;
  if (typeof atomic === 'boolean') input.atomic = atomic;
  if (ordering) input.ordering = ordering;
  if (typeof volatility === 'boolean') input.volatility = volatility;
  return createMemoryAccess(input, ctx.options);
}

function isTagChecked(addressing) {
  return addressing?.base?.kind !== 'sp' || addressing?.mode !== 'offset';
}
function possibleFaults(direction, { alignment = null, addressExpr = null, accessIndex = 0, tagChecked = false } = {}) {
  const causes = ['address-size','translation','access-flag','permission','external'];
  if (tagChecked) causes.push('tag-check');
  const faults = [{
    kind:'data-abort',
    condition:{ kind:'memory-access-fault', access:direction, accessIndex },
    detail:{ causes, tagChecked, ...(addressExpr ? { addressExpr } : {}) },
  }];
  if (alignment && alignment > 1) {
    faults.push({
      kind:'alignment-fault',
      condition:{ kind:'misaligned', alignment, accessIndex },
      detail:{ access:direction, alignment },
    });
  }
  return faults;
}
function stackPointerAlignmentFault(addressing, accessIndex = 0) {
  if (addressing?.base?.kind !== 'sp') return [];
  return [{
    kind:'stack-pointer-alignment-fault',
    condition:{ kind:'sp-misaligned', alignment:16, accessIndex },
    detail:{ baseRegister:'sp', architecturalCheck:'CheckSPAlignment' },
  }];
}

function zeroConstant(widthBits) { return createBitVectorValue(widthBits, 0n); }
function normalizedDataRegister(regInput) {
  if (regInput && typeof regInput === 'object' && typeof regInput.kind === 'string'
      && Number.isInteger(Number(regInput.bits)) && (typeof regInput.physicalId === 'string' || regInput.zero === true)) {
    return regInput;
  }
  return arm64RegisterOperand(regInput);
}
function valueOp(opcode, input, fromBits, toBits, id, metadata = {}) {
  const output = arm64Temporary(id, toBits);
  return {
    output,
    operation:createMachineOperation({
      kind:'value', opcode, inputs:[input], outputs:[output],
      metadata:{ architecture:'arm64', fromBits, toBits, ...metadata },
    }),
  };
}

function loadedValueToRegister(regInput, rawValue, memoryBits, { signed = false, idPrefix = 'load' } = {}) {
  const reg = normalizedDataRegister(regInput);
  if (!reg) throw new TypeError('arm64-load-destination-register-required');
  if (reg.zero) return { operations:[], discarded:true };
  if (reg.kind === 'sp') throw new TypeError('arm64-load-to-sp-unsupported');

  const operations = [];
  let value = rawValue;
  const viewBits = Number(reg.bits);
  if (memoryBits > viewBits) throw new TypeError('arm64-load-width-exceeds-destination-view');
  if (memoryBits < viewBits) {
    const ext = valueOp(signed ? 'sign-extend' : 'zero-extend', value, memoryBits, viewBits, `${idPrefix}.view`, { signed });
    operations.push(ext.operation);
    value = ext.output;
  }

  if (reg.kind === 'gp') {
    if (![32,64].includes(viewBits)) throw new TypeError('arm64-invalid-gp-load-width');
    if (viewBits === 32) {
      const ext = valueOp('zero-extend', value, 32, 64, `${idPrefix}.physical`, { writePolicy:'zero-upper-32' });
      operations.push(ext.operation);
      value = ext.output;
    }
    operations.push(createArm64RegisterWrite(reg, value, {
      physicalWidth:64,
      metadata:{ purpose:'memory-load', writePolicy:viewBits === 32 ? 'zero-upper-32' : 'full-width' },
    }));
    return { operations, discarded:false };
  }

  if (reg.kind === 'vector') {
    if (viewBits < 128) {
      const ext = valueOp('zero-extend', value, viewBits, 128, `${idPrefix}.physical`, { writePolicy:'zero-upper-vector-bits' });
      operations.push(ext.operation);
      value = ext.output;
    }
    operations.push(createArm64RegisterWrite(reg, value, {
      physicalWidth:128,
      metadata:{ purpose:'memory-load', writePolicy:viewBits < 128 ? 'zero-upper-vector-bits' : 'full-width' },
    }));
    return { operations, discarded:false };
  }
  throw new TypeError('arm64-unsupported-load-register-class');
}

function storeValueFromRegister(regInput, widthBits, idPrefix) {
  const reg = normalizedDataRegister(regInput);
  if (!reg) throw new TypeError('arm64-store-source-register-required');
  if (reg.zero) return { operations:[], value:zeroConstant(widthBits) };
  if (reg.kind === 'sp') throw new TypeError('arm64-store-from-sp-unsupported');
  if (widthBits > reg.bits) throw new TypeError('arm64-store-width-exceeds-source-view');

  // A W source is a low-32 view of the same 64-bit physical X register. Read
  // the physical cell at storage width and project the architectural view with
  // an explicit truncation, matching the integer-effects path and W writes.
  // This keeps generic SSA architecture-neutral and prevents parallel 32/64
  // state variants for one physical GP register.
  const physicalBits = reg.kind === 'gp' && reg.bits === 32 ? 64 : reg.bits;
  const read = createArm64RegisterRead(reg, `${idPrefix}.source`, physicalBits);
  const operations = [read.operation];
  let value = read.value;
  let valueBits = physicalBits;
  if (valueBits !== reg.bits) {
    const view = valueOp('truncate', value, valueBits, reg.bits, `${idPrefix}.view`, {
      purpose:'memory-store-register-view',
      reason:'a64-w-register-read-is-low-32-of-physical-x',
    });
    operations.push(view.operation);
    value = view.output;
    valueBits = reg.bits;
  }
  if (widthBits < valueBits) {
    const trunc = valueOp('truncate', value, valueBits, widthBits, `${idPrefix}.truncated`, { purpose:'memory-store-width' });
    operations.push(trunc.operation);
    value = trunc.output;
  }
  return { operations, value };
}

function overlapIsConstrained(addressing, regs) {
  if (addressing.mode === 'offset') return false;
  return regs.some((operand) => {
    const reg = arm64RegisterOperand(operand);
    return reg && !reg.zero && reg.physicalId === addressing.base.physicalId;
  });
}
function displacement(addressing, field) {
  const raw = addressing?.metadata?.[field];
  return raw == null ? null : BigInt(raw);
}
function zeroDisplacement(addressing) {
  const value = displacement(addressing, 'addressDisplacement');
  return value == null || value === 0n;
}
function isGp(reg, bits = null) {
  return !!reg && (reg.kind === 'gp' || reg.zero === true || reg.kind === 'zero') && (bits == null || Number(reg.bits) === bits);
}
function isVector(reg, widths = [8,16,32,64,128]) {
  return reg?.kind === 'vector' && widths.includes(Number(reg.bits));
}
function validSingleDataRegister(mnemonic, reg) {
  if (['ldr','str','ldur','stur'].includes(mnemonic)) return isGp(reg) && [32,64].includes(Number(reg.bits)) || isVector(reg);
  if (['ldrb','ldrh','ldurb','ldurh','strb','strh','sturb','sturh','ldarb','ldarh','stlrb','stlrh'].includes(mnemonic)) return isGp(reg, 32);
  if (['ldrsb','ldrsh','ldursb','ldursh'].includes(mnemonic)) return isGp(reg) && [32,64].includes(Number(reg.bits));
  if (['ldrsw','ldursw'].includes(mnemonic)) return isGp(reg, 64);
  if (['ldar','stlr','ldtr','sttr'].includes(mnemonic)) return isGp(reg) && [32,64].includes(Number(reg.bits));
  return false;
}
function validPairRegisters(mnemonic, regs) {
  if (mnemonic === 'ldpsw') return regs.every((reg) => isGp(reg, 64));
  const [left, right] = regs;
  if (isGp(left) && isGp(right)) return [32,64].includes(Number(left.bits)) && left.bits === right.bits;
  if (isVector(left) && isVector(right)) return [32,64,128].includes(Number(left.bits)) && left.bits === right.bits;
  return false;
}
function isSignedImmediate(value, bits) {
  const minimum = -(1n << BigInt(bits - 1));
  const maximum = (1n << BigInt(bits - 1)) - 1n;
  return value >= minimum && value <= maximum;
}
function isLegacyAssemblyMemoryRecord(decoded) {
  return Number.isInteger(decoded?.row)
    && typeof decoded?.operands === 'string'
    && decoded?.memory != null;
}
function isLegacyTextMemoryRecord(decoded) {
  return decoded?.parseError === null && isLegacyAssemblyMemoryRecord(decoded);
}
function isLegacyUnscaledAlias(decoded, mnemonic, addressing) {
  if (!LEGACY_UNSCALED_ALIASES.has(mnemonic) || addressing.mode !== 'offset' || addressing.index) return false;
  const addressDisp = displacement(addressing, 'addressDisplacement') ?? 0n;
  if (!isSignedImmediate(addressDisp, 9)) return false;
  // buildSemanticModel's legacy text surface accepts assembler aliases such as
  // `ldr x0, [x1, #-8]`; LLVM assembles those bytes as LDUR/STUR. Preserve
  // that compatibility surface without treating the same impossible structured
  // decoder record as an exact LDR/STR encoding.
  return isLegacyTextMemoryRecord(decoded);
}
function isLegacyAbstractUnscaledForm(decoded, mnemonic, addressing) {
  if (!UNSCALED_ONLY.test(mnemonic) || addressing.mode !== 'offset' || addressing.index) return false;
  if (displacement(addressing, 'writebackDisplacement') != null) return false;
  // Legacy semantic-model rows are already-decoded abstract instructions. Some
  // historical fixtures use frame-relative LDUR/STUR displacements wider than
  // the physical imm9 encoding while preserving an exact abstract address.
  // Keep only that text-model compatibility; decoder-origin structured records
  // still have to satisfy the real A64 encoding range above.
  return isLegacyTextMemoryRecord(decoded);
}
function validateSimpleAddressing(mnemonic, addressing, widthBits) {
  const addressDisp = displacement(addressing, 'addressDisplacement') ?? 0n;
  const writebackDisp = displacement(addressing, 'writebackDisplacement');
  if (BASE_ONLY.has(mnemonic)) {
    if (addressing.mode !== 'offset' || addressing.index || addressDisp !== 0n || writebackDisp != null) return `${mnemonic} requires base-only addressing`;
    return null;
  }
  if (UNSCALED_ONLY.test(mnemonic)) {
    if (addressing.mode !== 'offset' || addressing.index || writebackDisp != null || !isSignedImmediate(addressDisp, 9)) return `${mnemonic} requires an imm9 unscaled offset without writeback`;
    return null;
  }
  if (addressing.index) {
    if (addressing.mode !== 'offset' || addressDisp !== 0n || writebackDisp != null) return `${mnemonic} register-offset addressing cannot write back or carry an immediate`;
    return null;
  }
  if (addressing.mode === 'offset') {
    const scale = BigInt(widthBits / 8);
    if (addressDisp < 0n || addressDisp > 4095n * scale || addressDisp % scale !== 0n) return `${mnemonic} unsigned offset is outside the scaled imm12 encoding`;
    return null;
  }
  if (addressing.mode === 'pre') {
    if (writebackDisp == null || addressDisp !== writebackDisp || !isSignedImmediate(addressDisp, 9)) return `${mnemonic} pre-index requires one signed imm9 displacement`;
    return null;
  }
  if (addressing.mode === 'post') {
    if (addressDisp !== 0n || writebackDisp == null || !isSignedImmediate(writebackDisp, 9)) return `${mnemonic} post-index requires one signed imm9 writeback displacement`;
    return null;
  }
  return `${mnemonic} addressing mode is unsupported`;
}
function validatePairAddressing(mnemonic, addressing, widthBits) {
  if (addressing.index) return `${mnemonic} does not support register-offset addressing`;
  if (NON_TEMPORAL_PAIR.has(mnemonic) && addressing.mode !== 'offset') return `${mnemonic} does not support writeback addressing`;
  const addressDisp = displacement(addressing, 'addressDisplacement') ?? 0n;
  const writebackDisp = displacement(addressing, 'writebackDisplacement');
  const encodedDisp = addressing.mode === 'post' ? writebackDisp : addressDisp;
  const scale = BigInt(widthBits / 8);
  if (encodedDisp == null || encodedDisp % scale !== 0n || encodedDisp < -64n * scale || encodedDisp > 63n * scale) return `${mnemonic} displacement is outside the scaled imm7 encoding`;
  if (addressing.mode === 'pre' && writebackDisp !== addressDisp) return `${mnemonic} pre-index displacement and writeback must match`;
  if (addressing.mode === 'post' && addressDisp !== 0n) return `${mnemonic} post-index access must use the unmodified base`;
  if (addressing.mode === 'offset' && writebackDisp != null) return `${mnemonic} offset addressing cannot write back`;
  return null;
}
function hasOperandShape(decoded, shape) {
  const ops = operands(decoded);
  if (ops.length !== shape.length) return false;
  return shape.every((kind, index) => {
    const operand = ops[index];
    if (kind === 'reg') return !!arm64RegisterOperand(operand);
    if (kind === 'mem') return operand?.k === 'mem' || operand?.kind === 'memory';
    if (kind === 'imm') return operand?.k === 'imm' || operand?.kind === 'immediate';
    return false;
  });
}

function simpleMemory(decoded, context, mnemonic, isLoad) {
  const ctx = contextOf(decoded, context);
  if (!hasOperandShape(decoded, ['reg','mem'])) return partial(decoded, context, 'memory instruction operand shape is invalid');
  const reg = dataRegisters(decoded)[0];
  if (!reg) return partial(decoded, context, 'memory instruction data register is missing');
  if (!validSingleDataRegister(mnemonic, reg)) return partial(decoded, context, `${mnemonic} data register class or width is invalid`);
  if (reg.zero && isLegacyAssemblyMemoryRecord(decoded)) {
    return partial(decoded, context, 'legacy assembly zero-register memory access preserves the compatibility decompiler denominator');
  }
  const widthBits = memoryWidthBits(mnemonic, reg);
  if (![8,16,32,64,128].includes(widthBits)) return partial(decoded, context, 'unsupported memory transfer width');
  if ((mnemonic === 'ldrsw' || mnemonic === 'ldursw') && (!isGp(reg, 64))) return partial(decoded, context, `${mnemonic} requires an X/XZR destination register`);

  let addressing;
  try { addressing = buildArm64EffectiveAddress(decoded, { prefix:'addr', accessWidthBits:widthBits }); }
  catch (error) {
    if (error instanceof Arm64AddressingError) return partial(decoded, context, error.code);
    throw error;
  }
  const addressError = validateSimpleAddressing(mnemonic, addressing, widthBits);
  const legacyUnscaledAlias = !!addressError && isLegacyUnscaledAlias(decoded, mnemonic, addressing);
  const legacyAbstractUnscaled = !!addressError && isLegacyAbstractUnscaledForm(decoded, mnemonic, addressing);
  if (addressError && !legacyUnscaledAlias && !legacyAbstractUnscaled) return partial(decoded, context, addressError);
  if (overlapIsConstrained(addressing, [reg])) return partial(decoded, context, 'writeback overlaps data register and is constrained-unpredictable');
  const compatibilityEncodingAlias = legacyUnscaledAlias ? 'unscaled' : legacyAbstractUnscaled ? 'abstract-unscaled' : null;
  const addressingMetadata = legacyUnscaledAlias
    ? Object.freeze({ ...addressing.metadata, encoding:'legacy-unscaled-alias' })
    : legacyAbstractUnscaled
      ? Object.freeze({ ...addressing.metadata, encoding:'legacy-abstract-unscaled' })
      : addressing.metadata;

  const signed = isLoad && SIGNED_LOADS.has(mnemonic);
  const atomic = BASE_ONLY.has(mnemonic) ? true : null;
  const ordering = ACQUIRE_LOADS.has(mnemonic) ? 'acquire' : RELEASE_STORES.has(mnemonic) ? 'release' : null;
  const alignment = accessAlignment(mnemonic, widthBits);
  const access = accessFor({ ctx, addressExpr:addressing.addressExpr, widthBits, atomic, ordering, alignment });
  const operations = [...addressing.readOperations];
  const faults = [
    ...stackPointerAlignmentFault(addressing, 0),
    ...possibleFaults(isLoad?'read':'write', { alignment, addressExpr:addressing.addressExpr, tagChecked:isTagChecked(addressing) }),
  ];
  const accessMetadata = {
    architecture:'arm64', mnemonic, signed, addressing:addressingMetadata, accessIndex:0,
    ...(UNPRIVILEGED.has(mnemonic) ? { unprivileged:true } : {}),
  };

  if (isLoad) {
    const raw = arm64Temporary('load.raw.0', widthBits);
    operations.push(createMachineOperation({ kind:'memory-read', access, value:raw, metadata:accessMetadata }));
    try {
      const write = loadedValueToRegister(reg, raw, widthBits, { signed, idPrefix:'load.0' });
      operations.push(...write.operations);
    } catch (error) { return partial(decoded, context, error.message || 'unsupported load destination'); }
  } else {
    let source;
    try { source = storeValueFromRegister(reg, widthBits, 'store.0'); }
    catch (error) { return partial(decoded, context, error.message || 'unsupported store source'); }
    operations.push(...source.operations);
    operations.push(createMachineOperation({ kind:'memory-write', access, value:source.value, metadata:accessMetadata }));
  }

  if (addressing.mode !== 'offset') operations.push(...addressing.writebackOperations);
  return bundle(decoded, context, {
    operations,
    possibleFaults:faults,
    metadata:{
      family:'arm64-memory', mnemonic, transfer:'single', widthBits, signed,
      addressing:addressingMetadata,
      ...(compatibilityEncodingAlias ? { compatibilityEncodingAlias } : {}),
      ...(atomic === true ? { atomic:true } : {}),
      ...(ordering ? { ordering } : {}),
      ...(UNPRIVILEGED.has(mnemonic) ? { unprivileged:true } : {}),
    },
  });
}

function pairMemory(decoded, context, mnemonic, isLoad) {
  const ctx = contextOf(decoded, context);
  if (!hasOperandShape(decoded, ['reg','reg','mem'])) return partial(decoded, context, 'pair memory instruction operand shape is invalid');
  const regs = dataRegisters(decoded).slice(0, 2);
  if (regs.length !== 2) return partial(decoded, context, 'pair memory instruction requires two data registers');
  if (!validPairRegisters(mnemonic, regs)) return partial(decoded, context, `${mnemonic} pair register classes or widths are invalid`);
  const widthBits = mnemonic === 'ldpsw' ? 32 : memoryWidthBits(mnemonic, regs[0]);
  const secondWidth = mnemonic === 'ldpsw' ? 32 : memoryWidthBits(mnemonic, regs[1]);
  if (!widthBits || widthBits !== secondWidth || ![32,64,128].includes(widthBits)) return partial(decoded, context, 'unsupported or mismatched pair widths');
  if (mnemonic === 'ldpsw' && regs.some((reg) => !isGp(reg, 64))) return partial(decoded, context, 'ldpsw requires two X/XZR destination registers');
  if (isLoad && !regs[0].zero && !regs[1].zero && regs[0].physicalId === regs[1].physicalId) return partial(decoded, context, 'pair load destinations overlap and are constrained-unpredictable');

  let addressing;
  try { addressing = buildArm64EffectiveAddress(decoded, { prefix:'addr', accessWidthBits:widthBits }); }
  catch (error) {
    if (error instanceof Arm64AddressingError) return partial(decoded, context, error.code);
    throw error;
  }
  const addressError = validatePairAddressing(mnemonic, addressing, widthBits);
  if (addressError) return partial(decoded, context, addressError);
  if (overlapIsConstrained(addressing, regs)) return partial(decoded, context, 'pair writeback overlaps data register and is constrained-unpredictable');

  const strideBytes = widthBits / 8;
  const signed = mnemonic === 'ldpsw';
  const nonTemporal = NON_TEMPORAL_PAIR.has(mnemonic);
  const operations = [...addressing.readOperations];
  const faults = [...stackPointerAlignmentFault(addressing, 0)];
  for (let i = 0; i < 2; i++) {
    const addressExpr = arm64AddressOffset(addressing.addressExpr, BigInt(i * strideBytes));
    const access = accessFor({ ctx, addressExpr, widthBits });
    faults.push(...possibleFaults(isLoad?'read':'write', { addressExpr, accessIndex:i, tagChecked:isTagChecked(addressing) }));
    const metadata = {
      architecture:'arm64', mnemonic, pair:true, pairIndex:i, pairStrideBytes:strideBytes,
      accessOrder:i, signed, addressing:addressing.metadata, ...(nonTemporal ? { nonTemporal:true } : {}),
    };
    if (isLoad) {
      const raw = arm64Temporary(`load.raw.${i}`, widthBits);
      operations.push(createMachineOperation({ kind:'memory-read', access, value:raw, metadata }));
      try {
        const write = loadedValueToRegister(regs[i], raw, widthBits, { signed, idPrefix:`load.${i}` });
        operations.push(...write.operations);
      } catch (error) { return partial(decoded, context, error.message || 'unsupported pair load destination'); }
    } else {
      let source;
      try { source = storeValueFromRegister(regs[i], widthBits, `store.${i}`); }
      catch (error) { return partial(decoded, context, error.message || 'unsupported pair store source'); }
      operations.push(...source.operations);
      operations.push(createMachineOperation({ kind:'memory-write', access, value:source.value, metadata }));
    }
  }

  if (addressing.mode !== 'offset') operations.push(...addressing.writebackOperations);
  return bundle(decoded, context, {
    operations,
    possibleFaults:faults,
    metadata:{ family:'arm64-memory', mnemonic, transfer:'pair', elementWidthBits:widthBits, pairStrideBytes:strideBytes, signed, addressing:addressing.metadata, ...(nonTemporal ? { nonTemporal:true } : {}) },
  });
}

function literalLoad(decoded, context, mnemonic) {
  const ctx = contextOf(decoded, context);
  if (!hasOperandShape(decoded, ['reg','imm'])) return partial(decoded, context, 'literal load operand shape is invalid');
  const reg = dataRegisters(decoded)[0];
  if (!reg) return partial(decoded, context, 'literal load destination register is missing');
  if (mnemonic === 'ldrsw' ? !isGp(reg, 64) : !(isGp(reg) && [32,64].includes(Number(reg.bits)) || isVector(reg, [32,64,128]))) return partial(decoded, context, `${mnemonic} literal destination class or width is invalid`);
  const immediate = immediateValue(immediateOperand(decoded));
  let target = decoded?.pcRelTarget ?? decoded?.literalTarget ?? immediate;
  if (typeof target === 'number' && Number.isSafeInteger(target)) target = BigInt(target);
  if (typeof target === 'string' && /^-?(?:0x[0-9a-f]+|\d+)$/i.test(target)) target = BigInt(target);
  if (typeof target !== 'bigint') return partial(decoded, context, 'literal load target is unresolved');

  const widthBits = memoryWidthBits(mnemonic, reg);
  if (![32,64,128].includes(widthBits)) return partial(decoded, context, 'unsupported literal load width');
  if (mnemonic === 'ldrsw' && !isGp(reg, 64)) return partial(decoded, context, 'literal ldrsw requires an X/XZR destination register');
  const signed = SIGNED_LOADS.has(mnemonic);
  const addressExpr = arm64ConstantExpr(target, 64);
  const access = accessFor({ ctx, addressExpr, widthBits });
  const raw = arm64Temporary('load.literal.raw', widthBits);
  const operations = [createMachineOperation({
    kind:'memory-read', access, value:raw,
    metadata:{ architecture:'arm64', mnemonic, literal:true, signed, target:target.toString(), tagChecked:false },
  })];
  try {
    const write = loadedValueToRegister(reg, raw, widthBits, { signed, idPrefix:'load.literal' });
    operations.push(...write.operations);
  } catch (error) { return partial(decoded, context, error.message || 'unsupported literal load destination'); }
  return bundle(decoded, context, {
    operations,
    possibleFaults:possibleFaults('read', { addressExpr, tagChecked:false }),
    metadata:{ family:'arm64-memory', mnemonic, transfer:'literal', widthBits, signed, target:target.toString() },
  });
}

// PRFM/PRFUM carry a 5-bit prfop field: the 18 architecturally named values are
// a finite (type, target, policy) product, and the remaining 14 encodings are
// valid but unnamed. The deployed disassembler prints nothing at all for the
// unnamed ones, so they are recovered from Rt of the encoding word — the same
// word the decoder itself consumed. With no word available the form stays
// fail-closed rather than inventing a prfop.
const PREFETCH_TYPES = Object.freeze({ ld:'prefetch-for-load', li:'preload-instruction', st:'prefetch-for-store' });
const PREFETCH_TYPE_BY_CODE = Object.freeze(['prefetch-for-load','preload-instruction','prefetch-for-store']);
const PREFETCH_POLICIES = Object.freeze({ keep:'temporal-keep', strm:'streaming-non-temporal' });
const PREFETCH_NAMED_RE = /^p(ld|li|st)l([123])(keep|strm)$/;

function prefetchOperationFromCode(code) {
  const type = (code >>> 3) & 0x3;
  const target = (code >>> 1) & 0x3;
  const policy = code & 0x1;
  const named = type < 3 && target < 3;
  if (!named) return Object.freeze({ code, spelling:`#${code}`, named:false, operation:'unnamed-prfop', cacheLevel:null, policy:null });
  return Object.freeze({
    code,
    spelling:`p${['ld','li','st'][type]}l${target + 1}${policy ? 'strm' : 'keep'}`,
    named:true,
    operation:PREFETCH_TYPE_BY_CODE[type],
    cacheLevel:target + 1,
    policy:policy ? PREFETCH_POLICIES.strm : PREFETCH_POLICIES.keep,
  });
}

function prefetchOperand(decoded) {
  // A printed specifier is its own operand; when the disassembler omits it the
  // operand list simply starts with the address, so there is nothing to parse
  // and the field comes from the encoding instead.
  const first = operands(decoded)[0];
  const printed = first?.k === 'other' ? String(first.text ?? '').trim().toLowerCase() : '';
  if (printed) {
    const named = PREFETCH_NAMED_RE.exec(printed);
    if (!named) return null;
    const [, type, level, policy] = named;
    const code = (({ ld:0, li:1, st:2 })[type] << 3) | ((Number(level) - 1) << 1) | (policy === 'strm' ? 1 : 0);
    return Object.freeze({
      code, spelling:printed, named:true,
      operation:PREFETCH_TYPES[type], cacheLevel:Number(level), policy:PREFETCH_POLICIES[policy],
    });
  }
  const word = arm64DecodedEncodingWord(decoded);
  if (word == null) return null;
  return prefetchOperationFromCode(word & 0x1f);
}

function prefetchIntrinsic(prfop, addressValue, addressExpr, registersRead) {
  return createMachineOperation({
    kind:'intrinsic',
    intrinsicId:'arm64.memory-system-prefetch-hint',
    effectSummary:createIntrinsicEffectSummary({
      inputs:[addressValue, createBitVectorValue(5, BigInt(prfop.code))],
      outputs:[],
      registersRead,
      registersWritten:[],
      memoryRead:{ scope:'none' },
      memoryWrite:{ scope:'none' },
      controlEffects:[],
      determinism:'nondeterministic',
      symbolicDetail:'summary-only',
    }),
    metadata:{ addressExpr, state:'memory-system-hint', prfop:prfop.code },
  });
}

function prefetchMetadata(mnemonic, prfop, extra) {
  return {
    family:'arm64-memory', mnemonic, hint:true, ...extra,
    prefetch:Object.freeze({
      prfop:prfop.code, spelling:prfop.spelling, named:prfop.named,
      operation:prfop.operation, cacheLevel:prfop.cacheLevel, policy:prfop.policy,
    }),
  };
}

// PRFM (literal) has no memory operand: the hinted address is PC-relative and
// the disassembler prints it as a resolved immediate.
function literalPrefetch(decoded, context, mnemonic, prfop) {
  const immediate = immediateValue(operands(decoded).find((operand) => operand?.k === 'imm' || operand?.kind === 'immediate'));
  let target = decoded?.pcRelTarget ?? decoded?.literalTarget ?? immediate;
  if (typeof target === 'number' && Number.isSafeInteger(target)) target = BigInt(target);
  if (typeof target === 'string' && /^-?(?:0x[0-9a-f]+|\d+)$/i.test(target)) target = BigInt(target);
  if (typeof target !== 'bigint') return partial(decoded, context, 'prfm literal target is unresolved', ['memory','other']);
  const addressExpr = arm64ConstantExpr(target, 64);
  return bundle(decoded, context, {
    operations:[prefetchIntrinsic(prfop, createBitVectorValue(64, BigInt.asUintN(64, target)), addressExpr, [])],
    possibleFaults:[],
    completeness:'exact-with-intrinsic',
    metadata:prefetchMetadata(mnemonic, prfop, { transfer:'literal', literal:true, target:target.toString() }),
  });
}

function prefetch(decoded, context, mnemonic) {
  const prfop = prefetchOperand(decoded);
  if (!prfop) return partial(decoded, context, 'prefetch operation specifier is unavailable from the decoder', ['memory','other']);
  if (!memoryOperand(decoded)) return literalPrefetch(decoded, context, mnemonic, prfop);

  let addressing;
  try { addressing = buildArm64EffectiveAddress(decoded, { prefix:'prefetch.addr' }); }
  catch (error) {
    if (error instanceof Arm64AddressingError) return partial(decoded, context, error.code, ['memory','other']);
    throw error;
  }
  if (addressing.mode !== 'offset') return partial(decoded, context, `${mnemonic} does not support writeback addressing`, ['memory','other']);
  const addressValue = addressing.readOperations
    .find((operation) => operation.kind === 'register-read' && operation.register?.registerId === addressing.base.physicalId)?.value || null;
  if (!addressValue) return partial(decoded, context, 'prefetch effective address state is unavailable', ['memory','other']);

  // Architecturally a prefetch changes no register, memory, or flag state and
  // raises no synchronous fault; only the memory-system hint itself is
  // implementation-defined. Declaring that hint as a closed intrinsic keeps the
  // architectural effect exact instead of leaving the instruction unknown.
  return bundle(decoded, context, {
    operations:[
      ...addressing.readOperations,
      prefetchIntrinsic(prfop, addressValue, addressing.addressExpr, [
        addressing.base.physicalId, ...(addressing.index ? [addressing.index.physicalId] : []),
      ]),
    ],
    possibleFaults:[],
    completeness:'exact-with-intrinsic',
    metadata:prefetchMetadata(mnemonic, prfop, {
      addressing:addressing.metadata,
      ...(mnemonic === 'prfum' ? { unscaled:true } : {}),
    }),
  });
}

export function isArm64MemoryInstruction(decodedOrMnemonic) {
  const mnemonic = typeof decodedOrMnemonic === 'string' ? decodedOrMnemonic.toLowerCase() : mnemonicOf(decodedOrMnemonic);
  return ALL_NON_ATOMIC.has(mnemonic) || isArm64AtomicInstruction(mnemonic);
}

export function liftArm64MemoryEffects(decoded, context = {}) {
  const mnemonic = mnemonicOf(decoded);
  if (isArm64AtomicInstruction(mnemonic)) return liftArm64AtomicEffects(decoded, context);
  if (!ALL_NON_ATOMIC.has(mnemonic)) return null;
  if (PREFETCH_MNEMONICS.has(mnemonic)) return prefetch(decoded, context, mnemonic);

  const hasMem = !!memoryOperand(decoded);
  if (!hasMem && (mnemonic === 'ldr' || mnemonic === 'ldrsw')) return literalLoad(decoded, context, mnemonic);
  if (!hasMem) return partial(decoded, context, 'recognized memory instruction has no supported memory operand');
  if (SIMPLE_LOADS.has(mnemonic)) return simpleMemory(decoded, context, mnemonic, true);
  if (SIMPLE_STORES.has(mnemonic)) return simpleMemory(decoded, context, mnemonic, false);
  if (PAIR_LOADS.has(mnemonic)) return pairMemory(decoded, context, mnemonic, true);
  if (PAIR_STORES.has(mnemonic)) return pairMemory(decoded, context, mnemonic, false);
  return partial(decoded, context, 'recognized memory instruction family is not fully modeled');
}

export const liftMemoryEffects = liftArm64MemoryEffects;
