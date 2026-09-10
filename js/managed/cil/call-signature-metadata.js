import { codedIndexSize, metadataRowSize } from './metadata-layout.js';
import { readCilMetadataStreams } from './metadata-streams.js';
import { CLI_HEADER_SIZE, validateCliHeaderSize } from './cli-header.js';
const TYPE_REF_TABLE = 0x01;
const TYPE_DEF_TABLE = 0x02;
const TYPE_SPEC_TABLE = 0x1b;
export const METHOD_DEF_TABLE = 0x06;
export const MEMBER_REF_TABLE = 0x0a;
export const STANDALONE_SIG_TABLE = 0x11;
export const METHOD_SPEC_TABLE = 0x2b;

const CLI_DIRECTORY_INDEX = 14;

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

function readIndex(view, offset, size, code) {
  return size === 2 ? readU16(view, offset, code) : readU32(view, offset, code);
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
  const cliHeaderSize = validateCliHeaderSize(
    readU32(view, cli, 'cil-call-signature-cli-header-truncated'),
    cliSize,
  );
  mapRva(cliRva, cliHeaderSize, 'cil-call-signature-cli-header-unmapped');
  const metadataRva = readU32(view, cli + 8, 'cil-call-signature-cli-header-truncated');
  const metadataSize = readU32(view, cli + 12, 'cil-call-signature-cli-header-truncated');
  if (!metadataRva || metadataSize < 20) fail('cil-call-signature-metadata-directory-invalid');
  return {
    offset:mapRva(metadataRva, metadataSize, 'cil-call-signature-metadata-unmapped'),
    size:metadataSize,
    mapRva,
  };
}

function readStreams(bytes, view, metadata) {
  const { streams } = readCilMetadataStreams(bytes, metadata.offset, metadata.size);
  const tables = streams.find((stream) => stream.name === '#~' || stream.name === '#-');
  const blob = streams.find((stream) => stream.name === '#Blob');
  const strings = streams.find((stream) => stream.name === '#Strings');
  if (!tables || !blob || !strings) fail('cil-call-signature-metadata-stream-missing');
  return { tables, blob, strings };
}

export function buildCilCallMetadataIndex(bytes) {
  if (!(bytes instanceof Uint8Array)) fail('cil-call-signature-bytes-required');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const metadata = readPeMetadataDirectory(bytes, view);
  const streams = readStreams(bytes, view, metadata);
  checkedRange(bytes, streams.tables.offset, streams.tables.size, 'cil-call-signature-tables-out-of-bounds');
  checkedRange(bytes, streams.blob.offset, streams.blob.size, 'cil-call-signature-blob-out-of-bounds');
  checkedRange(bytes, streams.strings.offset, streams.strings.size, 'cil-call-signature-strings-out-of-bounds');
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
  const standAloneSigs = [];
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
        const rowPos = pos + row * rowSize;
        const rva = readU32(view, rowPos, 'cil-call-signature-methoddef-truncated');
        methodDefs.push(Object.freeze({
          rva,
          bodyOffset:rva === 0 ? null : metadata.mapRva(rva, 1, 'cil-call-signature-method-body-unmapped'),
          accessFlags:readU16(view, rowPos + 6, 'cil-call-signature-methoddef-truncated'),
          nameIndex:readIndex(view, rowPos + 8, stringIndexSize, 'cil-call-signature-methoddef-truncated'),
          signatureBlobIndex:readIndex(view, rowPos + signatureOffset, blobIndexSize,
            'cil-call-signature-methoddef-truncated'),
        }));
      }
    } else if (table === MEMBER_REF_TABLE) {
      const parentSize = codedIndexSize(rowCounts, [0x02, 0x01, 0x1a, 0x06, 0x1b], 3);
      for (let row = 0; row < rows; row++) {
        const rowPos = pos + row * rowSize;
        memberRefs.push(Object.freeze({
          nameIndex:readIndex(view, rowPos + parentSize, stringIndexSize, 'cil-call-signature-memberref-truncated'),
          signatureBlobIndex:readIndex(view, rowPos + parentSize + stringIndexSize, blobIndexSize,
            'cil-call-signature-memberref-truncated'),
        }));
      }
    } else if (table === STANDALONE_SIG_TABLE) {
      // Local variable signatures (ECMA-335 II.22.27): the fat method header's
      // LocalVarSigTok targets these rows, and locals typing needs the same
      // metadata authority as arguments (#5353).
      for (let row = 0; row < rows; row++) {
        standAloneSigs.push(readIndex(view, pos + row * rowSize, blobIndexSize,
          'cil-call-signature-standalonesig-truncated'));
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
    standAloneSigs:Object.freeze(standAloneSigs),
    typeDefOrRefRowCounts:Object.freeze([
      rowCounts[TYPE_DEF_TABLE],
      rowCounts[TYPE_REF_TABLE],
      rowCounts[TYPE_SPEC_TABLE],
    ]),
    blobHeap:bytes.subarray(streams.blob.offset, streams.blob.offset + streams.blob.size),
    stringsHeap:bytes.subarray(streams.strings.offset, streams.strings.offset + streams.strings.size),
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

export function readCilMetadataString(heap, index, code) {
  if (!(heap instanceof Uint8Array) || !Number.isSafeInteger(index) || index < 1 || index >= heap.length) fail(code);
  let end = index;
  while (end < heap.length && heap[end] !== 0) end++;
  if (end >= heap.length || end === index) fail(code);
  try {
    return new TextDecoder('utf-8', { fatal:true }).decode(heap.subarray(index, end));
  } catch {
    fail(code);
  }
}
