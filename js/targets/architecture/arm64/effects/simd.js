import {
  createBitVectorValue,
  createFloatValue,
  createIntrinsicEffectSummary,
  createMachineEffectBundle,
  createMachineOperation,
  createRegisterValue,
  createTemporaryValue,
  createVectorValue,
} from '../../../../semantics/effects/index.js';

const ARCHITECTURE_ID = 'arm64';
const MODE = 'a64';
const FPCR = 'fpcr';
const FPSR = 'fpsr';

const ELEMENT_BITS = Object.freeze({ b:8, h:16, s:32, d:64 });
const FLOAT_FORMAT = Object.freeze({
  16:'ieee754-binary16',
  32:'ieee754-binary32',
  64:'ieee754-binary64',
});

const MEMORY_FAMILIES = /^(?:ld[1-4]|st[1-4]|ldr|str|ldur|stur|ldp|stp)/;
const LANE_MNEMONICS = new Set(['dup','ins','umov','smov','mov']);
const IMMEDIATE_MNEMONICS = new Set(['movi','mvni']);
const PERMUTE_MNEMONICS = new Set(['tbl','tbx','zip1','zip2','uzp1','uzp2','trn1','trn2','ext','rev64','rev64_v']);
const REDUCE_MNEMONICS = new Set(['addv','uaddlv','saddlv','smaxv','sminv','umaxv','uminv']);
const NARROW_MNEMONICS = new Set(['xtn','xtn2','sqxtn','sqxtn2','uqxtn','uqxtn2','sqxtun','sqxtun2']);
const INTEGER_VECTOR_MNEMONICS = new Set([
  'add','sub','mul','mla','mls','abs','neg','and','orr','orr_v','eor','bic','orn','not','mvn',
  'cmeq','cmge','cmgt','cmhi','cmhs','cmtst','smax','smin','umax','umin','addp',
  'smaxp','sminp','umaxp','uminp','shl','sshl','ushl','sshr','ushr','sli','sri',
  'sqadd','uqadd','sqsub','uqsub','suqadd',
]);
const FP_VECTOR_MNEMONICS = new Set([
  'fadd','fsub','fmul','fdiv','fmla','fmls','fabs','fneg','fsqrt','fmax','fmin','fmaxnm','fminnm',
  'fcmeq','fcmge','fcmgt','facge','facgt','frecpe','frecps','frsqrte','frsqrts',
  'fcvtzs','fcvtzu','scvtf','ucvtf','frinta','frintm','frintn','frintp','frintx','frinti','frintz',
]);
const FP_VECTOR_NO_STATUS = new Set(['fabs','fneg']);
const SATURATING_MNEMONICS = new Set([
  'sqadd','uqadd','sqsub','uqsub','suqadd','sqxtn','sqxtn2','uqxtn','uqxtn2','sqxtun','sqxtun2',
]);
const OWNED = new Set([
  ...LANE_MNEMONICS, ...IMMEDIATE_MNEMONICS, ...PERMUTE_MNEMONICS, ...REDUCE_MNEMONICS,
  ...NARROW_MNEMONICS, ...INTEGER_VECTOR_MNEMONICS, ...FP_VECTOR_MNEMONICS,
]);
export const ARM64_SIMD_EFFECT_MNEMONICS = Object.freeze(new Set(OWNED));

const ARR_INT_FULL = new Set(['8b','16b','4h','8h','2s','4s','2d']);
const ARR_INT_NO_D = new Set(['8b','16b','4h','8h','2s','4s']);
const ARR_BITWISE = new Set(['8b','16b']);
const ARR_REV64 = new Set(['8b','16b','4h','8h','2s','4s']);
const ARR_FP = new Set(['4h','8h','2s','4s','2d']);
const ARR_MUL_ELEM = new Set(['4h','8h','2s','4s']);
const ARR_TABLE = ARR_BITWISE;
const ARR_NARROW_LOW = Object.freeze({ '8b':'8h', '4h':'4s', '2s':'2d' });
const ARR_NARROW_HIGH = Object.freeze({ '16b':'8h', '8h':'4s', '4s':'2d' });

const INT_TERNARY_FULL = new Set(['add','sub','cmhi','cmhs','cmtst','addp','sshl','ushl','sqadd','uqadd','sqsub','uqsub']);
const INT_TERNARY_NO_D = new Set(['smax','smin','umax','umin','smaxp','sminp','umaxp','uminp']);
const INT_UNARY_FULL = new Set(['abs','neg']);
const LOGICAL_TERNARY = new Set(['and','orr','orr_v','eor','bic','orn']);
const INT_COMPARE_ZERO = new Set(['cmeq','cmge','cmgt']);
const SHIFT_IMMEDIATE = new Set(['shl','sshr','ushr','sli','sri']);
const FP_TERNARY = new Set(['fadd','fsub','fdiv','fmax','fmin','fmaxnm','fminnm','frecps','frsqrts']);
const FP_UNARY = new Set(['fabs','fneg','fsqrt','frecpe','frsqrte','frinta','frintm','frintn','frintp','frintx','frinti','frintz']);
const FP_COMPARE = new Set(['fcmeq','fcmge','fcmgt']);
const FP_ABS_COMPARE = new Set(['facge','facgt']);
const FP_TO_INT = new Set(['fcvtzs','fcvtzu']);
const INT_TO_FP = new Set(['scvtf','ucvtf']);
const SCALAR_INT_D_TERNARY = new Set(['add','sub','cmhi','cmhs','cmtst','sshl','ushl']);
const SCALAR_INT_D_UNARY = new Set(['abs','neg']);
const SCALAR_INT_COMPARE = new Set(['cmeq','cmge','cmgt']);
const SCALAR_SAT_TERNARY = new Set(['sqadd','uqadd','sqsub','uqsub']);
const SCALAR_SAT_UNARY = new Set(['suqadd']);
const SCALAR_SHIFT_IMMEDIATE = new Set(['shl','sshr','ushr','sli','sri']);
const SCALAR_FP_COMPARE = new Set(['fcmeq','fcmge','fcmgt','facge','facgt']);
const SCALAR_NARROW = new Set(['sqxtn','uqxtn','sqxtun']);

function mnemonicOf(instruction) {
  return String(instruction?.mnemonic || '').trim().toLowerCase();
}
function semanticMnemonic(mnemonic) {
  if (mnemonic === 'orr_v') return 'orr';
  if (mnemonic === 'rev64_v') return 'rev64';
  if (mnemonic === 'mvn') return 'not';
  return mnemonic;
}
function operandsOf(instruction) {
  if (Array.isArray(instruction?.ops)) return instruction.ops;
  if (Array.isArray(instruction?.parsed)) return instruction.parsed;
  if (Array.isArray(instruction?.operandsParsed)) return instruction.operandsParsed;
  return [];
}
function operandText(instruction) {
  return String(instruction?.operands ?? instruction?.opStr ?? '');
}
function scalableText(text) {
  return /(?:^|[\s,{])(?:z|p)\d+(?:\.|\b)|\bffr\b/i.test(String(text || ''));
}
function scalableOperand(op) {
  if (!op) return false;
  if (op.k === 'list') return (op.regs || []).some(scalableOperand);
  if (['z','p','pred','sve'].includes(String(op.cls || '').toLowerCase())) return true;
  return scalableText(op.text);
}
function isSve(instruction, ops) {
  return scalableText(operandText(instruction)) || ops.some(scalableOperand);
}
function hasVectorOperand(ops) {
  return ops.some((op) => op?.k === 'elem' || op?.k === 'list' || (op?.k === 'reg' && op.cls === 'vec' && op.arr));
}
function hasScalarSimdOperand(ops) {
  return ops.some((op) => op?.k === 'reg' && op.cls === 'fp');
}
function instructionIdOf(instruction, context) {
  const id = instruction?.instructionId ?? context?.instructionId;
  if (!id) throw new TypeError('arm64-simd-machine-effects-instruction-id-required');
  return String(id);
}
function originOf(instruction, context, instructionId) {
  return instruction?.origin ?? context?.origin ?? { instructionIds:[instructionId] };
}
function bundle(instruction, context, fields) {
  const instructionId = instructionIdOf(instruction, context);
  return createMachineEffectBundle({
    instructionId,
    architectureId:ARCHITECTURE_ID,
    mode:MODE,
    operations:fields.operations,
    controlEffect:fields.controlEffect || { kind:'fallthrough' },
    possibleFaults:fields.possibleFaults || [],
    origin:originOf(instruction, context, instructionId),
    completeness:fields.completeness,
    ...(fields.unknownEffects ? { unknownEffects:fields.unknownEffects } : {}),
    metadata:{ family:'arm64-simd', mnemonic:mnemonicOf(instruction), ...(fields.metadata || {}) },
  }, context?.machineEffectsOptions || {});
}
function partial(instruction, context, reason, categories = ['registers','other'], operations = []) {
  return bundle(instruction, context, {
    operations:[...operations, createMachineOperation({ kind:'unknown', reason, categories })],
    completeness:'partial',
    unknownEffects:{ categories, reason },
  });
}
function temp(id, valueType) {
  return createTemporaryValue(id, valueType);
}
function validRegisterNumber(op) {
  return Number.isInteger(op?.num) && op.num >= 0 && op.num < 32;
}
function hasForbiddenSimdRegisterModifier(op) {
  if (!op) return false;
  if (op.k === 'list') return (op.regs || []).some(hasForbiddenSimdRegisterModifier);
  const simdRegister = op.k === 'elem' || (op.k === 'reg' && (op.cls === 'vec' || op.cls === 'fp'));
  return simdRegister && (op.shift != null || op.extend != null);
}
function physicalRegisterId(op) {
  if (!op) return null;
  if (op.k === 'elem') return validRegisterNumber(op) ? `v${op.num}` : null;
  if (op.k !== 'reg' || !validRegisterNumber(op) || op.cls === 'zr') return null;
  if (op.cls === 'sp') return 'sp';
  if (op.cls === 'gp') return op.num === 31 ? null : `x${op.num}`;
  if (op.cls === 'fp' || op.cls === 'vec') return `v${op.num}`;
  return null;
}
function registerIdsOf(ops) {
  const out = [];
  for (const op of ops) {
    if (op?.k === 'list') {
      for (const reg of op.regs || []) {
        const id = physicalRegisterId(reg);
        if (id) out.push(id);
      }
      continue;
    }
    const id = physicalRegisterId(op);
    if (id) out.push(id);
  }
  return [...new Set(out)];
}
function valueWidth(value) {
  const type = value?.kind === 'temporary' ? value.valueType : value;
  if (!type) return null;
  if (type.kind === 'vector') return type.laneCount * type.elementType.widthBits;
  return type.widthBits || null;
}
function parseArrangement(op, elementKind = 'bitvector') {
  if (op?.k !== 'reg' || op.cls !== 'vec' || op.bits !== 128 || !validRegisterNumber(op)) return null;
  const arr = String(op.arr || '').toLowerCase();
  const match = /^(\d+)([bhsd])$/.exec(arr);
  if (!match) return null;
  const laneCount = Number(match[1]);
  const elementBits = ELEMENT_BITS[match[2]];
  if (!laneCount || !elementBits) return null;
  const widthBits = laneCount * elementBits;
  if (widthBits !== 64 && widthBits !== 128) return null;
  let elementType;
  if (elementKind === 'float') {
    const format = FLOAT_FORMAT[elementBits];
    if (!format) return null;
    elementType = createFloatValue(elementBits, format);
  } else {
    elementType = createBitVectorValue(elementBits);
  }
  return { arr, laneCount, elementBits, widthBits, elementType, valueType:createVectorValue(laneCount, elementType) };
}
function arrangement(op, allowed, elementKind = 'bitvector') {
  const info = parseArrangement(op, elementKind);
  return info && allowed.has(info.arr) ? info : null;
}
function elementInfo(op, elementKind = 'bitvector') {
  if (op?.k !== 'elem' || !validRegisterNumber(op)) return null;
  const size = String(op.size || '').toLowerCase();
  const elementBits = ELEMENT_BITS[size];
  if (!elementBits) return null;
  const laneCount = 128 / elementBits;
  if (!Number.isInteger(op.index) || op.index < 0 || op.index >= laneCount) return null;
  let valueType;
  if (elementKind === 'float') {
    const format = FLOAT_FORMAT[elementBits];
    if (!format) return null;
    valueType = createFloatValue(elementBits, format);
  } else valueType = createBitVectorValue(elementBits);
  return { elementBits, laneCount, index:op.index, size, valueType };
}
function scalarSimdInfo(op, allowedBits, elementKind = 'bitvector') {
  if (op?.k !== 'reg' || op.cls !== 'fp' || !validRegisterNumber(op) || !allowedBits.has(op.bits)) return null;
  const widthBits = Number(op.bits);
  const valueType = elementKind === 'float'
    ? (FLOAT_FORMAT[widthBits] ? createFloatValue(widthBits, FLOAT_FORMAT[widthBits]) : null)
    : createBitVectorValue(widthBits);
  return valueType ? { widthBits, valueType, elementKind } : null;
}
function sameScalarSimdInfo(op, reference, allowedBits, elementKind = 'bitvector') {
  const info = scalarSimdInfo(op, allowedBits, elementKind);
  return info && reference && info.widthBits === reference.widthBits ? info : null;
}
function sameArrangement(op, reference, allowed, elementKind) {
  const info = arrangement(op, allowed, elementKind);
  return info && info.arr === reference.arr ? info : null;
}
function gpWidth(op) {
  if (op?.k !== 'reg' || !validRegisterNumber(op) || !['gp','zr'].includes(op.cls)) return null;
  if (op.cls === 'gp' && op.num === 31) return null;
  if (op.cls === 'zr' && op.num !== 31) return null;
  return op.bits === 32 || op.bits === 64 ? op.bits : null;
}
function registerValueForVector(op) {
  const id = physicalRegisterId(op);
  return id ? createRegisterValue(id, 128, { view:id }) : null;
}
function appendVectorRead(operations, op, info, id) {
  const reg = registerValueForVector(op);
  if (!reg || !info) return null;
  const physical = temp(`${id}:physical`, createBitVectorValue(128));
  operations.push(createMachineOperation({
    kind:'register-read', register:reg, value:physical,
    metadata:{ architecturalViewRead:String(op.text || `v${op.num}.${info.arr}`).toLowerCase(), physicalWidthBits:128 },
  }));
  let view = physical;
  if (info.widthBits < 128) {
    view = temp(`${id}:view-bits`, createBitVectorValue(info.widthBits));
    operations.push(createMachineOperation({
      kind:'value', opcode:'truncate', inputs:[physical], outputs:[view],
      metadata:{ purpose:'arm64-simd-register-view', fromBits:128, toBits:info.widthBits, readPolicy:'low-bits' },
    }));
  }
  const value = temp(id, info.valueType);
  operations.push(createMachineOperation({
    kind:'value', opcode:'bitcast', inputs:[view], outputs:[value],
    metadata:{ purpose:'arm64-simd-register-view-type', widthBits:info.widthBits, arrangement:info.arr },
  }));
  return value;
}
function appendElementRead(operations, op, info, id) {
  if (!info) return null;
  const physical = temp(`${id}:physical`, createBitVectorValue(128));
  operations.push(createMachineOperation({
    kind:'register-read',
    register:createRegisterValue(`v${op.num}`, 128, { view:`v${op.num}` }),
    value:physical,
    metadata:{ canonicalPhysicalStorage:true, architecturalViewRead:String(op.text || `v${op.num}.${info.size}[${info.index}]`).toLowerCase(), physicalWidthBits:128 },
  }));
  const fullType = createVectorValue(info.laneCount, info.valueType);
  const fullValue = temp(`${id}:full-vector`, fullType);
  operations.push(createMachineOperation({
    kind:'value', opcode:'bitcast', inputs:[physical], outputs:[fullValue],
    metadata:{ purpose:'arm64-simd-element-register-view', sourceWidthBits:128, laneWidthBits:info.elementBits },
  }));
  const value = temp(id, info.valueType);
  operations.push(createMachineOperation({
    kind:'value', opcode:'extract-lane', inputs:[fullValue], outputs:[value],
    metadata:{ laneIndex:info.index, laneWidthBits:info.elementBits, sourceWidthBits:128 },
  }));
  return value;
}
function appendGpRead(operations, op, id) {
  const bits = gpWidth(op);
  if (!bits) return null;
  if (op.cls === 'zr') return createBitVectorValue(bits, 0n);
  const physical = temp(`${id}:physical`, createBitVectorValue(64));
  operations.push(createMachineOperation({
    kind:'register-read', register:createRegisterValue(`x${op.num}`, 64, { view:`x${op.num}` }), value:physical,
    metadata:{ architecturalViewRead:String(op.text || (bits === 32 ? `w${op.num}` : `x${op.num}`)).toLowerCase(), physicalWidthBits:64 },
  }));
  if (bits === 64) return physical;
  const value = temp(id, createBitVectorValue(32));
  operations.push(createMachineOperation({
    kind:'value', opcode:'truncate', inputs:[physical], outputs:[value],
    metadata:{ purpose:'arm64-gp-register-view', fromBits:64, toBits:32, readPolicy:'low-bits' },
  }));
  return value;
}
function appendNamedRead(operations, registerId, widthBits, id) {
  const value = temp(id, createBitVectorValue(widthBits));
  operations.push(createMachineOperation({ kind:'register-read', register:createRegisterValue(registerId, widthBits), value }));
  return value;
}
function appendNamedWrite(operations, registerId, widthBits, value) {
  operations.push(createMachineOperation({ kind:'register-write', register:createRegisterValue(registerId, widthBits), value }));
}
function appendVectorWrite(operations, dst, info, value, idPrefix, metadata = {}) {
  if (!info || !dst || dst.k !== 'reg' || dst.cls !== 'vec' || !validRegisterNumber(dst)) return false;
  let bits = value;
  const width = valueWidth(value);
  if (width !== info.widthBits || (value?.kind === 'temporary' ? value.valueType.kind : value?.kind) !== 'bitvector') {
    bits = temp(`${idPrefix}:bits`, createBitVectorValue(info.widthBits));
    operations.push(createMachineOperation({
      kind:'value', opcode:'bitcast', inputs:[value], outputs:[bits],
      metadata:{ purpose:'arm64-simd-destination-bit-pattern', widthBits:info.widthBits, arrangement:info.arr },
    }));
  }
  let physical = bits;
  if (info.widthBits < 128) {
    physical = temp(`${idPrefix}:physical`, createBitVectorValue(128));
    operations.push(createMachineOperation({
      kind:'value', opcode:'zero-extend', inputs:[bits], outputs:[physical],
      metadata:{ fromBits:info.widthBits, toBits:128, writePolicy:'zero-upper-vector-bits' },
    }));
  }
  operations.push(createMachineOperation({
    kind:'register-write', register:createRegisterValue(`v${dst.num}`, 128, { view:`v${dst.num}` }), value:physical,
    metadata:{
      architecturalViewWritten:String(dst.text || `v${dst.num}.${info.arr}`).toLowerCase(),
      physicalWidthBits:128,
      writePolicy:info.widthBits < 128 ? 'zero-upper-vector-bits' : 'full-width',
      ...metadata,
    },
  }));
  return true;
}
function appendScalarVectorRead(operations, op, info, id) {
  if (!info || !op || op.k !== 'reg' || op.cls !== 'fp' || !validRegisterNumber(op)) return null;
  const physical = temp(`${id}:physical`, createBitVectorValue(128));
  operations.push(createMachineOperation({
    kind:'register-read', register:createRegisterValue(`v${op.num}`, 128, { view:`v${op.num}` }), value:physical,
    metadata:{ architecturalViewRead:String(op.text || '').toLowerCase(), physicalWidthBits:128 },
  }));
  let bits = physical;
  if (info.widthBits < 128) {
    bits = temp(`${id}:bits`, createBitVectorValue(info.widthBits));
    operations.push(createMachineOperation({
      kind:'value', opcode:'truncate', inputs:[physical], outputs:[bits],
      metadata:{ purpose:'arm64-simd-scalar-register-view', fromBits:128, toBits:info.widthBits, readPolicy:'low-bits' },
    }));
  }
  if (info.elementKind !== 'float') return bits;
  const value = temp(id, info.valueType);
  operations.push(createMachineOperation({
    kind:'value', opcode:'bitcast', inputs:[bits], outputs:[value],
    metadata:{ purpose:'arm64-simd-scalar-register-view-type', widthBits:info.widthBits, elementKind:'float' },
  }));
  return value;
}
function appendScalarVectorWrite(operations, dst, widthBits, value, idPrefix, metadata = {}) {
  if (!dst || dst.k !== 'reg' || dst.cls !== 'fp' || !validRegisterNumber(dst) || dst.bits !== widthBits) return false;
  let bits = value;
  const type = value?.kind === 'temporary' ? value.valueType : value;
  if (type?.kind !== 'bitvector' || type.widthBits !== widthBits) {
    bits = temp(`${idPrefix}:bits`, createBitVectorValue(widthBits));
    operations.push(createMachineOperation({ kind:'value', opcode:'bitcast', inputs:[value], outputs:[bits], metadata:{ purpose:'arm64-simd-scalar-destination-bit-pattern', widthBits } }));
  }
  let physical = bits;
  if (widthBits < 128) {
    physical = temp(`${idPrefix}:physical`, createBitVectorValue(128));
    operations.push(createMachineOperation({ kind:'value', opcode:'zero-extend', inputs:[bits], outputs:[physical], metadata:{ fromBits:widthBits, toBits:128, writePolicy:'zero-upper-vector-bits' } }));
  }
  operations.push(createMachineOperation({
    kind:'register-write', register:createRegisterValue(`v${dst.num}`, 128, { view:`v${dst.num}` }), value:physical,
    metadata:{ architecturalViewWritten:String(dst.text || '').toLowerCase(), physicalWidthBits:128, writePolicy:widthBits < 128 ? 'zero-upper-vector-bits' : 'full-width', ...metadata },
  }));
  return true;
}
function appendGpWrite(operations, dst, semanticValue, idPrefix) {
  const bits = gpWidth(dst);
  if (!bits) return false;
  if (dst.cls === 'zr') return true;
  if (bits === 32) {
    const physical = temp(`${idPrefix}:w-write`, createBitVectorValue(64));
    operations.push(createMachineOperation({ kind:'value', opcode:'arm64.zero-extend-w-write', inputs:[semanticValue], outputs:[physical] }));
    operations.push(createMachineOperation({
      kind:'register-write', register:createRegisterValue(`x${dst.num}`, 64, { view:`x${dst.num}` }), value:physical,
      metadata:{ architecturalViewWritten:String(dst.text || `w${dst.num}`).toLowerCase(), physicalWidthBits:64 },
    }));
  } else {
    operations.push(createMachineOperation({
      kind:'register-write', register:createRegisterValue(`x${dst.num}`, 64, { view:`x${dst.num}` }), value:semanticValue,
      metadata:{ architecturalViewWritten:String(dst.text || `x${dst.num}`).toLowerCase(), physicalWidthBits:64 },
    }));
  }
  return true;
}
function immediateInteger(op) {
  if (op?.k !== 'imm' || op.value == null || typeof op.value !== 'bigint' || op.extend != null) return null;
  return op.value;
}
function immediateValue(op, widthBits = 64) {
  const value = immediateInteger(op);
  if (value == null) return null;
  return createBitVectorValue(widthBits, BigInt.asUintN(widthBits, value));
}
function immediateFloatZero(op, widthBits) {
  if (op?.k !== 'imm') return null;
  const zero = (op.float != null && Number(op.float) === 0) || op.value === 0n;
  if (!zero || op.shift || op.extend != null) return null;
  const format = FLOAT_FORMAT[widthBits];
  return format ? createFloatValue(widthBits, format, { bitPattern:0n }) : null;
}
function shiftInfo(op) {
  if (!op?.shift) return null;
  const shift = op.shift;
  if (!['lsl','msl'].includes(shift.op) || !Number.isInteger(shift.amount)) return null;
  return { op:shift.op, amount:shift.amount };
}
function laneGpWidth(elementBits) {
  return elementBits === 64 ? 64 : 32;
}
function intrinsicSummary(inputs, outputs, registersRead, registersWritten, determinism = 'deterministic') {
  return createIntrinsicEffectSummary({
    inputs, outputs, registersRead, registersWritten,
    memoryRead:{scope:'none'}, memoryWrite:{scope:'none'}, controlEffects:[],
    determinism, symbolicDetail:'summary-only',
  });
}

function laneEffects(instruction, context, mnemonic, ops) {
  if (ops.length !== 2) return partial(instruction, context, `${mnemonic}-lane-operand-count-invalid`);
  const dst = ops[0];
  const src = ops[1];
  const operations = [];
  const canonical = semanticMnemonic(mnemonic);

  if (mnemonic === 'ins' || (mnemonic === 'mov' && dst?.k === 'elem')) {
    const dstInfo = elementInfo(dst);
    if (!dstInfo) return partial(instruction, context, `${mnemonic}-destination-lane-unavailable`);
    let sourceInfo = null;
    if (src?.k === 'elem') {
      sourceInfo = elementInfo(src);
      if (!sourceInfo || sourceInfo.elementBits !== dstInfo.elementBits) return partial(instruction, context, `${mnemonic}-lane-width-mismatch`);
    } else if (gpWidth(src) !== laneGpWidth(dstInfo.elementBits)) {
      return partial(instruction, context, `${mnemonic}-general-source-width-invalid`);
    }
    const full = {
      arr:`${dstInfo.laneCount}${dstInfo.size}`, laneCount:dstInfo.laneCount, elementBits:dstInfo.elementBits,
      widthBits:128, elementType:createBitVectorValue(dstInfo.elementBits),
      valueType:createVectorValue(dstInfo.laneCount, createBitVectorValue(dstInfo.elementBits)),
    };
    const prior = appendVectorRead(operations, { k:'reg', cls:'vec', num:dst.num, bits:128, arr:full.arr, text:`v${dst.num}.${full.arr}` }, full, `${mnemonic}:prior`);
    const source = src?.k === 'elem'
      ? appendElementRead(operations, src, sourceInfo, `${mnemonic}:src`)
      : appendGpRead(operations, src, `${mnemonic}:src`);
    if (!prior || !source) return partial(instruction, context, `${mnemonic}-source-lane-unavailable`, ['registers','other'], operations);
    const result = temp(`${mnemonic}:result`, full.valueType);
    const summary = intrinsicSummary([prior, source], [result], [`v${dst.num}`, ...registerIdsOf([src])], [`v${dst.num}`]);
    operations.push(createMachineOperation({
      kind:'intrinsic', intrinsicId:`arm64.simd.${canonical}.lane-insert`, effectSummary:summary,
      metadata:{ destinationLane:dstInfo.index, laneWidthBits:dstInfo.elementBits, sourceLane:src?.k === 'elem' ? src.index : null },
    }));
    appendVectorWrite(operations, { k:'reg', cls:'vec', num:dst.num, bits:128, arr:full.arr, text:`v${dst.num}.${full.arr}` }, full, result, `${mnemonic}:dst`, { laneWritten:dstInfo.index, destinationSemantics:'merge-selected-lane' });
    return bundle(instruction, context, { operations, completeness:'exact-with-intrinsic', metadata:{ laneWidthBits:dstInfo.elementBits, laneIndex:dstInfo.index, destinationSemantics:'merge-selected-lane' } });
  }

  if (mnemonic === 'umov' || mnemonic === 'smov' || (mnemonic === 'mov' && (dst?.cls === 'gp' || dst?.cls === 'zr'))) {
    const srcInfo = elementInfo(src);
    const dstBits = gpWidth(dst);
    if (!srcInfo || !dstBits) return partial(instruction, context, `${mnemonic}-lane-move-operands-unavailable`);
    if (mnemonic === 'smov') {
      const valid = (dstBits === 32 && (srcInfo.elementBits === 8 || srcInfo.elementBits === 16))
        || (dstBits === 64 && [8,16,32].includes(srcInfo.elementBits));
      if (!valid) return partial(instruction, context, `${mnemonic}-extension-width-invalid`);
    } else {
      const valid = (dstBits === 32 && [8,16,32].includes(srcInfo.elementBits)) || (dstBits === 64 && srcInfo.elementBits === 64);
      if (!valid) return partial(instruction, context, `${mnemonic}-move-width-invalid`);
    }
    const source = appendElementRead(operations, src, srcInfo, `${mnemonic}:src`);
    const result = temp(`${mnemonic}:result`, createBitVectorValue(dstBits));
    const summary = intrinsicSummary([source], [result], [`v${src.num}`], registerIdsOf([dst]));
    operations.push(createMachineOperation({
      kind:'intrinsic', intrinsicId:`arm64.simd.${canonical}.lane-extract`, effectSummary:summary,
      metadata:{ sourceLane:srcInfo.index, laneWidthBits:srcInfo.elementBits, extension:mnemonic === 'smov' ? 'sign' : 'zero-or-bitcopy', destinationWidthBits:dstBits },
    }));
    appendGpWrite(operations, dst, result, `${mnemonic}:dst`);
    return bundle(instruction, context, { operations, completeness:'exact-with-intrinsic', metadata:{ laneWidthBits:srcInfo.elementBits, laneIndex:srcInfo.index, destinationWidthBits:dstBits } });
  }

  if (mnemonic === 'dup') {
    const dstArrangement = arrangement(dst, ARR_INT_FULL);
    if (!dstArrangement) return partial(instruction, context, `${mnemonic}-vector-arrangement-unavailable`);
    let source;
    if (src?.k === 'elem') {
      const srcInfo = elementInfo(src);
      if (!srcInfo || srcInfo.elementBits !== dstArrangement.elementBits) return partial(instruction, context, `${mnemonic}-source-lane-width-invalid`);
      source = appendElementRead(operations, src, srcInfo, `${mnemonic}:src`);
    } else {
      if (gpWidth(src) !== laneGpWidth(dstArrangement.elementBits)) return partial(instruction, context, `${mnemonic}-general-source-width-invalid`);
      source = appendGpRead(operations, src, `${mnemonic}:src`);
    }
    if (!source) return partial(instruction, context, `${mnemonic}-duplicate-source-unavailable`, ['registers','other'], operations);
    const result = temp(`${mnemonic}:result`, dstArrangement.valueType);
    const summary = intrinsicSummary([source], [result], registerIdsOf([src]), [`v${dst.num}`]);
    operations.push(createMachineOperation({ kind:'intrinsic', intrinsicId:'arm64.simd.dup', effectSummary:summary, metadata:{ arrangement:dstArrangement.arr, laneWidthBits:dstArrangement.elementBits } }));
    appendVectorWrite(operations, dst, dstArrangement, result, `${mnemonic}:dst`);
    return bundle(instruction, context, { operations, completeness:'exact-with-intrinsic', metadata:{ arrangement:dstArrangement.arr, laneWidthBits:dstArrangement.elementBits } });
  }

  if (mnemonic === 'mov' && dst?.k === 'reg' && dst.cls === 'vec') {
    const dstArrangement = arrangement(dst, ARR_BITWISE);
    const srcArrangement = sameArrangement(src, dstArrangement || {}, ARR_BITWISE, 'bitvector');
    if (!dstArrangement || !srcArrangement) return partial(instruction, context, 'mov-vector-copy-shape-invalid');
    const source = appendVectorRead(operations, src, srcArrangement, 'mov:src');
    const result = temp('mov:result', dstArrangement.valueType);
    const summary = intrinsicSummary([source], [result], [`v${src.num}`], [`v${dst.num}`]);
    operations.push(createMachineOperation({ kind:'intrinsic', intrinsicId:'arm64.simd.mov.vector', effectSummary:summary, metadata:{ arrangement:dstArrangement.arr } }));
    appendVectorWrite(operations, dst, dstArrangement, result, 'mov:dst');
    return bundle(instruction, context, { operations, completeness:'exact-with-intrinsic', metadata:{ arrangement:dstArrangement.arr } });
  }

  return partial(instruction, context, `${mnemonic}-lane-form-unsupported`);
}

function modifiedImmediateShape(mnemonic, dstInfo, imm) {
  const value = immediateInteger(imm);
  if (!dstInfo || value == null || value < 0n) return null;
  const shift = shiftInfo(imm);
  if (imm.shift && !shift) return null;
  if (dstInfo.arr === '8b' || dstInfo.arr === '16b') {
    if (mnemonic !== 'movi' || shift || value > 255n) return null;
    return { shift:null, immediateBits:8 };
  }
  if (dstInfo.arr === '4h' || dstInfo.arr === '8h') {
    if (value > 255n || (shift && (shift.op !== 'lsl' || shift.amount !== 8))) return null;
    return { shift:shift || null, immediateBits:8 };
  }
  if (dstInfo.arr === '2s' || dstInfo.arr === '4s') {
    if (value > 255n) return null;
    if (shift && !((shift.op === 'lsl' && [8,16,24].includes(shift.amount)) || (shift.op === 'msl' && [8,16].includes(shift.amount)))) return null;
    return { shift:shift || null, immediateBits:8 };
  }
  if (dstInfo.arr === '2d') {
    if (mnemonic !== 'movi' || shift || value > 0xffffffffffffffffn) return null;
    let x = value;
    for (let index = 0; index < 8; index++, x >>= 8n) {
      const byte = Number(x & 0xffn);
      if (byte !== 0 && byte !== 0xff) return null;
    }
    return { shift:null, immediateBits:64, byteMask:true };
  }
  return null;
}
function vectorImmediate(instruction, context, mnemonic, ops) {
  if (ops.length !== 2) return partial(instruction, context, `${mnemonic}-operand-count-invalid`);
  const dst = ops[0];
  const imm = ops[1];
  const allowed = mnemonic === 'movi' ? ARR_INT_FULL : new Set(['4h','8h','2s','4s']);
  const dstArrangement = arrangement(dst, allowed);
  const shape = modifiedImmediateShape(mnemonic, dstArrangement, imm);
  if (!shape) return partial(instruction, context, `${mnemonic}-arrangement-or-immediate-invalid`);
  const operations = [];
  const immediate = immediateValue(imm, shape.immediateBits);
  const result = temp(`${mnemonic}:result`, dstArrangement.valueType);
  const summary = intrinsicSummary([immediate], [result], [], [`v${dst.num}`]);
  operations.push(createMachineOperation({
    kind:'intrinsic', intrinsicId:`arm64.simd.${mnemonic}`, effectSummary:summary,
    metadata:{ arrangement:dstArrangement.arr, shift:shape.shift, immediateBits:shape.immediateBits, byteMask:shape.byteMask === true },
  }));
  appendVectorWrite(operations, dst, dstArrangement, result, `${mnemonic}:dst`);
  return bundle(instruction, context, { operations, completeness:'exact-with-intrinsic', metadata:{ arrangement:dstArrangement.arr, laneWidthBits:dstArrangement.elementBits } });
}

function logicalImmediate(instruction, context, mnemonic, ops) {
  if (ops.length !== 2) return null;
  const dst = ops[0];
  const imm = ops[1];
  const dstArrangement = arrangement(dst, new Set(['4h','8h','2s','4s']));
  const value = immediateInteger(imm);
  if (!dstArrangement || value == null || value < 0n || value > 255n) return null;
  const shift = shiftInfo(imm);
  if (imm.shift && !shift) return null;
  const validShift = dstArrangement.elementBits === 16
    ? (!shift || (shift.op === 'lsl' && shift.amount === 8))
    : (!shift || (shift.op === 'lsl' && [8,16,24].includes(shift.amount)));
  if (!validShift) return null;
  const operations = [];
  const prior = appendVectorRead(operations, dst, dstArrangement, `${mnemonic}:prior`);
  const immediate = immediateValue(imm, 8);
  const result = temp(`${mnemonic}:result`, dstArrangement.valueType);
  const summary = intrinsicSummary([prior, immediate], [result], [`v${dst.num}`], [`v${dst.num}`]);
  operations.push(createMachineOperation({
    kind:'intrinsic', intrinsicId:`arm64.simd.${mnemonic}.immediate`, effectSummary:summary,
    metadata:{ arrangement:dstArrangement.arr, shift:shift || null, destinationSemantics:'merge-bitwise-immediate' },
  }));
  appendVectorWrite(operations, dst, dstArrangement, result, `${mnemonic}:dst`, { destinationSemantics:'read-modify-write' });
  return bundle(instruction, context, { operations, completeness:'exact-with-intrinsic', metadata:{ arrangement:dstArrangement.arr, laneWidthBits:dstArrangement.elementBits, destinationSemantics:'read-modify-write' } });
}

function vectorShape(ops, allowed, { sourceKind='bitvector', resultKind=sourceKind, destinationIsInput=false, allowElement=false } = {}) {
  if (ops.length < 2) return null;
  const dst = arrangement(ops[0], allowed, resultKind);
  if (!dst) return null;
  const sources = [];
  for (let i = 1; i < ops.length; i++) {
    const op = ops[i];
    if (op?.k === 'reg') {
      const info = sameArrangement(op, dst, allowed, sourceKind);
      if (!info) return null;
      sources.push({ kind:'vector', op, info });
      continue;
    }
    if (op?.k === 'elem') {
      if (!allowElement) return null;
      const info = elementInfo(op, sourceKind);
      if (!info || info.elementBits !== dst.elementBits) return null;
      if (info.elementBits === 16 && op.num > 15) return null;
      sources.push({ kind:'element', op, info });
      continue;
    }
    return null;
  }
  return { dst, sources, sourceKind, resultKind, destinationIsInput };
}
function genericForm(mnemonic, ops) {
  const canonical = semanticMnemonic(mnemonic);
  if (canonical === 'orr' || canonical === 'bic') {
    if (ops.length === 2 && ops[1]?.k === 'imm') return { logicalImmediate:true };
  }
  if (LOGICAL_TERNARY.has(mnemonic)) {
    if (ops.length !== 3) return null;
    return vectorShape(ops, ARR_BITWISE);
  }
  if (canonical === 'not') {
    if (ops.length !== 2) return null;
    return vectorShape(ops, ARR_BITWISE);
  }
  if (INT_UNARY_FULL.has(mnemonic)) {
    if (ops.length !== 2) return null;
    return vectorShape(ops, ARR_INT_FULL);
  }
  if (INT_TERNARY_FULL.has(mnemonic)) {
    if (ops.length !== 3) return null;
    return vectorShape(ops, ARR_INT_FULL);
  }
  if (INT_TERNARY_NO_D.has(mnemonic)) {
    if (ops.length !== 3) return null;
    return vectorShape(ops, ARR_INT_NO_D);
  }
  if (mnemonic === 'mul' || mnemonic === 'mla' || mnemonic === 'mls') {
    if (ops.length !== 3) return null;
    const byElement = ops[2]?.k === 'elem';
    const form = vectorShape(ops, byElement ? ARR_MUL_ELEM : ARR_INT_NO_D, { destinationIsInput:mnemonic !== 'mul', allowElement:byElement });
    if (!form) return null;
    if (byElement && form.sources[0]?.kind !== 'vector') return null;
    return form;
  }
  if (INT_COMPARE_ZERO.has(mnemonic)) {
    if (ops.length !== 3) return null;
    if (ops[2]?.k === 'imm') {
      const zero = immediateInteger(ops[2]);
      if (zero !== 0n || ops[2].shift) return null;
      const dst = arrangement(ops[0], ARR_INT_FULL);
      const src = dst && sameArrangement(ops[1], dst, ARR_INT_FULL, 'bitvector');
      return dst && src ? { dst, sources:[{kind:'vector',op:ops[1],info:src},{kind:'integer-zero',op:ops[2]}], sourceKind:'bitvector', resultKind:'bitvector', destinationIsInput:false } : null;
    }
    return vectorShape(ops, ARR_INT_FULL);
  }
  if (SHIFT_IMMEDIATE.has(mnemonic)) {
    if (ops.length !== 3) return null;
    const dst = arrangement(ops[0], ARR_INT_FULL);
    const src = dst && sameArrangement(ops[1], dst, ARR_INT_FULL, 'bitvector');
    const amount = immediateInteger(ops[2]);
    if (!dst || !src || amount == null || amount < 0n || ops[2].shift) return null;
    const max = BigInt(dst.elementBits);
    const valid = mnemonic === 'sshr' || mnemonic === 'ushr' || mnemonic === 'sri'
      ? amount >= 1n && amount <= max
      : amount < max;
    if (!valid) return null;
    return { dst, sources:[{kind:'vector',op:ops[1],info:src},{kind:'shift',op:ops[2],amount}], sourceKind:'bitvector', resultKind:'bitvector', destinationIsInput:mnemonic === 'sli' || mnemonic === 'sri' };
  }
  if (mnemonic === 'suqadd') {
    if (ops.length !== 2) return null;
    return vectorShape(ops, ARR_INT_FULL, { destinationIsInput:true });
  }

  if (FP_TERNARY.has(mnemonic)) {
    if (ops.length !== 3) return null;
    return vectorShape(ops, ARR_FP, { sourceKind:'float', resultKind:'float' });
  }
  if (FP_UNARY.has(mnemonic)) {
    if (ops.length !== 2) return null;
    return vectorShape(ops, ARR_FP, { sourceKind:'float', resultKind:'float' });
  }
  if (mnemonic === 'fmul' || mnemonic === 'fmla' || mnemonic === 'fmls') {
    if (ops.length !== 3) return null;
    const byElement = ops[2]?.k === 'elem';
    const form = vectorShape(ops, ARR_FP, { sourceKind:'float', resultKind:'float', destinationIsInput:mnemonic !== 'fmul', allowElement:byElement });
    if (!form) return null;
    if (ops[2]?.k === 'elem' && form.sources[0]?.kind !== 'vector') return null;
    return form;
  }
  if (FP_COMPARE.has(mnemonic) || FP_ABS_COMPARE.has(mnemonic)) {
    if (ops.length !== 3) return null;
    const dst = arrangement(ops[0], ARR_FP, 'bitvector');
    const lhs = dst && sameArrangement(ops[1], dst, ARR_FP, 'float');
    if (!dst || !lhs) return null;
    if (ops[2]?.k === 'imm') {
      if (FP_ABS_COMPARE.has(mnemonic) || !immediateFloatZero(ops[2], dst.elementBits)) return null;
      return { dst, sources:[{kind:'vector',op:ops[1],info:lhs},{kind:'float-zero',op:ops[2]}], sourceKind:'float', resultKind:'bitvector', destinationIsInput:false };
    }
    const rhs = sameArrangement(ops[2], dst, ARR_FP, 'float');
    return rhs ? { dst, sources:[{kind:'vector',op:ops[1],info:lhs},{kind:'vector',op:ops[2],info:rhs}], sourceKind:'float', resultKind:'bitvector', destinationIsInput:false } : null;
  }
  if (FP_TO_INT.has(mnemonic) || INT_TO_FP.has(mnemonic)) {
    if (ops.length !== 2 && ops.length !== 3) return null;
    const toInteger = FP_TO_INT.has(mnemonic);
    const dstKind = toInteger ? 'bitvector' : 'float';
    const sourceKind = toInteger ? 'float' : 'bitvector';
    const dst = arrangement(ops[0], ARR_FP, dstKind);
    const src = dst && sameArrangement(ops[1], dst, ARR_FP, sourceKind);
    if (!dst || !src) return null;
    const sources = [{kind:'vector',op:ops[1],info:src}];
    if (ops.length === 3) {
      const scale = immediateInteger(ops[2]);
      if (scale == null || scale < 1n || scale > BigInt(dst.elementBits) || ops[2].shift) return null;
      sources.push({kind:'scale',op:ops[2],amount:scale});
    }
    return { dst, sources, sourceKind, resultKind:dstKind, destinationIsInput:false };
  }
  return null;
}

function genericVectorIntrinsic(instruction, context, mnemonic, ops) {
  const form = genericForm(mnemonic, ops);
  if (!form) return partial(instruction, context, `${mnemonic}-operand-shape-invalid`);
  if (form.logicalImmediate) {
    const result = logicalImmediate(instruction, context, semanticMnemonic(mnemonic), ops);
    return result || partial(instruction, context, `${mnemonic}-logical-immediate-invalid`);
  }
  const operations = [];
  const inputs = [];
  const sourceOps = [];
  if (form.destinationIsInput) {
    const prior = appendVectorRead(operations, ops[0], form.dst, `${mnemonic}:prior`);
    if (!prior) return partial(instruction, context, `${mnemonic}-destination-read-unavailable`);
    inputs.push(prior);
    sourceOps.push(ops[0]);
  }
  for (let i = 0; i < form.sources.length; i++) {
    const source = form.sources[i];
    let value = null;
    if (source.kind === 'vector') {
      value = appendVectorRead(operations, source.op, source.info, `${mnemonic}:src${i}`);
      sourceOps.push(source.op);
    } else if (source.kind === 'element') {
      value = appendElementRead(operations, source.op, source.info, `${mnemonic}:src${i}`);
      sourceOps.push(source.op);
    } else if (source.kind === 'integer-zero') {
      value = createBitVectorValue(form.dst.elementBits, 0n);
    } else if (source.kind === 'float-zero') {
      value = immediateFloatZero(source.op, form.dst.elementBits);
    } else if (source.kind === 'shift' || source.kind === 'scale') {
      value = createBitVectorValue(7, source.amount);
    }
    if (!value) return partial(instruction, context, `${mnemonic}-source-unavailable`, ['registers','other'], operations);
    inputs.push(value);
  }

  const floating = FP_VECTOR_MNEMONICS.has(mnemonic);
  const usesFpStatus = floating && !FP_VECTOR_NO_STATUS.has(mnemonic);
  const usesSaturationStatus = SATURATING_MNEMONICS.has(mnemonic);
  let statusOutput = null;
  if (usesFpStatus) inputs.push(appendNamedRead(operations, FPCR, 32, `${mnemonic}:fpcr`));
  if (usesFpStatus || usesSaturationStatus) {
    inputs.push(appendNamedRead(operations, FPSR, 32, `${mnemonic}:fpsr`));
    statusOutput = temp(`${mnemonic}:fpsr-out`, createBitVectorValue(32));
  }

  const result = temp(`${mnemonic}:result`, form.dst.valueType);
  const outputs = statusOutput ? [result, statusOutput] : [result];
  const registersRead = registerIdsOf(sourceOps);
  if (usesFpStatus) registersRead.push(FPCR);
  if (usesFpStatus || usesSaturationStatus) registersRead.push(FPSR);
  const registersWritten = [`v${ops[0].num}`];
  if (statusOutput) registersWritten.push(FPSR);
  const summary = intrinsicSummary(inputs, outputs, registersRead, registersWritten, usesFpStatus ? 'input-dependent' : 'deterministic');
  operations.push(createMachineOperation({
    kind:'intrinsic', intrinsicId:`arm64.simd.${semanticMnemonic(mnemonic)}`, effectSummary:summary,
    metadata:{
      arrangement:form.dst.arr,
      laneCount:form.dst.laneCount,
      laneWidthBits:form.dst.elementBits,
      sourceElementKind:form.sourceKind,
      resultElementKind:form.resultKind,
      floating,
      saturation:usesSaturationStatus,
      laneSemantics:'fixed-width',
      destinationSemantics:form.destinationIsInput ? 'read-modify-write' : 'replace',
    },
  }));
  appendVectorWrite(operations, ops[0], form.dst, result, `${mnemonic}:dst`);
  if (statusOutput) appendNamedWrite(operations, FPSR, 32, statusOutput);
  return bundle(instruction, context, {
    operations,
    completeness:'exact-with-intrinsic',
    metadata:{ arrangement:form.dst.arr, laneCount:form.dst.laneCount, laneWidthBits:form.dst.elementBits, sourceElementKind:form.sourceKind, resultElementKind:form.resultKind },
  });
}

function scalarSimdEffects(instruction, context, mnemonic, ops) {
  const integerD = new Set([64]);
  const scalarBits = new Set([8,16,32,64]);
  const floatBits = new Set([16,32,64]);
  let dstInfo = null;
  let sourceSpecs = null;
  let destinationIsInput = false;
  let resultKind = 'bitvector';
  let sourceKind = 'bitvector';
  let saturation = false;
  let floating = false;
  let metadata = {};

  if (SCALAR_INT_D_TERNARY.has(mnemonic)) {
    if (ops.length !== 3) return partial(instruction, context, `${mnemonic}-scalar-operand-count-invalid`);
    dstInfo = scalarSimdInfo(ops[0], integerD);
    const lhs = sameScalarSimdInfo(ops[1], dstInfo, integerD);
    const rhs = sameScalarSimdInfo(ops[2], dstInfo, integerD);
    if (!dstInfo || !lhs || !rhs) return partial(instruction, context, `${mnemonic}-scalar-shape-invalid`);
    sourceSpecs = [{op:ops[1],info:lhs},{op:ops[2],info:rhs}];
  } else if (SCALAR_INT_D_UNARY.has(mnemonic)) {
    if (ops.length !== 2) return partial(instruction, context, `${mnemonic}-scalar-operand-count-invalid`);
    dstInfo = scalarSimdInfo(ops[0], integerD);
    const src = sameScalarSimdInfo(ops[1], dstInfo, integerD);
    if (!dstInfo || !src) return partial(instruction, context, `${mnemonic}-scalar-shape-invalid`);
    sourceSpecs = [{op:ops[1],info:src}];
  } else if (SCALAR_INT_COMPARE.has(mnemonic)) {
    if (ops.length !== 3) return partial(instruction, context, `${mnemonic}-scalar-operand-count-invalid`);
    dstInfo = scalarSimdInfo(ops[0], integerD);
    const lhs = sameScalarSimdInfo(ops[1], dstInfo, integerD);
    if (!dstInfo || !lhs) return partial(instruction, context, `${mnemonic}-scalar-shape-invalid`);
    if (ops[2]?.k === 'imm') {
      if (immediateInteger(ops[2]) !== 0n || ops[2].shift) return partial(instruction, context, `${mnemonic}-scalar-zero-invalid`);
      sourceSpecs = [{op:ops[1],info:lhs},{constant:createBitVectorValue(64,0n)}];
    } else {
      const rhs = sameScalarSimdInfo(ops[2], dstInfo, integerD);
      if (!rhs) return partial(instruction, context, `${mnemonic}-scalar-shape-invalid`);
      sourceSpecs = [{op:ops[1],info:lhs},{op:ops[2],info:rhs}];
    }
  } else if (SCALAR_SAT_TERNARY.has(mnemonic)) {
    if (ops.length !== 3) return partial(instruction, context, `${mnemonic}-scalar-operand-count-invalid`);
    dstInfo = scalarSimdInfo(ops[0], scalarBits);
    const lhs = sameScalarSimdInfo(ops[1], dstInfo, scalarBits);
    const rhs = sameScalarSimdInfo(ops[2], dstInfo, scalarBits);
    if (!dstInfo || !lhs || !rhs) return partial(instruction, context, `${mnemonic}-scalar-shape-invalid`);
    sourceSpecs = [{op:ops[1],info:lhs},{op:ops[2],info:rhs}];
    saturation = true;
  } else if (SCALAR_SAT_UNARY.has(mnemonic)) {
    if (ops.length !== 2) return partial(instruction, context, `${mnemonic}-scalar-operand-count-invalid`);
    dstInfo = scalarSimdInfo(ops[0], scalarBits);
    const src = sameScalarSimdInfo(ops[1], dstInfo, scalarBits);
    if (!dstInfo || !src) return partial(instruction, context, `${mnemonic}-scalar-shape-invalid`);
    sourceSpecs = [{op:ops[1],info:src}];
    destinationIsInput = true;
    saturation = true;
  } else if (SCALAR_SHIFT_IMMEDIATE.has(mnemonic)) {
    if (ops.length !== 3) return partial(instruction, context, `${mnemonic}-scalar-operand-count-invalid`);
    dstInfo = scalarSimdInfo(ops[0], integerD);
    const src = sameScalarSimdInfo(ops[1], dstInfo, integerD);
    const amount = immediateInteger(ops[2]);
    if (!dstInfo || !src || amount == null || ops[2].shift) return partial(instruction, context, `${mnemonic}-scalar-shape-invalid`);
    const valid = ['sshr','ushr','sri'].includes(mnemonic) ? amount >= 1n && amount <= 64n : amount >= 0n && amount < 64n;
    if (!valid) return partial(instruction, context, `${mnemonic}-scalar-shift-invalid`);
    sourceSpecs = [{op:ops[1],info:src},{constant:createBitVectorValue(7,amount)}];
    destinationIsInput = mnemonic === 'sli' || mnemonic === 'sri';
    metadata.shiftAmount = Number(amount);
  } else if (SCALAR_FP_COMPARE.has(mnemonic)) {
    if (ops.length !== 3) return partial(instruction, context, `${mnemonic}-scalar-operand-count-invalid`);
    dstInfo = scalarSimdInfo(ops[0], floatBits, 'bitvector');
    const lhs = sameScalarSimdInfo(ops[1], dstInfo, floatBits, 'float');
    if (!dstInfo || !lhs) return partial(instruction, context, `${mnemonic}-scalar-fp-shape-invalid`);
    sourceKind = 'float'; resultKind = 'bitvector'; floating = true;
    if (ops[2]?.k === 'imm') {
      if (!FP_COMPARE.has(mnemonic) || !immediateFloatZero(ops[2], dstInfo.widthBits)) return partial(instruction, context, `${mnemonic}-scalar-fp-zero-invalid`);
      sourceSpecs = [{op:ops[1],info:lhs},{constant:immediateFloatZero(ops[2],dstInfo.widthBits)}];
    } else {
      const rhs = sameScalarSimdInfo(ops[2], dstInfo, floatBits, 'float');
      if (!rhs) return partial(instruction, context, `${mnemonic}-scalar-fp-shape-invalid`);
      sourceSpecs = [{op:ops[1],info:lhs},{op:ops[2],info:rhs}];
    }
  } else if (mnemonic === 'addp') {
    if (ops.length !== 2) return partial(instruction, context, 'addp-scalar-operand-count-invalid');
    dstInfo = scalarSimdInfo(ops[0], integerD);
    const src = arrangement(ops[1], new Set(['2d']));
    if (!dstInfo || !src) return partial(instruction, context, 'addp-scalar-shape-invalid');
    const operations = [];
    const input = appendVectorRead(operations, ops[1], src, 'addp:scalar-src');
    const result = temp('addp:scalar-result', createBitVectorValue(64));
    const summary = intrinsicSummary([input], [result], [`v${ops[1].num}`], [`v${ops[0].num}`]);
    operations.push(createMachineOperation({ kind:'intrinsic', intrinsicId:'arm64.simd.addp.scalar', effectSummary:summary, metadata:{ sourceArrangement:'2d', resultWidthBits:64 } }));
    appendScalarVectorWrite(operations, ops[0], 64, result, 'addp:scalar-dst', { destinationSemantics:'replace-and-zero-upper' });
    return bundle(instruction, context, { operations, completeness:'exact-with-intrinsic', metadata:{ scalarSimd:true, sourceArrangement:'2d', resultWidthBits:64 } });
  } else if (SCALAR_NARROW.has(mnemonic)) {
    if (ops.length !== 2) return partial(instruction, context, `${mnemonic}-scalar-operand-count-invalid`);
    const mapping = new Map([[8,16],[16,32],[32,64]]);
    dstInfo = scalarSimdInfo(ops[0], new Set(mapping.keys()));
    const sourceBits = dstInfo ? mapping.get(dstInfo.widthBits) : null;
    const src = sourceBits ? scalarSimdInfo(ops[1], new Set([sourceBits])) : null;
    if (!dstInfo || !src) return partial(instruction, context, `${mnemonic}-scalar-narrow-shape-invalid`);
    const operations = [];
    const input = appendScalarVectorRead(operations, ops[1], src, `${mnemonic}:scalar-src`);
    const fpsr = appendNamedRead(operations, FPSR, 32, `${mnemonic}:scalar-fpsr`);
    const result = temp(`${mnemonic}:scalar-result`, createBitVectorValue(dstInfo.widthBits));
    const status = temp(`${mnemonic}:scalar-fpsr-out`, createBitVectorValue(32));
    const summary = intrinsicSummary([input,fpsr], [result,status], [`v${ops[1].num}`,FPSR], [`v${ops[0].num}`,FPSR]);
    operations.push(createMachineOperation({ kind:'intrinsic', intrinsicId:`arm64.simd.${mnemonic}.scalar`, effectSummary:summary, metadata:{ sourceWidthBits:src.widthBits, resultWidthBits:dstInfo.widthBits, saturation:true } }));
    appendScalarVectorWrite(operations, ops[0], dstInfo.widthBits, result, `${mnemonic}:scalar-dst`, { destinationSemantics:'replace-and-zero-upper' });
    appendNamedWrite(operations, FPSR, 32, status);
    return bundle(instruction, context, { operations, completeness:'exact-with-intrinsic', metadata:{ scalarSimd:true, sourceWidthBits:src.widthBits, resultWidthBits:dstInfo.widthBits, saturation:true } });
  } else {
    return null;
  }

  const operations = [];
  const inputs = [];
  const sourceOps = [];
  if (destinationIsInput) {
    inputs.push(appendScalarVectorRead(operations, ops[0], dstInfo, `${mnemonic}:scalar-prior`));
    sourceOps.push(ops[0]);
  }
  for (const spec of sourceSpecs) {
    if (spec.constant) inputs.push(spec.constant);
    else {
      const value = appendScalarVectorRead(operations, spec.op, spec.info, `${mnemonic}:scalar-src${inputs.length}`);
      if (!value) return partial(instruction, context, `${mnemonic}-scalar-source-unavailable`, ['registers','other'], operations);
      inputs.push(value); sourceOps.push(spec.op);
    }
  }
  let statusOutput = null;
  if (floating) inputs.push(appendNamedRead(operations, FPCR, 32, `${mnemonic}:scalar-fpcr`));
  if (floating || saturation) {
    inputs.push(appendNamedRead(operations, FPSR, 32, `${mnemonic}:scalar-fpsr`));
    statusOutput = temp(`${mnemonic}:scalar-fpsr-out`, createBitVectorValue(32));
  }
  const resultType = resultKind === 'float' ? createFloatValue(dstInfo.widthBits, FLOAT_FORMAT[dstInfo.widthBits]) : createBitVectorValue(dstInfo.widthBits);
  const result = temp(`${mnemonic}:scalar-result`, resultType);
  const outputs = statusOutput ? [result,statusOutput] : [result];
  const reads = registerIdsOf(sourceOps);
  if (floating) reads.push(FPCR);
  if (floating || saturation) reads.push(FPSR);
  const writes = [`v${ops[0].num}`];
  if (statusOutput) writes.push(FPSR);
  const summary = intrinsicSummary(inputs, outputs, reads, writes, floating ? 'input-dependent' : 'deterministic');
  operations.push(createMachineOperation({
    kind:'intrinsic', intrinsicId:`arm64.simd.${mnemonic}.scalar`, effectSummary:summary,
    metadata:{ scalarSimd:true, widthBits:dstInfo.widthBits, sourceElementKind:sourceKind, resultElementKind:resultKind, saturation, destinationSemantics:destinationIsInput?'read-modify-write':'replace', ...metadata },
  }));
  appendScalarVectorWrite(operations, ops[0], dstInfo.widthBits, result, `${mnemonic}:scalar-dst`, { destinationSemantics:destinationIsInput?'read-modify-write':'replace-and-zero-upper' });
  if (statusOutput) appendNamedWrite(operations, FPSR, 32, statusOutput);
  return bundle(instruction, context, { operations, completeness:'exact-with-intrinsic', metadata:{ scalarSimd:true, widthBits:dstInfo.widthBits, sourceElementKind:sourceKind, resultElementKind:resultKind, saturation, ...metadata } });
}

const REDUCTION_RESULT = Object.freeze({
  addv:Object.freeze({ '8b':8, '16b':8, '4h':16, '8h':16, '4s':32 }),
  smaxv:Object.freeze({ '8b':8, '16b':8, '4h':16, '8h':16, '4s':32 }),
  sminv:Object.freeze({ '8b':8, '16b':8, '4h':16, '8h':16, '4s':32 }),
  umaxv:Object.freeze({ '8b':8, '16b':8, '4h':16, '8h':16, '4s':32 }),
  uminv:Object.freeze({ '8b':8, '16b':8, '4h':16, '8h':16, '4s':32 }),
  uaddlv:Object.freeze({ '8b':16, '16b':16, '4h':32, '8h':32, '4s':64 }),
  saddlv:Object.freeze({ '8b':16, '16b':16, '4h':32, '8h':32, '4s':64 }),
});
function reduction(instruction, context, mnemonic, ops) {
  if (ops.length !== 2) return partial(instruction, context, `${mnemonic}-reduction-operand-count-invalid`);
  const dst = ops[0];
  const src = ops[1];
  const srcArrangement = arrangement(src, ARR_INT_NO_D);
  const resultBits = srcArrangement ? REDUCTION_RESULT[mnemonic]?.[srcArrangement.arr] : null;
  if (!resultBits || dst?.k !== 'reg' || dst.cls !== 'fp' || !validRegisterNumber(dst) || dst.bits !== resultBits) {
    return partial(instruction, context, `${mnemonic}-reduction-shape-invalid`);
  }
  const operations = [];
  const source = appendVectorRead(operations, src, srcArrangement, `${mnemonic}:src`);
  const result = temp(`${mnemonic}:result`, createBitVectorValue(resultBits));
  const summary = intrinsicSummary([source], [result], [`v${src.num}`], [`v${dst.num}`]);
  operations.push(createMachineOperation({
    kind:'intrinsic', intrinsicId:`arm64.simd.${mnemonic}`, effectSummary:summary,
    metadata:{ sourceArrangement:srcArrangement.arr, resultWidthBits:resultBits },
  }));
  appendScalarVectorWrite(operations, dst, resultBits, result, `${mnemonic}:dst`);
  return bundle(instruction, context, { operations, completeness:'exact-with-intrinsic', metadata:{ sourceArrangement:srcArrangement.arr, resultWidthBits:resultBits } });
}

function narrow(instruction, context, mnemonic, ops) {
  if (ops.length !== 2) return partial(instruction, context, `${mnemonic}-narrow-operand-count-invalid`);
  const high = mnemonic.endsWith('2');
  const mapping = high ? ARR_NARROW_HIGH : ARR_NARROW_LOW;
  const dst = ops[0];
  const src = ops[1];
  const dstArrangement = parseArrangement(dst);
  const expectedSource = dstArrangement ? mapping[dstArrangement.arr] : null;
  const srcArrangement = expectedSource ? parseArrangement(src) : null;
  if (!dstArrangement || !srcArrangement || srcArrangement.arr !== expectedSource) {
    return partial(instruction, context, `${mnemonic}-narrow-arrangement-invalid`);
  }
  const operations = [];
  const inputs = [];
  const sourceOps = [];
  if (high) {
    const prior = appendVectorRead(operations, dst, dstArrangement, `${mnemonic}:prior`);
    inputs.push(prior); sourceOps.push(dst);
  }
  const source = appendVectorRead(operations, src, srcArrangement, `${mnemonic}:src`);
  inputs.push(source); sourceOps.push(src);
  const saturation = SATURATING_MNEMONICS.has(mnemonic);
  let statusOutput = null;
  if (saturation) {
    inputs.push(appendNamedRead(operations, FPSR, 32, `${mnemonic}:fpsr`));
    statusOutput = temp(`${mnemonic}:fpsr-out`, createBitVectorValue(32));
  }
  const result = temp(`${mnemonic}:result`, dstArrangement.valueType);
  const outputs = statusOutput ? [result,statusOutput] : [result];
  const reads = registerIdsOf(sourceOps); if (saturation) reads.push(FPSR);
  const writes = [`v${dst.num}`]; if (saturation) writes.push(FPSR);
  const summary = intrinsicSummary(inputs, outputs, reads, writes);
  operations.push(createMachineOperation({
    kind:'intrinsic', intrinsicId:`arm64.simd.${mnemonic}`, effectSummary:summary,
    metadata:{ sourceArrangement:srcArrangement.arr, destinationArrangement:dstArrangement.arr, laneWidthBits:dstArrangement.elementBits, destinationSemantics:high?'merge-high-half':'replace-low-and-zero-upper', saturation },
  }));
  appendVectorWrite(operations, dst, dstArrangement, result, `${mnemonic}:dst`, { destinationSemantics:high?'merge-high-half':'replace-low-and-zero-upper' });
  if (statusOutput) appendNamedWrite(operations, FPSR, 32, statusOutput);
  return bundle(instruction, context, { operations, completeness:'exact-with-intrinsic', metadata:{ sourceArrangement:srcArrangement.arr, arrangement:dstArrangement.arr, laneWidthBits:dstArrangement.elementBits, destinationSemantics:high?'merge-high-half':'replace-low-and-zero-upper' } });
}

function tableListValid(list) {
  if (list?.k !== 'list' || !Array.isArray(list.regs) || list.regs.length < 1 || list.regs.length > 4) return false;
  for (let index = 0; index < list.regs.length; index++) {
    const reg = list.regs[index];
    const info = arrangement(reg, new Set(['16b']));
    if (!info) return false;
    if (index > 0 && reg.num !== ((list.regs[0].num + index) & 31)) return false;
  }
  return true;
}
function tableOrPermute(instruction, context, mnemonic, ops) {
  const canonical = semanticMnemonic(mnemonic);
  if (canonical === 'tbl' || canonical === 'tbx') {
    if (ops.length !== 3) return partial(instruction, context, `${mnemonic}-table-operand-count-invalid`);
    const dst = ops[0], table = ops[1], index = ops[2];
    const dstArrangement = arrangement(dst, ARR_TABLE);
    const indexArrangement = dstArrangement && sameArrangement(index, dstArrangement, ARR_TABLE, 'bitvector');
    if (!dstArrangement || !indexArrangement || !tableListValid(table)) return partial(instruction, context, `${mnemonic}-table-shape-invalid`);
    const operations = [];
    const inputs = [];
    const sourceOps = [];
    if (canonical === 'tbx') {
      inputs.push(appendVectorRead(operations, dst, dstArrangement, `${mnemonic}:prior`)); sourceOps.push(dst);
    }
    for (let i = 0; i < table.regs.length; i++) {
      const info = arrangement(table.regs[i], new Set(['16b']));
      inputs.push(appendVectorRead(operations, table.regs[i], info, `${mnemonic}:table${i}`)); sourceOps.push(table.regs[i]);
    }
    inputs.push(appendVectorRead(operations, index, indexArrangement, `${mnemonic}:index`)); sourceOps.push(index);
    const result = temp(`${mnemonic}:result`, dstArrangement.valueType);
    const summary = intrinsicSummary(inputs, [result], registerIdsOf(sourceOps), [`v${dst.num}`]);
    operations.push(createMachineOperation({
      kind:'intrinsic', intrinsicId:`arm64.simd.${canonical}`, effectSummary:summary,
      metadata:{ arrangement:dstArrangement.arr, tableRegisterCount:table.regs.length, destinationSemantics:canonical === 'tbx'?'merge-out-of-range-index':'zero-out-of-range-index' },
    }));
    appendVectorWrite(operations, dst, dstArrangement, result, `${mnemonic}:dst`);
    return bundle(instruction, context, { operations, completeness:'exact-with-intrinsic', metadata:{ arrangement:dstArrangement.arr, tableRegisterCount:table.regs.length, destinationSemantics:canonical === 'tbx'?'merge':'replace' } });
  }

  if (canonical === 'ext') {
    if (ops.length !== 4) return partial(instruction, context, `${mnemonic}-ext-operand-count-invalid`);
    const dst = arrangement(ops[0], ARR_BITWISE);
    const lhs = dst && sameArrangement(ops[1], dst, ARR_BITWISE, 'bitvector');
    const rhs = dst && sameArrangement(ops[2], dst, ARR_BITWISE, 'bitvector');
    const offset = immediateInteger(ops[3]);
    if (!dst || !lhs || !rhs || offset == null || offset < 0n || offset >= BigInt(dst.laneCount) || ops[3].shift) {
      return partial(instruction, context, `${mnemonic}-ext-shape-invalid`);
    }
    const operations = [];
    const a = appendVectorRead(operations, ops[1], lhs, `${mnemonic}:src0`);
    const b = appendVectorRead(operations, ops[2], rhs, `${mnemonic}:src1`);
    const amount = createBitVectorValue(4, offset);
    const result = temp(`${mnemonic}:result`, dst.valueType);
    const summary = intrinsicSummary([a,b,amount], [result], registerIdsOf([ops[1],ops[2]]), [`v${ops[0].num}`]);
    operations.push(createMachineOperation({ kind:'intrinsic', intrinsicId:'arm64.simd.ext', effectSummary:summary, metadata:{ arrangement:dst.arr, byteOffset:Number(offset) } }));
    appendVectorWrite(operations, ops[0], dst, result, `${mnemonic}:dst`);
    return bundle(instruction, context, { operations, completeness:'exact-with-intrinsic', metadata:{ arrangement:dst.arr, byteOffset:Number(offset) } });
  }

  const allowed = canonical === 'rev64' ? ARR_REV64 : ARR_INT_FULL;
  const expectedCount = canonical === 'rev64' ? 2 : 3;
  if (ops.length !== expectedCount) return partial(instruction, context, `${mnemonic}-permute-operand-count-invalid`);
  const form = vectorShape(ops, allowed);
  if (!form) return partial(instruction, context, `${mnemonic}-permute-shape-invalid`);
  const operations = [];
  const inputs = form.sources.map((source,index) => appendVectorRead(operations, source.op, source.info, `${mnemonic}:src${index}`));
  const result = temp(`${mnemonic}:result`, form.dst.valueType);
  const summary = intrinsicSummary(inputs, [result], registerIdsOf(form.sources.map(({op})=>op)), [`v${ops[0].num}`]);
  operations.push(createMachineOperation({ kind:'intrinsic', intrinsicId:`arm64.simd.${canonical}`, effectSummary:summary, metadata:{ arrangement:form.dst.arr } }));
  appendVectorWrite(operations, ops[0], form.dst, result, `${mnemonic}:dst`);
  return bundle(instruction, context, { operations, completeness:'exact-with-intrinsic', metadata:{ arrangement:form.dst.arr, laneWidthBits:form.dst.elementBits } });
}

export function liftArm64SimdEffects(instruction, context = {}) {
  const mnemonic = mnemonicOf(instruction);
  const ops = operandsOf(instruction);

  if (MEMORY_FAMILIES.test(mnemonic)) return null;
  if (isSve(instruction, ops)) {
    if (hasVectorOperand(ops) || OWNED.has(mnemonic) || /^(?:f|s|u|sq|uq)/.test(mnemonic)) {
      return partial(instruction, context, 'arm64-sve-scalable-vector-semantics-unsupported', ['registers','flags','other']);
    }
    return null;
  }
  if (ops.some(hasForbiddenSimdRegisterModifier)) {
    return partial(instruction, context, 'arm64-simd-register-modifier-unencodable', ['registers','flags','other']);
  }
  if (mnemonic === 'addp' && ops[0]?.k === 'reg' && ops[0].cls === 'fp') return scalarSimdEffects(instruction, context, mnemonic, ops);
  if (!hasVectorOperand(ops)) {
    if (!hasScalarSimdOperand(ops)) return null;
    return scalarSimdEffects(instruction, context, mnemonic, ops);
  }

  if (LANE_MNEMONICS.has(mnemonic)) return laneEffects(instruction, context, mnemonic, ops);
  if (IMMEDIATE_MNEMONICS.has(mnemonic)) return vectorImmediate(instruction, context, mnemonic, ops);
  if (REDUCE_MNEMONICS.has(mnemonic)) return reduction(instruction, context, mnemonic, ops);
  if (NARROW_MNEMONICS.has(mnemonic)) return narrow(instruction, context, mnemonic, ops);
  if (PERMUTE_MNEMONICS.has(mnemonic)) return tableOrPermute(instruction, context, mnemonic, ops);
  if (INTEGER_VECTOR_MNEMONICS.has(mnemonic) || FP_VECTOR_MNEMONICS.has(mnemonic)) return genericVectorIntrinsic(instruction, context, mnemonic, ops);

  return partial(instruction, context, `arm64-simd-instruction-unsupported:${mnemonic || 'unknown'}`, ['registers','flags','other']);
}

export const arm64SimdMachineEffects = liftArm64SimdEffects;
