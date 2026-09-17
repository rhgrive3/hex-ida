import { dexTypeInfo } from './descriptor.js';
import { fail } from './validation-utils.js';

const I32 = Object.freeze({ kind:'bitvector', widthBits:32 });
const REF = Object.freeze({ kind:'address', widthBits:32, addressSpace:'managed-heap' });
const ARRAY_VARIANTS = Object.freeze([
  { suffix:'', byteWidth:4, bits:32, type:I32, extension:null },
  { suffix:'-wide', byteWidth:8, bits:64, type:Object.freeze({ kind:'bitvector', widthBits:64 }), extension:null },
  { suffix:'-object', byteWidth:4, bits:32, type:REF, extension:null, object:true },
  { suffix:'-boolean', byteWidth:1, bits:32, type:I32, extension:'zero' },
  { suffix:'-byte', byteWidth:1, bits:32, type:I32, extension:'sign' },
  { suffix:'-char', byteWidth:2, bits:32, type:I32, extension:'zero' },
  { suffix:'-short', byteWidth:2, bits:32, type:I32, extension:'sign' },
]);

const reg = (index, bits = 32, type = I32) => ({ kind:'register', index, bits, type });
const typeAt = (image, index) => {
  const descriptor = image.types?.[index];
  if (descriptor == null) fail('dex-reference-index-out-of-range');
  return descriptor;
};
const referenceType = (descriptor, reason = 'dex-reference-type-required') => {
  const info = dexTypeInfo(descriptor);
  if (info.category !== 'object') fail(reason);
  return info;
};
const arrayType = (descriptor, reason = 'dex-array-type-required') => {
  if (typeof descriptor !== 'string' || descriptor[0] !== '[') fail(reason);
  const info = dexTypeInfo(descriptor);
  const elementDescriptor = descriptor.slice(1);
  const element = dexTypeInfo(elementDescriptor);
  return { descriptor, info, elementDescriptor, element };
};

function arrayAccess(opcode, formatByte, view, insnsStart, pc) {
  if (opcode < 0x44 || opcode > 0x51) return null;
  const relative = opcode - 0x44;
  const isWrite = relative >= 7;
  const variant = ARRAY_VARIANTS[relative % 7];
  const packed = view.getUint16(insnsStart + (pc + 1) * 2, true);
  const valueRegister = formatByte;
  const arrayRegister = packed & 0xff;
  const indexRegister = packed >>> 8;
  const reads = [reg(arrayRegister, 32, REF), reg(indexRegister)];
  if (isWrite) reads.push(reg(valueRegister, variant.bits, variant.type));
  return {
    mnemonic:`a${isWrite ? 'put' : 'get'}${variant.suffix}`,
    consumedValues:[],
    producedValues:isWrite ? [] : [{ bits:variant.byteWidth * 8, type:variant.extension ? { kind:'bitvector', widthBits:variant.byteWidth * 8 } : variant.type }],
    locationReads:reads,
    locationWrites:isWrite ? [] : [reg(valueRegister, variant.bits, variant.type)],
    memoryEffects:[{
      space:'array-element', isWrite, byteWidth:variant.byteWidth,
      valueBits:variant.bits, valueType:variant.type, extension:variant.extension,
      bindingVersion:2, addressKind:'array-element', arrayReadIndex:0, indexReadIndex:1,
      valueReadIndex:isWrite ? 2 : null, variant:variant.suffix || '-int',
      receiverNullException:true, boundsException:true,
    }],
    callEffects:[], controlEffects:[],
    possibleExceptions:[
      'java/lang/NullPointerException',
      'java/lang/ArrayIndexOutOfBoundsException',
      ...(isWrite && variant.object ? ['java/lang/ArrayStoreException'] : []),
    ],
    completeness:'exact', unknownEffects:[],
  };
}

function filledArray({ opcode, formatByte, view, insnsStart, pc, image, operationId, instructionLength }) {
  if (opcode !== 0x24 && opcode !== 0x25) return null;
  const descriptor = typeAt(image, view.getUint16(insnsStart + (pc + 1) * 2, true));
  const { element } = arrayType(descriptor);
  if (element.words !== 1) fail('dex-filled-new-array-wide-element-unsupported');
  let registers;
  if (opcode === 0x24) {
    const count = formatByte >>> 4;
    if (count > 5) fail('dex-filled-new-array-register-count-invalid');
    const packed = view.getUint16(insnsStart + (pc + 2) * 2, true);
    registers = [packed & 15, (packed >>> 4) & 15, (packed >>> 8) & 15, (packed >>> 12) & 15, formatByte & 15].slice(0, count);
  } else {
    const count = formatByte;
    const first = view.getUint16(insnsStart + (pc + 2) * 2, true);
    registers = Array.from({ length:count }, (_, index) => first + index);
  }
  const elementType = element.category === 'object' ? REF : I32;
  const nextResult = { category:'object', bits:32, words:1, type:REF, nextOffset:pc * 2 + instructionLength * 2, producerOperationId:operationId };
  return {
    effect:{
      mnemonic:opcode === 0x24 ? 'filled-new-array' : 'filled-new-array/range',
      consumedValues:[], producedValues:[{ bits:32, type:REF, arrayType:descriptor, allocationSiteId:operationId }],
      locationReads:registers.map((index) => reg(index, 32, elementType)),
      locationWrites:[{ kind:'runtime', name:'result', bits:32, type:REF }],
      memoryEffects:[], callEffects:[], controlEffects:[{ kind:'barrier', synchronization:'monitor', action:opcode === 0x1d ? 'enter' : 'exit' }],
      possibleExceptions:element.category === 'object' ? ['java/lang/ArrayStoreException'] : [],
      completeness:'exact', unknownEffects:[],
      metadata:{ arrayType:descriptor, elementType:element.descriptor, allocationSiteId:operationId, elementCount:registers.length },
    },
    nextResult,
  };
}

function fillArrayData({ formatByte, view, insnsStart, insnsSize, pc, controlIndex }) {
  const arrayRegister = formatByte;
  const payloadPc = pc + view.getInt32(insnsStart + (pc + 1) * 2, true);
  if (!Number.isSafeInteger(payloadPc) || payloadPc < 0 || payloadPc >= insnsSize) fail('dex-fill-array-data-payload-out-of-range');
  if ((payloadPc & 1) !== 0) fail('dex-fill-array-data-payload-misaligned');
  const payloadOffset = payloadPc * 2;
  const payload = controlIndex.payloads.get(payloadOffset);
  if (!payload) fail(controlIndex.scanComplete ? 'dex-fill-array-data-payload-not-data-boundary' : 'dex-control-flow-boundary-authority-incomplete');
  if (payload.signature !== 0x03) fail('dex-fill-array-data-payload-kind-mismatch');
  const p = insnsStart + payloadOffset;
  const elementWidth = view.getUint16(p + 2, true);
  const elementCount = view.getUint32(p + 4, true);
  if (![1,2,4,8].includes(elementWidth)) fail('dex-fill-array-data-element-width-invalid');
  const byteLength = elementWidth * elementCount;
  return {
    mnemonic:'fill-array-data', consumedValues:[], producedValues:[],
    locationReads:[reg(arrayRegister, 32, REF)], locationWrites:[],
    memoryEffects:[{
      space:'array-element', isWrite:true, byteWidth:elementWidth,
      valueBits:elementWidth * 8, valueType:{ kind:'bitvector', widthBits:elementWidth * 8 },
      bindingVersion:2, addressKind:'array-data', arrayReadIndex:0, indexReadIndex:null, valueReadIndex:null,
      receiverNullException:true, payloadOffset, elementWidth, elementCount, byteLength, bulk:true,
    }],
    callEffects:[], controlEffects:[], possibleExceptions:['java/lang/NullPointerException'],
    completeness:'partial',
    unknownEffects:[{ category:'memory', reason:'dex-fill-array-data-bulk-write-summary' }],
    metadata:{ payloadOffset, elementWidth, elementCount, byteLength },
  };
}

export function dexArrayTypeEffects(args) {
  const { opcode, formatByte, view, insnsStart, pc, image, operationId, instructionLength, insnsSize, controlIndex } = args;
  const access = arrayAccess(opcode, formatByte, view, insnsStart, pc);
  if (access) return { effect:access, nextResult:null };
  if (opcode === 0x1d || opcode === 0x1e) {
    return { effect:{
      mnemonic:opcode === 0x1d ? 'monitor-enter' : 'monitor-exit',
      consumedValues:[], producedValues:[], locationReads:[reg(formatByte, 32, REF)], locationWrites:[],
      memoryEffects:[], callEffects:[], controlEffects:[],
      possibleExceptions:opcode === 0x1d
        ? ['java/lang/NullPointerException']
        : ['java/lang/NullPointerException','java/lang/IllegalMonitorStateException'],
      completeness:'exact', unknownEffects:[], metadata:{ synchronization:true },
    }, nextResult:null };
  }
  if (opcode === 0x1f) {
    const descriptor = typeAt(image, view.getUint16(insnsStart + (pc + 1) * 2, true));
    referenceType(descriptor, 'dex-check-cast-reference-type-required');
    return { effect:{
      mnemonic:'check-cast', consumedValues:[], producedValues:[{ bits:32, type:REF, castType:descriptor }],
      locationReads:[reg(formatByte,32,REF)], locationWrites:[reg(formatByte,32,REF)],
      memoryEffects:[], callEffects:[], controlEffects:[], possibleExceptions:['java/lang/ClassCastException'],
      completeness:'exact', unknownEffects:[], metadata:{ typeDescriptor:descriptor },
    }, nextResult:null };
  }
  if (opcode === 0x20) {
    const descriptor = typeAt(image, view.getUint16(insnsStart + (pc + 1) * 2, true));
    referenceType(descriptor, 'dex-instance-of-reference-type-required');
    const dst = formatByte & 15, src = formatByte >>> 4;
    return { effect:{
      mnemonic:'instance-of', consumedValues:[], producedValues:[{ bits:32, type:I32, valueType:'boolean' }],
      locationReads:[reg(src,32,REF)], locationWrites:[reg(dst)], memoryEffects:[], callEffects:[], controlEffects:[], possibleExceptions:[],
      completeness:'exact', unknownEffects:[], metadata:{ typeDescriptor:descriptor },
    }, nextResult:null };
  }
  if (opcode === 0x21) {
    const dst = formatByte & 15, src = formatByte >>> 4;
    return { effect:{
      mnemonic:'array-length', consumedValues:[], producedValues:[{ bits:32, type:I32 }],
      locationReads:[reg(src,32,REF)], locationWrites:[reg(dst)], memoryEffects:[], callEffects:[], controlEffects:[],
      possibleExceptions:['java/lang/NullPointerException'], completeness:'exact', unknownEffects:[],
    }, nextResult:null };
  }
  if (opcode === 0x23) {
    const descriptor = typeAt(image, view.getUint16(insnsStart + (pc + 1) * 2, true));
    const { element } = arrayType(descriptor);
    const dst = formatByte & 15, size = formatByte >>> 4;
    return { effect:{
      mnemonic:'new-array', consumedValues:[], producedValues:[{ bits:32, type:REF, arrayType:descriptor, allocationSiteId:operationId }],
      locationReads:[reg(size)], locationWrites:[reg(dst,32,REF)], memoryEffects:[], callEffects:[], controlEffects:[],
      possibleExceptions:['java/lang/NegativeArraySizeException'], completeness:'exact', unknownEffects:[],
      metadata:{ arrayType:descriptor, elementType:element.descriptor, allocationSiteId:operationId },
    }, nextResult:null };
  }
  const filled = filledArray(args);
  if (filled) return filled;
  if (opcode === 0x26) return { effect:fillArrayData({ formatByte, view, insnsStart, insnsSize, pc, controlIndex }), nextResult:null };
  return null;
}
