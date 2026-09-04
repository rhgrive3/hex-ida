export const METHOD_DEF_TABLE = 0x06;
export const MEMBER_REF_TABLE = 0x0a;
export const METHOD_SPEC_TABLE = 0x2b;

const CLI_DIRECTORY_INDEX = 14;
const CLI_HEADER_SIZE = 72;

function fail(code) { throw new TypeError(code); }

function checkedRange(bytes, offset, size, code) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size)
    || offset < 0 || size < 0 || offset > bytes.length - size) fail(code);
}

function readU16(view, offset, code) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + 2 > view.byteLength) fail(code);
  return view.getUint16(offset, true);
}

function readU32(view, offset, code) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + 4 > view.byteLength) fail(code);
  return view.getUint32(offset, true);
}

function align4(value) { return (value + 3) & ~3; }

function codedIndexSize(rowCounts, tables, tagBits) {
  const maxRows = Math.max(...tables.map((table) => rowCounts[table] || 0));
  return maxRows < (1 << (16 - tagBits)) ? 2 : 4;
}

function tableIndexSize(rowCounts, table) {
  return (rowCounts[table] || 0) < 0x10000 ? 2 : 4;
}

function readIndex(view, offset, size, code) {
  return size === 2 ? readU16(view, offset, code) : readU32(view, offset, code);
}

function metadataRowSize(table, rowCounts, heapSizes) {
  const s = (heapSizes & 0x01) !== 0 ? 4 : 2;
  const g = (heapSizes & 0x02) !== 0 ? 4 : 2;
  const b = (heapSizes & 0x04) !== 0 ? 4 : 2;
  const t = (id) => tableIndexSize(rowCounts, id);
  const c = (tables, bits) => codedIndexSize(rowCounts, tables, bits);
  switch (table) {
    case 0x00: return 2 + s + g * 3;
    case 0x01: return c([0x00, 0x1a, 0x23, 0x01], 2) + s * 2;
    case 0x02: return 4 + s * 2 + c([0x02, 0x01, 0x1b], 2) + t(0x04) + t(0x06);
    case 0x03: return t(0x04);
    case 0x04: return 2 + s + b;
    case 0x05: return t(0x06);
    case 0x06: return 8 + s + b + t(0x08);
    case 0x07: return t(0x08);
    case 0x08: return 4 + s;
    case 0x09: return t(0x02) + c([0x02, 0x01, 0x1b], 2);
    case 0x0a: return c([0x02, 0x01, 0x1a, 0x06, 0x1b], 3) + s + b;
    case 0x0b: return 2 + c([0x04, 0x08, 0x17], 2) + b;
    case 0x0c: return c([0x06, 0x04, 0x01, 0x02, 0x08, 0x09, 0x0a, 0x00, 0x0e, 0x17, 0x14,
      0x11, 0x1a, 0x1b, 0x20, 0x23, 0x26, 0x27, 0x28, 0x2a, 0x2c, 0x2b], 5)
      + c([0x06, 0x0a], 3) + b;
    case 0x0d: return c([0x04, 0x08], 1) + b;
    case 0x0e: return 2 + c([0x02, 0x06, 0x20], 2) + b;
    case 0x0f: return 6 + t(0x02);
    case 0x10: return 4 + t(0x04);
    case 0x11: return b;
    case 0x12: return t(0x02) + t(0x14);
    case 0x13: return t(0x14);
    case 0x14: return 2 + s + c([0x02, 0x01, 0x1b], 2);
    case 0x15: return t(0x02) + t(0x17);
    case 0x16: return t(0x17);
    case 0x17: return 2 + s + b;
    case 0x18: return 2 + t(0x06) + c([0x14, 0x17], 1);
    case 0x19: return t(0x02) + c([0x06, 0x0a], 1) * 2;
    case 0x1a: return s;
    case 0x1b: return b;
    case 0x1c: return 2 + c([0x04, 0x06], 1) + s + t(0x1a);
    case 0x1d: return 4 + t(0x04);
    case 0x1e: return 8;
    case 0x1f: return 4;
    case 0x20: return 16 + b + s * 2;
    case 0x21: return 4;
    case 0x22: return 12;
    case 0x23: return 12 + b * 2 + s * 2;
    case 0x24: return 4 + t(0x23);
    case 0x25: return 12 + t(0x23);
    case 0x26: return 4 + s + b;
    case 0x27: return 8 + s * 2 + c([0x26, 0x23, 0x27], 2);
    case 0x28: return 8 + s + c([0x26, 0x23, 0x27], 2);
    case 0x29: return t(0x02) * 2;
    case 0x2a: return 4 + c([0x02, 0x06], 1) + s;
    case 0x2b: return c([0x06, 0x0a], 1) + b;
    case 0x2c: return t(0x2a) + c([0x02, 0x01, 0x1b], 2);
    default: fail(`cil-call-signature-unsupported-metadata-table:${table}`);
  }
}

function readPeMetadataDirectory(bytes, view) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 64 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) {
    fail('cil-call-signature-pe-required');
  }
  const pe = readU32(view, 0x3c, 'cil-call-signature-pe-truncated');
  checkedRange(bytes, pe, 24, 'cil-call-signature-pe-truncated');
  if (bytes[pe] !== 0x50 || bytes[pe + 1] !== 0x45 || bytes[pe + 2] !== 0 || bytes[pe + 3] !== 0) {
    fail('cil-call-signature-pe-invalid');
  }
  const sectionCount = readU16(view, pe + 6, 'cil-call-signature-pe-truncated');
  const optionalSize = readU16(view, pe + 20, 'cil-call-signature-pe-truncated');
  const optional = pe + 24;
  checkedRange(bytes, optional, optionalSize, 'cil-call-signature-pe-truncated');
  const optionalEnd = optional + optionalSize;
  const magic = readU16(view, optional, 'cil-call-signature-pe-truncated');
  const countOffset = magic === 0x10b ? optional + 92 : magic === 0x20b ? optional + 108 : -1;
  const directories = magic === 0x10b ? optional + 96 : magic === 0x20b ? optional + 112 : -1;
  if (countOffset < 0 || countOffset + 4 > optionalEnd) fail('cil-call-signature-pe-invalid');
  if (readU32(view, countOffset, 'cil-call-signature-pe-truncated') <= CLI_DIRECTORY_INDEX
    || directories + (CLI_DIRECTORY_INDEX + 1) * 8 > optionalEnd) fail('cil-call-signature-cli-directory-missing');

  const sections = [];
  for (let i = 0; i < sectionCount; i++) {
    const pos = optionalEnd + i * 40;
    checkedRange(bytes, pos, 40, 'cil-call-signature-section-table-truncated');
    const section = {
      virtualSize:readU32(view, pos + 8, 'cil-call-signature-section-table-truncated'),
      virtualAddress:readU32(view, pos + 12, 'cil-call-signature-section-table-truncated'),
      rawSize:readU32(view, pos + 16, 'cil-call-signature-section-table-truncated'),
      rawOffset:readU32(view, pos + 20, 'cil-call-signature-section-table-truncated'),
    };
    if (section.rawSize) checkedRange(bytes, section.rawOffset, section.rawSize, 'cil-call-signature-section-out-of-bounds');
    sections.push(section);
  }
  const mapRva = (rva, size, code) => {
    if (!Number.isSafeInteger(rva) || !Number.isSafeInteger(size) || rva < 0 || size < 0) fail(code);
    for (const section of sections) {
      const span = Math.max(section.virtualSize, section.rawSize);
      if (rva < section.virtualAddress || rva >= section.virtualAddress + span) continue;
      const delta = rva - section.virtualAddress;
      if (delta > section.rawSize || size > section.rawSize - delta) fail(code);
      const offset = section.rawOffset + delta;
      checkedRange(bytes, offset, size, code);
      return offset;
    }
    fail(code);
  };

  const cliDirectory = directories + CLI_DIRECTORY_INDEX * 8;
  const cliRva = readU32(view, cliDirectory, 'cil-call-signature-cli-directory-truncated');
  const cliSize = readU32(view, cliDirectory + 4, 'cil-call-signature-cli-directory-truncated');
  if (!cliRva || cliSize < CLI_HEADER_SIZE) fail('cil-call-signature-cli-directory-invalid');
  const cli = mapRva(cliRva, CLI_HEADER_SIZE, 'cil-call-signature-cli-header-unmapped');
  const metadataRva = readU32(view, cli + 8, 'cil-call-signature-cli-header-truncated');
  const metadataSize = readU32(view, cli + 12, 'cil-call-signature-cli-header-truncated');
  if (!metadataRva || metadataSize < 20) fail('cil-call-signature-metadata-directory-invalid');
  return { offset:mapRva(metadataRva, metadataSize, 'cil-call-signature-metadata-unmapped'), size:metadataSize };
}

function readStreams(bytes, view, metadata) {
  checkedRange(bytes, metadata.offset, metadata.size, 'cil-call-signature-metadata-out-of-bounds');
  const end = metadata.offset + metadata.size;
  if (readU32(view, metadata.offset, 'cil-call-signature-metadata-truncated') !== 0x424a5342) {
    fail('cil-call-signature-metadata-invalid');
  }
  const versionLength = readU32(view, metadata.offset + 12, 'cil-call-signature-metadata-truncated');
  const flags = align4(metadata.offset + 16 + versionLength);
  if (flags + 4 > end) fail('cil-call-signature-metadata-truncated');
  const streamCount = readU16(view, flags + 2, 'cil-call-signature-metadata-truncated');
  let pos = flags + 4;
  const streams = [];
  for (let i = 0; i < streamCount; i++) {
    if (pos + 8 > end) fail('cil-call-signature-stream-header-truncated');
    const relativeOffset = readU32(view, pos, 'cil-call-signature-stream-header-truncated');
    const size = readU32(view, pos + 4, 'cil-call-signature-stream-header-truncated');
    pos += 8;
    const nameStart = pos;
    while (pos < end && bytes[pos] !== 0) pos++;
    if (pos >= end) fail('cil-call-signature-stream-name-truncated');
    const name = new TextDecoder('ascii').decode(bytes.subarray(nameStart, pos));
    pos = align4(pos + 1);
    if (relativeOffset > metadata.size || size > metadata.size - relativeOffset) fail('cil-call-signature-stream-out-of-bounds');
    streams.push({ name, offset:metadata.offset + relativeOffset, size });
  }
  const tables = streams.find((stream) => stream.name === '#~' || stream.name === '#-');
  const blob = streams.find((stream) => stream.name === '#Blob');
  if (!tables || !blob) fail('cil-call-signature-metadata-stream-missing');
  return { tables, blob };
}

export function buildCilCallMetadataIndex(bytes) {
  if (!(bytes instanceof Uint8Array)) fail('cil-call-signature-bytes-required');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const streams = readStreams(bytes, view, readPeMetadataDirectory(bytes, view));
  checkedRange(bytes, streams.tables.offset, streams.tables.size, 'cil-call-signature-tables-out-of-bounds');
  checkedRange(bytes, streams.blob.offset, streams.blob.size, 'cil-call-signature-blob-out-of-bounds');
  if (streams.tables.size < 24) fail('cil-call-signature-tables-truncated');
  const start = streams.tables.offset;
  const end = start + streams.tables.size;
  const heapSizes = bytes[start + 6];
  const valid = BigInt(readU32(view, start + 8, 'cil-call-signature-tables-truncated'))
    | (BigInt(readU32(view, start + 12, 'cil-call-signature-tables-truncated')) << 32n);
  const rowCounts = new Array(64).fill(0);
  let pos = start + 24;
  for (let table = 0; table < 64; table++) {
    if ((valid & (1n << BigInt(table))) === 0n) continue;
    if (pos + 4 > end) fail('cil-call-signature-row-counts-truncated');
    rowCounts[table] = readU32(view, pos, 'cil-call-signature-row-counts-truncated');
    pos += 4;
  }

  const methodDefs = [];
  const memberRefs = [];
  const methodSpecs = [];
  const stringIndexSize = (heapSizes & 0x01) !== 0 ? 4 : 2;
  const blobIndexSize = (heapSizes & 0x04) !== 0 ? 4 : 2;
  for (let table = 0; table < 64; table++) {
    const rows = rowCounts[table] || 0;
    if (!rows) continue;
    const rowSize = metadataRowSize(table, rowCounts, heapSizes);
    if (!Number.isSafeInteger(rowSize) || rowSize < 1 || rows > Math.floor((end - pos) / rowSize)) {
      fail('cil-call-signature-table-data-truncated');
    }
    if (table === METHOD_DEF_TABLE) {
      const signatureOffset = 8 + stringIndexSize;
      for (let row = 0; row < rows; row++) {
        methodDefs.push(readIndex(view, pos + row * rowSize + signatureOffset, blobIndexSize,
          'cil-call-signature-methoddef-truncated'));
      }
    } else if (table === MEMBER_REF_TABLE) {
      const parentSize = codedIndexSize(rowCounts, [0x02, 0x01, 0x1a, 0x06, 0x1b], 3);
      for (let row = 0; row < rows; row++) {
        memberRefs.push(readIndex(view, pos + row * rowSize + parentSize + stringIndexSize, blobIndexSize,
          'cil-call-signature-memberref-truncated'));
      }
    } else if (table === METHOD_SPEC_TABLE) {
      const methodSize = codedIndexSize(rowCounts, [0x06, 0x0a], 1);
      for (let row = 0; row < rows; row++) {
        const rowPos = pos + row * rowSize;
        methodSpecs.push({
          method:readIndex(view, rowPos, methodSize, 'cil-call-signature-methodspec-truncated'),
          instantiation:readIndex(view, rowPos + methodSize, blobIndexSize, 'cil-call-signature-methodspec-truncated'),
        });
      }
    }
    pos += rows * rowSize;
  }
  return Object.freeze({
    methodDefs:Object.freeze(methodDefs),
    memberRefs:Object.freeze(memberRefs),
    methodSpecs:Object.freeze(methodSpecs),
    blobHeap:bytes.subarray(streams.blob.offset, streams.blob.offset + streams.blob.size),
  });
}

function readCompressedLength(bytes, offset, code) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= bytes.length) fail(code);
  const b0 = bytes[offset];
  if ((b0 & 0x80) === 0) return { value:b0, next:offset + 1 };
  if ((b0 & 0xc0) === 0x80) {
    if (offset + 1 >= bytes.length) fail(code);
    const value = ((b0 & 0x3f) << 8) | bytes[offset + 1];
    if (value < 0x80) fail(code);
    return { value, next:offset + 2 };
  }
  if ((b0 & 0xe0) === 0xc0) {
    if (offset + 3 >= bytes.length) fail(code);
    const value = ((b0 & 0x1f) * 0x1000000) + (bytes[offset + 1] << 16)
      + (bytes[offset + 2] << 8) + bytes[offset + 3];
    if (value < 0x4000) fail(code);
    return { value, next:offset + 4 };
  }
  fail(code);
}

export function readCilMetadataBlob(heap, index, code) {
  if (!(heap instanceof Uint8Array) || !Number.isSafeInteger(index) || index < 1 || index >= heap.length) fail(code);
  const length = readCompressedLength(heap, index, code);
  if (length.value > heap.length - length.next) fail(code);
  return heap.subarray(length.next, length.next + length.value);
}
