import { parseCilMethodSignature } from './call-signature-types.js';
import { readCilMetadataBlob } from './call-signature-metadata.js';

function fail(code) { throw new TypeError(code); }

const ATTRIBUTE_SCALAR_WIDTHS = new Map([
  [0x02, 1], [0x03, 2], [0x04, 1], [0x05, 1], [0x06, 2], [0x07, 2],
  [0x08, 4], [0x09, 4], [0x0a, 8], [0x0b, 8], [0x0c, 4], [0x0d, 8],
]);
const ENUM_SCALAR_WIDTHS = new Map([
  [0x04, 1], [0x05, 1], [0x06, 2], [0x07, 2], [0x08, 4], [0x09, 4],
  [0x0a, 8], [0x0b, 8],
]);
const CORE_LIBRARY_NAMES = new Set(['mscorlib', 'System.Runtime', 'System.Private.CoreLib', 'netstandard']);
const CORE_LIBRARY_ENUMS = new Map([
  // The type is nested in the framework attribute and its signature is used
  // by real compiler-produced assemblies. Its enum backing type is Int32.
  ['System.Diagnostics.DebuggableAttribute+DebuggingModes', { kind:'enum', elementType:0x08, width:4 }],
]);

function readCompressed(bytes, offset, code) {
  if (!(bytes instanceof Uint8Array) || !Number.isSafeInteger(offset) || offset < 0 || offset >= bytes.length) fail(code);
  const first = bytes[offset];
  if ((first & 0x80) === 0) return { value:first, next:offset + 1 };
  if ((first & 0xc0) === 0x80) {
    if (offset + 1 >= bytes.length) fail(code);
    const value = ((first & 0x3f) << 8) | bytes[offset + 1];
    if (value < 0x80) fail(code);
    return { value, next:offset + 2 };
  }
  if ((first & 0xe0) === 0xc0) {
    if (offset + 3 >= bytes.length) fail(code);
    const value = ((first & 0x1f) * 0x1000000) + (bytes[offset + 1] << 16)
      + (bytes[offset + 2] << 8) + bytes[offset + 3];
    if (value < 0x4000) fail(code);
    return { value, next:offset + 4 };
  }
  fail(code);
}

function readSerString(bytes, offset) {
  if (offset >= bytes.length) fail('cil-customattribute-value-invalid');
  if (bytes[offset] === 0xff) return { value:null, next:offset + 1 };
  const length = readCompressed(bytes, offset, 'cil-customattribute-value-invalid');
  if (length.value > bytes.length - length.next) fail('cil-customattribute-value-invalid');
  let value;
  try { value = new TextDecoder('utf-8', { fatal:true }).decode(bytes.subarray(length.next, length.next + length.value)); }
  catch { fail('cil-customattribute-value-invalid'); }
  return { value, next:length.next + length.value };
}

function typeDefOrRef(encoded, context, code) {
  const tables = [0x02, 0x01, 0x1b];
  const table = tables[encoded & 0x03], rid = encoded >>> 2;
  const rowCounts = context.typeDefOrRefRowCounts;
  if (table == null || rid < 1 || !Array.isArray(rowCounts) || rid > rowCounts[[0x02, 0x01, 0x1b].indexOf(table)]) fail(code);
  const rows = table === 0x02 ? context.types : table === 0x01 ? context.typeRefs : null;
  const row = rows?.[rid - 1] ?? null;
  if (row == null) fail(code);
  return { table, rid, row };
}

function fullTypeName(row) {
  return [row?.namespace, row?.name].filter(part => part != null && part !== '').join('.') || null;
}

function typeRefFullName(type, context, seen = new Set()) {
  if (type.table !== 0x01 || seen.has(type.rid)) return null;
  seen.add(type.rid);
  const row = type.row;
  const scope = row.resolutionScope;
  if (scope?.table === 0x01) {
    const parent = context.typeRefs[scope.rid - 1];
    const parentName = parent ? typeRefFullName({ table:0x01, rid:parent.rid, row:parent }, context, seen) : null;
    return parentName == null ? null : `${parentName}+${row.name}`;
  }
  return fullTypeName(row);
}

function isCoreLibraryTypeRef(type, context) {
  if (type.table !== 0x01) return false;
  let row = type.row, depth = 0;
  while (depth++ < 32) {
    const scope = row.resolutionScope;
    if (scope?.table === 0x23) return CORE_LIBRARY_NAMES.has(context.assemblyRefs?.[scope.rid - 1]?.name);
    if (scope?.table !== 0x01) return false;
    row = context.typeRefs[scope.rid - 1];
    if (!row) return false;
  }
  return false;
}

function isCoreLibraryType(type, name, context) {
  if (fullTypeName(type.row) !== `System.${name}`) return false;
  if (type.table === 0x02) return CORE_LIBRARY_NAMES.has(context.assembly?.name);
  return type.table === 0x01 && isCoreLibraryTypeRef(type, context);
}

function enumUnderlyingForTypeRef(type, context) {
  const name = typeRefFullName(type, context);
  const result = CORE_LIBRARY_ENUMS.get(name);
  if (result && isCoreLibraryTypeRef(type, context)) return result;
  fail('cil-customattribute-constructor-signature-invalid');
}

function enumUnderlyingForTypeDef(type, context, cache) {
  if (cache.has(type.rid)) return cache.get(type.rid);
  const definition = context.types[type.rid - 1];
  const base = definition?.extendsTypeRef;
  let isEnum = false;
  if (base) isEnum = isCoreLibraryType({ table:0x01, row:base }, 'Enum', context);
  else if (definition?.extendsToken?.startsWith('0x0200')) {
    const baseRid = Number.parseInt(definition.extendsToken.slice(6), 16);
    isEnum = isCoreLibraryType({ table:0x02, rid:baseRid, row:context.types[baseRid - 1] }, 'Enum', context);
  }
  if (!isEnum || !Array.isArray(definition.fieldTokens)) fail('cil-customattribute-constructor-signature-invalid');
  const fields = definition.fieldTokens.map(token => context.fields[Number.parseInt(token.slice(6), 16) - 1]);
  const valueFields = fields.filter(field => field?.name === 'value__');
  if (valueFields.length !== 1 || (valueFields[0].accessFlags & 0x10) !== 0) {
    fail('cil-customattribute-constructor-signature-invalid');
  }
  const field = valueFields[0];
  const raw = readCilMetadataBlob(context.blobHeap, field.signatureBlobIndex, 'cil-customattribute-constructor-signature-invalid');
  if (raw[0] !== 0x06) fail('cil-customattribute-constructor-signature-invalid');
  let position = 1;
  if (raw[position] === 0x1f || raw[position] === 0x20) fail('cil-customattribute-constructor-signature-invalid');
  const elementType = raw[position++];
  if (!ENUM_SCALAR_WIDTHS.has(elementType) || position !== raw.length) fail('cil-customattribute-constructor-signature-invalid');
  const result = { kind:'enum', elementType, width:ENUM_SCALAR_WIDTHS.get(elementType) };
  cache.set(type.rid, result);
  return result;
}

function enumBySerializedName(serializedName, context, cache) {
  if (serializedName == null || serializedName.length === 0) fail('cil-customattribute-value-invalid');
  const comma = serializedName.indexOf(',');
  const name = (comma < 0 ? serializedName : serializedName.slice(0, comma)).trim();
  let assemblyName = null;
  if (comma >= 0) {
    assemblyName = serializedName.slice(comma + 1).split(',')[0].trim();
  }
  const coreEnum = CORE_LIBRARY_ENUMS.get(name);
  if (coreEnum) {
    if (assemblyName != null && !CORE_LIBRARY_NAMES.has(assemblyName)) fail('cil-customattribute-value-invalid');
    return coreEnum;
  }
  if (assemblyName != null && assemblyName !== context.assembly?.name) fail('cil-customattribute-value-invalid');
  const matches = context.types.filter(type => fullTypeName(type) === name);
  if (matches.length !== 1) fail('cil-customattribute-value-invalid');
  try { return enumUnderlyingForTypeDef({ table:0x02, rid:matches[0].rid, row:matches[0] }, context, cache); }
  catch { fail('cil-customattribute-value-invalid'); }
}

function skipSignatureModifiers(signature, position) {
  while (signature[position] === 0x1f || signature[position] === 0x20) {
    const modifier = readCompressed(signature, position + 1, 'cil-customattribute-constructor-signature-invalid');
    position = modifier.next;
  }
  return position;
}

function parseSignatureArgumentType(signature, position, context, enumCache, allowArray = true) {
  position = skipSignatureModifiers(signature, position);
  const elementType = signature[position++];
  if (ATTRIBUTE_SCALAR_WIDTHS.has(elementType)) {
    return { type:{ kind:'scalar', elementType, width:ATTRIBUTE_SCALAR_WIDTHS.get(elementType) }, next:position };
  }
  if (elementType === 0x0e) return { type:{ kind:'string' }, next:position };
  if (elementType === 0x1c) return { type:{ kind:'object' }, next:position };
  if (elementType === 0x12 || elementType === 0x11) {
    const encoded = readCompressed(signature, position, 'cil-customattribute-constructor-signature-invalid');
    const type = typeDefOrRef(encoded.value, context, 'cil-customattribute-constructor-signature-invalid');
    if (elementType === 0x12) {
      if (!isCoreLibraryType(type, 'Type', context)) fail('cil-customattribute-constructor-signature-invalid');
      return { type:{ kind:'type' }, next:encoded.next };
    }
    const underlying = type.table === 0x02
      ? enumUnderlyingForTypeDef(type, context, enumCache)
      : type.table === 0x01 ? enumUnderlyingForTypeRef(type, context) : null;
    if (underlying == null) fail('cil-customattribute-constructor-signature-invalid');
    return { type:underlying, next:encoded.next };
  }
  if (elementType === 0x1d && allowArray) {
    const element = parseSignatureArgumentType(signature, position, context, enumCache, false);
    return { type:{ kind:'array', elementType:element.type }, next:element.next };
  }
  fail('cil-customattribute-constructor-signature-invalid');
}

function constructorArgumentTypes(signatureBytes, context, enumCache) {
  let signature;
  try { signature = parseCilMethodSignature(signatureBytes, context.typeDefOrRefRowCounts); }
  catch { fail('cil-customattribute-constructor-signature-invalid'); }
  if ((signatureBytes[0] & 0x10) !== 0 || signature.kind !== 0 || !signature.hasThis || signature.explicitThis
    || signature.genericParameterCount !== 0 || signature.returnValue !== null) {
    fail('cil-customattribute-constructor-signature-invalid');
  }
  let position = 1;
  const count = readCompressed(signatureBytes, position, 'cil-customattribute-constructor-signature-invalid');
  position = skipSignatureModifiers(signatureBytes, count.next);
  if (signatureBytes[position++] !== 0x01 || count.value !== signature.parameters.length) {
    fail('cil-customattribute-constructor-signature-invalid');
  }
  const types = [];
  for (let i = 0; i < count.value; i++) {
    if (signatureBytes[position] === 0x41) fail('cil-customattribute-constructor-signature-invalid');
    const parameter = parseSignatureArgumentType(signatureBytes, position, context, enumCache);
    types.push(parameter.type);
    position = parameter.next;
  }
  if (position !== signatureBytes.length) fail('cil-customattribute-constructor-signature-invalid');
  return types;
}

function parseFieldOrPropType(bytes, position, context, enumCache, allowArray = true) {
  const elementType = bytes[position++];
  if (ATTRIBUTE_SCALAR_WIDTHS.has(elementType)) {
    return { type:{ kind:'scalar', elementType, width:ATTRIBUTE_SCALAR_WIDTHS.get(elementType) }, next:position };
  }
  if (elementType === 0x0e) return { type:{ kind:'string' }, next:position };
  if (elementType === 0x50) return { type:{ kind:'type' }, next:position };
  if (elementType === 0x51) return { type:{ kind:'object' }, next:position };
  if (elementType === 0x1d && allowArray) {
    const element = parseFieldOrPropType(bytes, position, context, enumCache, false);
    return { type:{ kind:'array', elementType:element.type }, next:element.next };
  }
  if (elementType === 0x55) {
    const enumName = readSerString(bytes, position);
    const type = enumBySerializedName(enumName.value, context, enumCache);
    return { type, next:enumName.next };
  }
  fail('cil-customattribute-value-invalid');
}

function consumeValue(bytes, position, type, context, enumCache, depth = 0) {
  if (depth > 32) fail('cil-customattribute-value-invalid');
  if (type.kind === 'scalar' || type.kind === 'enum') {
    if (type.width > bytes.length - position) fail('cil-customattribute-value-invalid');
    if (type.elementType === 0x02 && bytes[position] > 1) fail('cil-customattribute-value-invalid');
    return position + type.width;
  }
  if (type.kind === 'string' || type.kind === 'type') return readSerString(bytes, position).next;
  if (type.kind === 'object') {
    const boxed = parseFieldOrPropType(bytes, position, context, enumCache);
    if (boxed.type.kind === 'object') fail('cil-customattribute-value-invalid');
    return consumeValue(bytes, boxed.next, boxed.type, context, enumCache, depth + 1);
  }
  if (type.kind === 'array') {
    if (position > bytes.length - 4) fail('cil-customattribute-value-invalid');
    const count = new DataView(bytes.buffer, bytes.byteOffset + position, 4).getUint32(0, true);
    position += 4;
    if (count === 0xffffffff) return position;
    if (count > bytes.length - position) fail('cil-customattribute-value-invalid');
    for (let i = 0; i < count; i++) position = consumeValue(bytes, position, type.elementType, context, enumCache, depth + 1);
    return position;
  }
  fail('cil-customattribute-value-invalid');
}

export function decodeCilCustomAttributeValue(rawValue, constructorSignatureBytes, context) {
  const enumCache = new Map();
  const fixedTypes = constructorArgumentTypes(constructorSignatureBytes, context, enumCache);
  if (!(rawValue instanceof Uint8Array)) fail('cil-customattribute-value-invalid');
  // ECMA-335 II.23.3 permits the empty blob only when the attribute has no
  // fixed arguments or named fields/properties at all.
  if (rawValue.length === 0) {
    if (fixedTypes.length !== 0) fail('cil-customattribute-value-invalid');
    return { prolog:null, numNamed:0 };
  }
  if (rawValue.length < 4 || rawValue[0] !== 0x01 || rawValue[1] !== 0x00) fail('cil-customattribute-value-invalid');
  let position = 2;
  for (const type of fixedTypes) position = consumeValue(rawValue, position, type, context, enumCache);
  if (position > rawValue.length - 2) fail('cil-customattribute-value-invalid');
  const numNamed = rawValue[position] | (rawValue[position + 1] << 8);
  position += 2;
  if (numNamed > rawValue.length - position) fail('cil-customattribute-value-invalid');
  for (let i = 0; i < numNamed; i++) {
    if (rawValue[position] !== 0x53 && rawValue[position] !== 0x54) fail('cil-customattribute-value-invalid');
    position++;
    const namedType = parseFieldOrPropType(rawValue, position, context, enumCache);
    position = namedType.next;
    const name = readSerString(rawValue, position);
    if (name.value == null || name.value.length === 0) fail('cil-customattribute-value-invalid');
    position = consumeValue(rawValue, name.next, namedType.type, context, enumCache);
  }
  if (position !== rawValue.length) fail('cil-customattribute-value-invalid');
  return { prolog:0x0001, numNamed };
}
