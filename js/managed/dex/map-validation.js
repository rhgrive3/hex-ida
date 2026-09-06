function fail(code) { throw new TypeError(code); }

function checkedRange(limit, offset, size, code) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size)
      || offset < 0 || size < 0 || offset > limit || size > limit - offset) fail(code);
}

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

const KNOWN_TYPES = new Set([
  TYPE_HEADER_ITEM, TYPE_STRING_ID_ITEM, TYPE_TYPE_ID_ITEM, TYPE_PROTO_ID_ITEM,
  TYPE_FIELD_ID_ITEM, TYPE_METHOD_ID_ITEM, TYPE_CLASS_DEF_ITEM,
  TYPE_CALL_SITE_ID_ITEM, TYPE_METHOD_HANDLE_ITEM, TYPE_MAP_LIST,
  0x1001, 0x1002, 0x1003,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006,
  0xf000,
]);

const FIXED_WIDTH = new Map([
  [TYPE_HEADER_ITEM, 0x70], [TYPE_STRING_ID_ITEM, 4], [TYPE_TYPE_ID_ITEM, 4],
  [TYPE_PROTO_ID_ITEM, 12], [TYPE_FIELD_ID_ITEM, 8], [TYPE_METHOD_ID_ITEM, 8],
  [TYPE_CLASS_DEF_ITEM, 32], [TYPE_CALL_SITE_ID_ITEM, 4], [TYPE_METHOD_HANDLE_ITEM, 8],
]);

const ALIGN4_TYPES = new Set([
  TYPE_HEADER_ITEM, TYPE_STRING_ID_ITEM, TYPE_TYPE_ID_ITEM, TYPE_PROTO_ID_ITEM,
  TYPE_FIELD_ID_ITEM, TYPE_METHOD_ID_ITEM, TYPE_CLASS_DEF_ITEM,
  TYPE_CALL_SITE_ID_ITEM, TYPE_METHOD_HANDLE_ITEM, TYPE_MAP_LIST,
  0x1001, 0x1002, 0x1003, 0x2001, 0x2006,
]);

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

export function validateDexMap(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.length < 0x70) fail('dex-truncated-header');
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const fileSize = view.getUint32(32, true);
  if (fileSize !== u8.length) fail('dex-file-size-mismatch');

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

  const entries = [];
  const byType = new Map();
  for (let i = 0; i < mapSize; i++) {
    const pos = mapOff + 4 + i * 12;
    const type = view.getUint16(pos, true);
    const unused = view.getUint16(pos + 2, true);
    const size = view.getUint32(pos + 4, true);
    const offset = view.getUint32(pos + 8, true);

    if (!KNOWN_TYPES.has(type)) fail('dex-unsupported-map-item-type');
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
      if (size > Math.floor(fileSize / width)) fail('dex-invalid-map-item-range');
      checkedRange(fileSize, offset, size * width, 'dex-invalid-map-item-range');
      end = offset + size * width;
    } else if (type === TYPE_MAP_LIST) {
      if (size !== 1 || offset !== mapOff) fail('dex-invalid-map-list-entry');
      end = mapOff + 4 + mapSize * 12;
      checkedRange(fileSize, mapOff, end - mapOff, 'dex-truncated-map-list');
    } else {
      checkedRange(fileSize, offset, 1, 'dex-invalid-map-item-range');
    }

    if (previous?.end != null && previous.end > offset) fail('dex-overlapping-map-items');
    if (type >= 0x1000 && (offset < dataOff || offset >= dataEnd)) fail('dex-map-item-outside-data');

    const entry = { type, size, offset, end };
    entries.push(entry);
    byType.set(type, entry);
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