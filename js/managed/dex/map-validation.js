import { checkedRange, fail } from './validation-utils.js';

const TYPE_HEADER_ITEM = 0x0000;
const TYPE_STRING_ID_ITEM = 0x0001;
const TYPE_TYPE_ID_ITEM = 0x0002;
const TYPE_PROTO_ID_ITEM = 0x0003;
const TYPE_FIELD_ID_ITEM = 0x0004;
const TYPE_METHOD_ID_ITEM = 0x0005;
const TYPE_CLASS_DEF_ITEM = 0x0006;
const TYPE_CALL_SITE_ID_ITEM = 0x0007;
const TYPE_METHOD_HANDLE_ITEM = 0x0008;
const TYPE_MAP_LIST = 0x1000;
const TYPE_TYPE_LIST = 0x1001;
const TYPE_ANNOTATION_SET_REF_LIST = 0x1002;
const TYPE_ANNOTATION_SET_ITEM = 0x1003;
const TYPE_CLASS_DATA_ITEM = 0x2000;
const TYPE_CODE_ITEM = 0x2001;
const TYPE_STRING_DATA_ITEM = 0x2002;
const TYPE_DEBUG_INFO_ITEM = 0x2003;
const TYPE_ANNOTATION_ITEM = 0x2004;
const TYPE_ENCODED_ARRAY_ITEM = 0x2005;
const TYPE_ANNOTATIONS_DIRECTORY_ITEM = 0x2006;
const TYPE_HIDDENAPI_CLASS_DATA_ITEM = 0xf000;

const FIXED_WIDTH = new Map([
  [TYPE_HEADER_ITEM, 0x70], [TYPE_STRING_ID_ITEM, 4], [TYPE_TYPE_ID_ITEM, 4],
  [TYPE_PROTO_ID_ITEM, 12], [TYPE_FIELD_ID_ITEM, 8], [TYPE_METHOD_ID_ITEM, 8],
  [TYPE_CLASS_DEF_ITEM, 32], [TYPE_CALL_SITE_ID_ITEM, 4], [TYPE_METHOD_HANDLE_ITEM, 8],
]);

const VARIABLE_TYPES = new Set([
  TYPE_TYPE_LIST, TYPE_ANNOTATION_SET_REF_LIST, TYPE_ANNOTATION_SET_ITEM,
  TYPE_CLASS_DATA_ITEM, TYPE_CODE_ITEM, TYPE_STRING_DATA_ITEM, TYPE_DEBUG_INFO_ITEM,
  TYPE_ANNOTATION_ITEM, TYPE_ENCODED_ARRAY_ITEM, TYPE_ANNOTATIONS_DIRECTORY_ITEM,
]);

const KNOWN_TYPES = new Set([
  ...FIXED_WIDTH.keys(), TYPE_MAP_LIST, ...VARIABLE_TYPES, TYPE_HIDDENAPI_CLASS_DATA_ITEM,
]);
const HIDDENAPI_DEX_VERSIONS = new Set(['039', '040']);

const ALIGN4_TYPES = new Set([
  TYPE_HEADER_ITEM, TYPE_STRING_ID_ITEM, TYPE_TYPE_ID_ITEM, TYPE_PROTO_ID_ITEM,
  TYPE_FIELD_ID_ITEM, TYPE_METHOD_ID_ITEM, TYPE_CLASS_DEF_ITEM,
  TYPE_CALL_SITE_ID_ITEM, TYPE_METHOD_HANDLE_ITEM, TYPE_MAP_LIST,
  TYPE_TYPE_LIST, TYPE_ANNOTATION_SET_REF_LIST, TYPE_ANNOTATION_SET_ITEM,
  TYPE_CODE_ITEM, TYPE_ANNOTATIONS_DIRECTORY_ITEM, TYPE_HIDDENAPI_CLASS_DATA_ITEM,
]);

const RANGE_ERROR = 'dex-invalid-map-item-range';

function expectedHeaderSections(view) {
  return [
    [TYPE_HEADER_ITEM, 1, 0],
    [TYPE_STRING_ID_ITEM, view.getUint32(56, true), view.getUint32(60, true)],
    [TYPE_TYPE_ID_ITEM, view.getUint32(64, true), view.getUint32(68, true)],
    [TYPE_PROTO_ID_ITEM, view.getUint32(72, true), view.getUint32(76, true)],
    [TYPE_FIELD_ID_ITEM, view.getUint32(80, true), view.getUint32(84, true)],
    [TYPE_METHOD_ID_ITEM, view.getUint32(88, true), view.getUint32(92, true)],
    [TYPE_CLASS_DEF_ITEM, view.getUint32(96, true), view.getUint32(100, true)],
  ];
}

function align4(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER - 3) fail(RANGE_ERROR);
  return Math.ceil(value / 4) * 4;
}

function readUleb128(bytes, offset, limit, code = RANGE_ERROR) {
  let value = 0;
  let factor = 1;
  let pos = offset;
  for (let count = 0; count < 5; count++) {
    if (pos >= limit) fail(code);
    const byte = bytes[pos++];
    if (count === 4 && (byte & 0xf0) !== 0) fail(code);
    value += (byte & 0x7f) * factor;
    if ((byte & 0x80) === 0) return { value, nextOffset: pos };
    factor *= 0x80;
  }
  fail(code);
}

function readSleb128(bytes, offset, limit, code = RANGE_ERROR) {
  let value = 0n;
  let shift = 0n;
  let pos = offset;
  for (let count = 0; count < 5; count++) {
    if (pos >= limit) fail(code);
    const byte = bytes[pos++];
    value |= BigInt(byte & 0x7f) << shift;
    shift += 7n;
    if ((byte & 0x80) === 0) {
      if (count === 4) {
        const payload = byte & 0x7f;
        if (payload !== 0x00 && payload !== 0x7f && (payload & 0x70) !== 0x00 && (payload & 0x70) !== 0x70) fail(code);
      }
      if ((byte & 0x40) !== 0) value |= -1n << shift;
      return { value: Number(BigInt.asIntN(32, value)), nextOffset: pos };
    }
  }
  fail(code);
}

function requireLoopBudget(count, available, minBytes = 1) {
  if (!Number.isSafeInteger(count) || count < 0 || count > Math.floor(available / minBytes)) fail(RANGE_ERROR);
}

function skipEncodedArray(bytes, offset, limit, depth = 0) {
  if (depth > 64) fail(RANGE_ERROR);
  const countR = readUleb128(bytes, offset, limit);
  let pos = countR.nextOffset;
  requireLoopBudget(countR.value, limit - pos);
  for (let i = 0; i < countR.value; i++) pos = skipEncodedValue(bytes, pos, limit, depth + 1);
  return pos;
}

function skipEncodedAnnotation(bytes, offset, limit, depth = 0) {
  if (depth > 64) fail(RANGE_ERROR);
  let r = readUleb128(bytes, offset, limit);
  r = readUleb128(bytes, r.nextOffset, limit);
  const count = r.value;
  let pos = r.nextOffset;
  requireLoopBudget(count, limit - pos, 2);
  for (let i = 0; i < count; i++) {
    const name = readUleb128(bytes, pos, limit);
    pos = skipEncodedValue(bytes, name.nextOffset, limit, depth + 1);
  }
  return pos;
}

function skipEncodedValue(bytes, offset, limit, depth = 0) {
  checkedRange(limit, offset, 1, RANGE_ERROR);
  const header = bytes[offset];
  const type = header & 0x1f;
  const arg = header >>> 5;
  let pos = offset + 1;

  const sized = (maxArg) => {
    if (arg > maxArg) fail(RANGE_ERROR);
    checkedRange(limit, pos, arg + 1, RANGE_ERROR);
    pos += arg + 1;
    return pos;
  };

  switch (type) {
    case 0x00: return sized(0);
    case 0x02: case 0x03: return sized(1);
    case 0x04: case 0x10: case 0x15: case 0x16:
    case 0x17: case 0x18: case 0x19: case 0x1a: case 0x1b:
      return sized(3);
    case 0x06: case 0x11: return sized(7);
    case 0x1c:
      if (arg !== 0) fail(RANGE_ERROR);
      return skipEncodedArray(bytes, pos, limit, depth + 1);
    case 0x1d:
      if (arg !== 0) fail(RANGE_ERROR);
      return skipEncodedAnnotation(bytes, pos, limit, depth + 1);
    case 0x1e:
      if (arg !== 0) fail(RANGE_ERROR);
      return pos;
    case 0x1f:
      if (arg > 1) fail(RANGE_ERROR);
      return pos;
    default:
      fail(RANGE_ERROR);
  }
}

function skipTypeList(view, offset, limit) {
  checkedRange(limit, offset, 4, RANGE_ERROR);
  const count = view.getUint32(offset, true);
  if (count > Math.floor((limit - offset - 4) / 2)) fail(RANGE_ERROR);
  const rawEnd = offset + 4 + count * 2;
  const end = align4(rawEnd);
  checkedRange(limit, rawEnd, end - rawEnd, RANGE_ERROR);
  return end;
}

function skipUint32List(view, offset, limit) {
  checkedRange(limit, offset, 4, RANGE_ERROR);
  const count = view.getUint32(offset, true);
  if (count > Math.floor((limit - offset - 4) / 4)) fail(RANGE_ERROR);
  return offset + 4 + count * 4;
}

function skipClassData(bytes, offset, limit) {
  let r = readUleb128(bytes, offset, limit); const staticFields = r.value;
  r = readUleb128(bytes, r.nextOffset, limit); const instanceFields = r.value;
  r = readUleb128(bytes, r.nextOffset, limit); const directMethods = r.value;
  r = readUleb128(bytes, r.nextOffset, limit); const virtualMethods = r.value;
  let pos = r.nextOffset;
  const fieldCount = staticFields + instanceFields;
  const methodCount = directMethods + virtualMethods;
  if (!Number.isSafeInteger(fieldCount) || !Number.isSafeInteger(methodCount)) fail(RANGE_ERROR);
  requireLoopBudget(fieldCount, limit - pos, 2);
  for (let i = 0; i < fieldCount; i++) {
    r = readUleb128(bytes, pos, limit);
    r = readUleb128(bytes, r.nextOffset, limit);
    pos = r.nextOffset;
  }
  requireLoopBudget(methodCount, limit - pos, 3);
  for (let i = 0; i < methodCount; i++) {
    r = readUleb128(bytes, pos, limit);
    r = readUleb128(bytes, r.nextOffset, limit);
    r = readUleb128(bytes, r.nextOffset, limit);
    pos = r.nextOffset;
  }
  return pos;
}

function skipCatchHandlerList(bytes, offset, limit) {
  let r = readUleb128(bytes, offset, limit);
  const count = r.value;
  let pos = r.nextOffset;
  requireLoopBudget(count, limit - pos, 2);
  for (let i = 0; i < count; i++) {
    const sizeR = readSleb128(bytes, pos, limit);
    const typedCount = Math.abs(sizeR.value);
    pos = sizeR.nextOffset;
    requireLoopBudget(typedCount, limit - pos, 2);
    for (let j = 0; j < typedCount; j++) {
      r = readUleb128(bytes, pos, limit);
      r = readUleb128(bytes, r.nextOffset, limit);
      pos = r.nextOffset;
    }
    if (sizeR.value <= 0) pos = readUleb128(bytes, pos, limit).nextOffset;
  }
  return pos;
}

function skipCodeItem(bytes, view, offset, limit) {
  checkedRange(limit, offset, 16, RANGE_ERROR);
  const triesSize = view.getUint16(offset + 6, true);
  const insnsSize = view.getUint32(offset + 12, true);
  const insnBytes = insnsSize * 2;
  if (!Number.isSafeInteger(insnBytes)) fail(RANGE_ERROR);
  let pos = offset + 16;
  checkedRange(limit, pos, insnBytes, RANGE_ERROR);
  pos += insnBytes;
  if (triesSize === 0) return pos;
  if ((insnsSize & 1) !== 0) {
    checkedRange(limit, pos, 2, RANGE_ERROR);
    pos += 2;
  }
  checkedRange(limit, pos, triesSize * 8, RANGE_ERROR);
  pos += triesSize * 8;
  return skipCatchHandlerList(bytes, pos, limit);
}

function skipStringData(bytes, offset, limit) {
  const length = readUleb128(bytes, offset, limit);
  let pos = length.nextOffset;
  while (pos < limit && bytes[pos] !== 0) pos++;
  if (pos >= limit) fail(RANGE_ERROR);
  return pos + 1;
}

function skipDebugInfo(bytes, offset, limit) {
  let r = readUleb128(bytes, offset, limit);
  r = readUleb128(bytes, r.nextOffset, limit);
  let pos = r.nextOffset;
  requireLoopBudget(r.value, limit - pos);
  for (let i = 0; i < r.value; i++) pos = readUleb128(bytes, pos, limit).nextOffset;

  while (pos < limit) {
    const op = bytes[pos++];
    if (op === 0x00) return pos;
    if (op === 0x01 || op === 0x05 || op === 0x06 || op === 0x09) {
      pos = readUleb128(bytes, pos, limit).nextOffset;
    } else if (op === 0x02) {
      pos = readSleb128(bytes, pos, limit).nextOffset;
    } else if (op === 0x03 || op === 0x04) {
      const operands = op === 0x03 ? 3 : 4;
      for (let i = 0; i < operands; i++) pos = readUleb128(bytes, pos, limit).nextOffset;
    } else if (op === 0x07 || op === 0x08 || op >= 0x0a) {
      // no operands
    } else {
      fail(RANGE_ERROR);
    }
  }
  fail(RANGE_ERROR);
}

function skipAnnotationItem(bytes, offset, limit) {
  checkedRange(limit, offset, 1, RANGE_ERROR);
  if (bytes[offset] > 2) fail(RANGE_ERROR);
  return skipEncodedAnnotation(bytes, offset + 1, limit);
}

function skipAnnotationsDirectory(view, offset, limit) {
  checkedRange(limit, offset, 16, RANGE_ERROR);
  const fields = view.getUint32(offset + 4, true);
  const methods = view.getUint32(offset + 8, true);
  const parameters = view.getUint32(offset + 12, true);
  const count = fields + methods + parameters;
  if (!Number.isSafeInteger(count) || count > Math.floor((limit - offset - 16) / 8)) fail(RANGE_ERROR);
  return offset + 16 + count * 8;
}

function variableSectionEnd(bytes, view, type, size, offset, limit) {
  const minBytes = (type === TYPE_TYPE_LIST || type === TYPE_ANNOTATION_SET_REF_LIST
    || type === TYPE_ANNOTATION_SET_ITEM) ? 4
    : type === TYPE_CODE_ITEM || type === TYPE_ANNOTATIONS_DIRECTORY_ITEM ? 16 : 1;
  requireLoopBudget(size, limit - offset, minBytes);
  let pos = offset;
  for (let i = 0; i < size; i++) {
    if (type === TYPE_TYPE_LIST) pos = skipTypeList(view, pos, limit);
    else if (type === TYPE_ANNOTATION_SET_REF_LIST || type === TYPE_ANNOTATION_SET_ITEM) pos = skipUint32List(view, pos, limit);
    else if (type === TYPE_CLASS_DATA_ITEM) pos = skipClassData(bytes, pos, limit);
    else if (type === TYPE_CODE_ITEM) {
      if (pos % 4 !== 0) fail('dex-invalid-map-item-alignment');
      pos = skipCodeItem(bytes, view, pos, limit);
      if (i + 1 < size) pos = align4(pos);
    } else if (type === TYPE_STRING_DATA_ITEM) pos = skipStringData(bytes, pos, limit);
    else if (type === TYPE_DEBUG_INFO_ITEM) pos = skipDebugInfo(bytes, pos, limit);
    else if (type === TYPE_ANNOTATION_ITEM) pos = skipAnnotationItem(bytes, pos, limit);
    else if (type === TYPE_ENCODED_ARRAY_ITEM) pos = skipEncodedArray(bytes, pos, limit);
    else if (type === TYPE_ANNOTATIONS_DIRECTORY_ITEM) pos = skipAnnotationsDirectory(view, pos, limit);
    else fail('dex-unsupported-map-item-type');
  }
  if (pos > limit) fail(RANGE_ERROR);
  return pos;
}

function hiddenapiSectionEnd(view, offset, limit) {
  checkedRange(limit, offset, 4, RANGE_ERROR);
  const sectionSize = view.getUint32(offset, true);
  if (sectionSize < 4) fail(RANGE_ERROR);
  checkedRange(limit, offset, sectionSize, RANGE_ERROR);
  return offset + sectionSize;
}

export function validateDexMap(bytes, { validateVariableItems = true } = {}) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.length < 0x70) fail('dex-truncated-header');
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const fileSize = view.getUint32(32, true);
  if (fileSize !== u8.length) fail('dex-file-size-mismatch');
  const dexVersion = String.fromCharCode(u8[4], u8[5], u8[6]);

  const mapOff = view.getUint32(52, true);
  const dataSize = view.getUint32(104, true);
  const dataOff = view.getUint32(108, true);
  if (mapOff === 0 || mapOff % 4 !== 0) fail('dex-invalid-map-offset');
  if (dataSize === 0 || dataOff === 0 || dataOff % 4 !== 0) fail('dex-invalid-data-section');
  checkedRange(fileSize, dataOff, dataSize, 'dex-invalid-data-section');
  const dataEnd = dataOff + dataSize;
  if (mapOff < dataOff || mapOff >= dataEnd) fail('dex-invalid-map-offset');

  checkedRange(fileSize, mapOff, 4, 'dex-truncated-map-list');
  const mapSize = view.getUint32(mapOff, true);
  const maxMapItems = Math.floor((fileSize - mapOff - 4) / 12);
  if (mapSize === 0 || mapSize > maxMapItems) fail('dex-truncated-map-list');
  checkedRange(fileSize, mapOff + 4, mapSize * 12, 'dex-truncated-map-list');
  const mapEnd = mapOff + 4 + mapSize * 12;
  if (mapEnd > dataEnd) fail('dex-map-item-outside-data');

  const entries = [];
  const byType = new Map();
  for (let i = 0; i < mapSize; i++) {
    const pos = mapOff + 4 + i * 12;
    const type = view.getUint16(pos, true);
    const unused = view.getUint16(pos + 2, true);
    const size = view.getUint32(pos + 4, true);
    const offset = view.getUint32(pos + 8, true);

    if (!KNOWN_TYPES.has(type)) fail('dex-unsupported-map-item-type');
    if (type === TYPE_HIDDENAPI_CLASS_DATA_ITEM && !HIDDENAPI_DEX_VERSIONS.has(dexVersion)) {
      fail('dex-unsupported-map-item-type');
    }
    if (unused !== 0) fail('dex-invalid-map-item-unused');
    if (byType.has(type)) fail('dex-duplicate-map-item-type');
    if (size === 0) fail('dex-invalid-map-item-size');
    if (type === TYPE_HEADER_ITEM) {
      if (offset !== 0) fail('dex-invalid-header-map-item');
    } else if (offset === 0 || offset >= fileSize) fail('dex-invalid-map-item-offset');
    if (ALIGN4_TYPES.has(type) && offset % 4 !== 0) fail('dex-invalid-map-item-alignment');

    const previous = entries[entries.length - 1];
    if (previous && offset <= previous.offset) fail('dex-map-items-out-of-order');

    let end = null;
    const width = FIXED_WIDTH.get(type);
    if (width != null) {
      if (size > Math.floor(fileSize / width)) fail(RANGE_ERROR);
      checkedRange(fileSize, offset, size * width, RANGE_ERROR);
      end = offset + size * width;
    } else if (type === TYPE_MAP_LIST) {
      if (size !== 1 || offset !== mapOff) fail('dex-invalid-map-list-entry');
      end = mapEnd;
    } else if (type === TYPE_HIDDENAPI_CLASS_DATA_ITEM) {
      if (size !== 1) fail('dex-invalid-map-item-size');
      end = hiddenapiSectionEnd(view, offset, fileSize);
    }

    if (type >= 0x1000 && (offset < dataOff || offset >= dataEnd || (end != null && end > dataEnd))) {
      fail('dex-map-item-outside-data');
    }

    const entry = { type, size, offset, end };
    entries.push(entry);
    byType.set(type, entry);
  }

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const nextOffset = i + 1 < entries.length ? entries[i + 1].offset : (entry.type >= 0x1000 ? dataEnd : fileSize);
    if (entry.end == null) {
      if (!validateVariableItems) continue;
      entry.end = variableSectionEnd(u8, view, entry.type, entry.size, entry.offset, nextOffset);
    }
    if (entry.end > nextOffset) fail('dex-overlapping-map-items');
    if (entry.type >= 0x1000 && entry.end > dataEnd) fail('dex-map-item-outside-data');
  }

  const mapEntry = byType.get(TYPE_MAP_LIST);
  if (!mapEntry || mapEntry.size !== 1 || mapEntry.offset !== mapOff) fail('dex-map-header-mismatch');

  for (const [type, size, offset] of expectedHeaderSections(view)) {
    const entry = byType.get(type);
    if (size === 0) {
      if (entry) fail('dex-map-header-mismatch');
    } else if (!entry || entry.size !== size || entry.offset !== offset) {
      fail('dex-map-header-mismatch');
    }
  }

  return true;
}
