import { createManagedFieldId, createManagedTypeId } from '../shared/identity.js';
import { dexTypeInfo } from './descriptor.js';
import { fail } from './validation-utils.js';

const SUFFIXES = ['', '-wide', '-object', '-boolean', '-byte', '-char', '-short'];
const VARIANT_TYPES = [/^[IF]$/, /^[JD]$/, /^(?:L|\[)/, /^Z$/, /^B$/, /^C$/, /^S$/];

export function dexFieldEffects({ opcode, formatByte, fieldIndex, image }) {
  const isStatic = opcode >= 0x60;
  const relative = opcode - (isStatic ? 0x60 : 0x52);
  const isWrite = relative >= 7, variant = relative % 7;
  const field = image.fields?.[fieldIndex];
  if (!field) fail('dex-reference-index-out-of-range');
  const info = dexTypeInfo(field.type);
  if (!VARIANT_TYPES[variant]?.test(field.type)) fail('dex-field-variant-type-mismatch');
  if (typeof field.name !== 'string' || !field.name || typeof field.classType !== 'string') fail('dex-field-identity-unresolved');
  const valueRegister = isStatic ? formatByte : formatByte & 15;
  const receiverRegister = formatByte >>> 4;
  const valueLocation = { kind:'register', index:valueRegister, bits:info.bits, type:info.type };
  const reads = isStatic ? [] : [{ kind:'register', index:receiverRegister, bits:32,
    type:{kind:'address',widthBits:32,addressSpace:'managed-heap'} }];
  const valueReadIndex = isWrite ? reads.length : null;
  if (isWrite) reads.push(valueLocation);
  const fieldIdentity = createManagedFieldId(createManagedTypeId(image.moduleId,field.classType),fieldIndex);
  return {
    mnemonic:`${isStatic ? 's' : 'i'}${isWrite ? 'put' : 'get'}${SUFFIXES[variant]}`,
    locationReads:reads, locationWrites:isWrite ? [] : [valueLocation],
    producedValues:isWrite ? [] : [{ bits:info.byteWidth*8,
      type:info.extension ? {kind:'bitvector',widthBits:info.byteWidth*8} : info.type }],
    memoryEffects:[{ space:isStatic ? 'static-field' : 'field', field:field.name, classType:field.classType,
      fieldIdentity, fieldIndex, descriptor:field.type, isWrite, byteWidth:info.byteWidth,
      valueBits:info.bits, valueType:info.type, extension:info.extension ?? null,
      bindingVersion:1, addressReadIndex:isStatic ? null : 0, valueReadIndex,
      addressKind:isStatic ? 'static-field' : 'instance-field' }],
  };
}
