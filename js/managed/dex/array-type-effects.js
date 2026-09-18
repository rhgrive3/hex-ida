import { dexTypeInfo } from './descriptor.js';

const ADDRESS_TYPE = Object.freeze({ kind:'address', widthBits:32, addressSpace:'managed-heap' });
const I32_TYPE = Object.freeze({ kind:'bitvector', widthBits:32 });
const ARRAY_VARIANTS = Object.freeze([
  Object.freeze({ suffix:'', descriptor:'I', byteWidth:4, bits:32, type:I32_TYPE, extension:null }),
  Object.freeze({ suffix:'-wide', descriptor:'J', byteWidth:8, bits:64, type:Object.freeze({ kind:'bitvector', widthBits:64 }), extension:null }),
  Object.freeze({ suffix:'-object', descriptor:'Ljava/lang/Object;', byteWidth:4, bits:32, type:ADDRESS_TYPE, extension:null }),
  Object.freeze({ suffix:'-boolean', descriptor:'Z', byteWidth:1, bits:32, type:I32_TYPE, extension:'zero' }),
  Object.freeze({ suffix:'-byte', descriptor:'B', byteWidth:1, bits:32, type:I32_TYPE, extension:'sign' }),
  Object.freeze({ suffix:'-char', descriptor:'C', byteWidth:2, bits:32, type:I32_TYPE, extension:'zero' }),
  Object.freeze({ suffix:'-short', descriptor:'S', byteWidth:2, bits:32, type:I32_TYPE, extension:'sign' }),
]);
const FILL_ARRAY_WIDTHS = new Set([1, 2, 4, 8]);

function fail(code) { throw new TypeError(code); }
function register(index, bits = 32, type = I32_TYPE) { return { kind:'register', index, bits, type }; }
function referenceRegister(index, type = ADDRESS_TYPE) { return register(index, 32, type); }
function runtimeResult(type) { return { kind:'runtime', name:'result', bits:32, type }; }
function typeAt(image, index) {
  const descriptor = image.types?.[index];
  if (descriptor == null) fail('dex-reference-index-out-of-range');
  return descriptor;
}
function referenceInfo(descriptor, reason) {
  let info;
  try { info = dexTypeInfo(descriptor); } catch { fail(reason); }
  if (info.category !== 'object') fail(reason);
  return info;
}
function arrayInfo(descriptor, reason) {
  const info = referenceInfo(descriptor, reason);
  if (descriptor[0] !== '[') fail(reason);
  return info;
}
function arrayElementInfo(arrayDescriptor) {
  if (typeof arrayDescriptor !== 'string' || arrayDescriptor[0] !== '[') fail('dex-array-type-required');
  const elementDescriptor = arrayDescriptor.slice(1);
  const info = dexTypeInfo(elementDescriptor);
  if (info.category === 'void') fail('dex-array-element-type-invalid');
  return { descriptor:elementDescriptor, ...info };
}
function exceptions(...types) { return types.map((exceptionType) => ({ kind:'managed-runtime-exception', exceptionType })); }
function exact(mnemonic, extra = {}) {
  return { mnemonic, consumedValues:[], producedValues:[], locationReads:[], locationWrites:[], memoryEffects:[], callEffects:[], controlEffects:[], possibleExceptions:[], completeness:'exact', unknownEffects:[], ...extra };
}
function partialAllocation(mnemonic, descriptor, extra = {}) {
  return exact(mnemonic, {
    ...extra,
    completeness:'partial',
    unknownEffects:[{ category:'heap', categories:['heap'], reason:'dex-array-allocation-identity-unrepresented' }],
    metadata:{ ...(extra.metadata ?? {}), allocation:{ kind:'array', descriptor, identityAuthority:'unrepresented' } },
  });
}
function signed32At(view, offset) { return view.getInt32(offset, true); }

function monitorEffects(opcode, formatByte) {
  const enter = opcode === 0x1d;
  return exact(enter ? 'monitor-enter' : 'monitor-exit', {
    locationReads:[referenceRegister(formatByte)],
    controlEffects:[{ kind:enter ? 'monitor-enter' : 'monitor-exit', receiverReadIndex:0 }],
    possibleExceptions:enter
      ? exceptions('java/lang/NullPointerException')
      : exceptions('java/lang/NullPointerException', 'java/lang/IllegalMonitorStateException'),
  });
}

function castEffects({ opcode, formatByte, view, insnsStart, pc, image }) {
  const typeIndex = view.getUint16(insnsStart + (pc + 1) * 2, true);
  const descriptor = typeAt(image, typeIndex);
  const info = referenceInfo(descriptor, opcode === 0x1f ? 'dex-check-cast-reference-required' : 'dex-instance-of-reference-required');
  if (opcode === 0x1f) {
    const read = referenceRegister(formatByte);
    return exact('check-cast', {
      locationReads:[read],
      locationWrites:[referenceRegister(formatByte, info.type)],
      producedValues:[{ bits:32, type:info.type, typeRef:descriptor, relation:'cast' }],
      possibleExceptions:exceptions('java/lang/ClassCastException'),
      metadata:{ typeCast:{ targetType:descriptor, sourceReadIndex:0 } },
    });
  }
  const destination = formatByte & 15, source = formatByte >>> 4;
  return exact('instance-of', {
    locationReads:[referenceRegister(source)],
    locationWrites:[register(destination)],
    producedValues:[{ bits:32, type:I32_TYPE, typeRef:descriptor, relation:'instance-of' }],
    metadata:{ typeTest:{ targetType:descriptor, sourceReadIndex:0 } },
  });
}

function arrayLengthEffects(formatByte) {
  const destination = formatByte & 15, array = formatByte >>> 4;
  return exact('array-length', {
    locationReads:[referenceRegister(array)],
    locationWrites:[register(destination)],
    producedValues:[{ bits:32, type:I32_TYPE, relation:'array-length' }],
    possibleExceptions:exceptions('java/lang/NullPointerException'),
  });
}

function newArrayEffects({ formatByte, view, insnsStart, pc, image }) {
  const typeIndex = view.getUint16(insnsStart + (pc + 1) * 2, true);
  const descriptor = typeAt(image, typeIndex);
  const info = arrayInfo(descriptor, 'dex-new-array-array-type-required');
  const destination = formatByte & 15, size = formatByte >>> 4;
  return partialAllocation('new-array', descriptor, {
    locationReads:[register(size)],
    locationWrites:[referenceRegister(destination, info.type)],
    producedValues:[{ bits:32, type:info.type, arrayType:descriptor }],
    possibleExceptions:exceptions('java/lang/NegativeArraySizeException'),
  });
}

function filledArrayRegisters({ opcode, formatByte, view, insnsStart, pc }) {
  if (opcode === 0x24) {
    const count = formatByte & 15;
    if (count > 5) fail('dex-filled-new-array-register-count-invalid');
    const packed = view.getUint16(insnsStart + (pc + 2) * 2, true);
    return [packed & 15, (packed >>> 4) & 15, (packed >>> 8) & 15, (packed >>> 12) & 15, formatByte >>> 4].slice(0, count);
  }
  const count = formatByte;
  const first = view.getUint16(insnsStart + (pc + 2) * 2, true);
  if (first + count > 0x10000) fail('dex-filled-new-array-range-overflow');
  return Array.from({ length:count }, (_, index) => first + index);
}

function filledNewArrayEffects({ opcode, formatByte, view, insnsStart, pc, image, byteOffset, instructionLength }) {
  const typeIndex = view.getUint16(insnsStart + (pc + 1) * 2, true);
  const descriptor = typeAt(image, typeIndex);
  const info = arrayInfo(descriptor, 'dex-filled-new-array-array-type-required');
  const element = arrayElementInfo(descriptor);
  if (element.category === 'wide') fail('dex-filled-new-array-wide-element-unsupported');
  const registers = filledArrayRegisters({ opcode, formatByte, view, insnsStart, pc });
  const valueType = element.category === 'object' ? element.type : I32_TYPE;
  const locationReads = registers.map((index) => register(index, 32, valueType));
  const effects = partialAllocation(opcode === 0x24 ? 'filled-new-array' : 'filled-new-array/range', descriptor, {
    locationReads,
    locationWrites:[runtimeResult(info.type)],
    producedValues:[{ bits:32, type:info.type, arrayType:descriptor }],
    metadata:{ initializer:{ elementDescriptor:element.descriptor, valueReadIndices:registers.map((_, index) => index) } },
  });
  return {
    effects,
    resultInfo:{ ...info, nextOffset:byteOffset + instructionLength * 2 },
  };
}

function fillArrayDataEffects({ formatByte, view, insnsStart, pc, insnsSize, controlIndex }) {
  const displacement = signed32At(view, insnsStart + (pc + 1) * 2);
  const payloadPc = pc + displacement;
  if (!Number.isSafeInteger(payloadPc) || payloadPc < 0 || payloadPc >= insnsSize) fail('dex-fill-array-data-payload-out-of-range');
  if ((payloadPc & 1) !== 0) fail('dex-fill-array-data-payload-misaligned');
  const payloadOffset = payloadPc * 2;
  const boundary = controlIndex.payloads.get(payloadOffset);
  if (!boundary) fail(controlIndex.scanComplete ? 'dex-fill-array-data-payload-not-data-boundary' : 'dex-control-flow-boundary-authority-incomplete');
  if (boundary.signature !== 0x03) fail('dex-fill-array-data-payload-kind-mismatch');
  const payloadStart = insnsStart + payloadOffset;
  const elementWidth = view.getUint16(payloadStart + 2, true);
  const elementCount = view.getUint32(payloadStart + 4, true);
  if (!FILL_ARRAY_WIDTHS.has(elementWidth)) fail('dex-fill-array-data-element-width-invalid');
  return {
    ...exact('fill-array-data', {
      locationReads:[referenceRegister(formatByte)],
      memoryEffects:[{
        space:'array-element', isWrite:true, byteWidth:elementWidth, elementCount, bulk:true,
        addressReadIndex:0, payloadOffset, payloadByteLength:elementWidth * elementCount,
        bindingVersion:2, addressKind:'array-elements',
      }],
      possibleExceptions:exceptions('java/lang/NullPointerException', 'java/lang/ArrayIndexOutOfBoundsException'),
    }),
    completeness:'partial',
    unknownEffects:[{ category:'types', categories:['types'], reason:'dex-fill-array-data-array-type-unresolved' }],
  };
}

function arrayAccessEffects(opcode, formatByte, view, insnsStart, pc) {
  const relative = opcode - 0x44;
  const isWrite = relative >= 7;
  const variant = ARRAY_VARIANTS[relative % 7];
  if (!variant) fail('dex-array-variant-invalid');
  const destinationOrValue = formatByte;
  const operands = view.getUint16(insnsStart + (pc + 1) * 2, true);
  const array = operands & 0xff, index = operands >>> 8;
  const reads = [referenceRegister(array), register(index)];
  const valueLocation = register(destinationOrValue, variant.bits, variant.type);
  let valueReadIndex = null;
  if (isWrite) { valueReadIndex = reads.length; reads.push(valueLocation); }
  const memory = {
    space:'array-element', isWrite, byteWidth:variant.byteWidth,
    valueBits:variant.bits, valueType:variant.type, extension:variant.extension,
    descriptor:variant.descriptor, variant:variant.suffix || 'normal',
    addressReadIndex:0, indexReadIndex:1, valueReadIndex,
    bindingVersion:2, addressKind:'array-element',
  };
  return exact(`${isWrite ? 'aput' : 'aget'}${variant.suffix}`, {
    locationReads:reads,
    locationWrites:isWrite ? [] : [valueLocation],
    producedValues:isWrite ? [] : [{ bits:variant.bits, type:variant.type }],
    memoryEffects:[memory],
    possibleExceptions:exceptions(
      'java/lang/NullPointerException',
      'java/lang/ArrayIndexOutOfBoundsException',
      ...(opcode === 0x4d ? ['java/lang/ArrayStoreException'] : []),
    ),
  });
}

export function dexArrayTypeEffects(context) {
  const { opcode } = context;
  if (opcode === 0x1d || opcode === 0x1e) return { effects:monitorEffects(opcode, context.formatByte) };
  if (opcode === 0x1f || opcode === 0x20) return { effects:castEffects(context) };
  if (opcode === 0x21) return { effects:arrayLengthEffects(context.formatByte) };
  if (opcode === 0x23) return { effects:newArrayEffects(context) };
  if (opcode === 0x24 || opcode === 0x25) return filledNewArrayEffects(context);
  if (opcode === 0x26) return { effects:fillArrayDataEffects(context) };
  if (opcode >= 0x44 && opcode <= 0x51) return { effects:arrayAccessEffects(opcode, context.formatByte, context.view, context.insnsStart, context.pc) };
  fail('dex-array-type-opcode-unsupported');
}
