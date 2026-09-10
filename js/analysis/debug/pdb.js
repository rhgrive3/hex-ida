/**
 * P7-5b — PDB provider.
 *
 * A second debug ecosystem behind the *same* boundary. That is the point of
 * this checkpoint: DWARF working is not the phase, and a PDB backend with its
 * own private route into type recovery would defeat the boundary entirely
 * (§11.1 step 6).
 *
 * Reads the MSF container, the PDB info stream (identity), the symbol record
 * stream (S_PUB32 / S_GPROC32 / S_LPROC32), the section header stream, and a
 * practical subset of TPI leaf records. Everything outside that subset is
 * reported as a diagnostic and keeps the result incomplete.
 *
 * Identity is the PDB GUID and age compared against the RSDS entry in the PE
 * debug directory. A matching filename proves nothing and is never accepted.
 */

import { createAnalysisStatus } from '../status.js';
import {
  DEBUG_DEFAULT_BUDGET,
  DEBUG_DEFAULT_PAGE_SIZE,
  DebugInfoProvider,
  createDebugPage,
  createDebugProviderResult,
  createDebugRecord,
  resolveDebugBudget,
} from './provider.js';

export const PDB_PROVIDER_ID = 'phase7.debug.pdb';
export const PDB_PROVIDER_VERSION = '1.0.0';

const MSF_MAGIC = 'Microsoft C/C++ MSF 7.00\r\n\u001aDS\0\0\0';

/** CodeView symbol record kinds this provider models. */
const S_PUB32 = 0x110e;
const S_LPROC32 = 0x110f;
const S_GPROC32 = 0x1110;
const S_LPROC32_ID = 0x1146;
const S_GPROC32_ID = 0x1147;

/** TPI leaf kinds this provider models. */
const LF_MODIFIER = 0x1001;
const LF_POINTER = 0x1002;
const LF_PROCEDURE = 0x1008;
const LF_ARGLIST = 0x1201;
const LF_FIELDLIST = 0x1203;
const LF_STRUCTURE = 0x1505;
const LF_CLASS = 0x1504;
const LF_UNION = 0x1506;
const LF_ENUM = 0x1507;
const LF_ARRAY = 0x1503;
const LF_MEMBER = 0x150d;

/** CodeView LF_MODIFIER flags. These are independent bits, not an enum. */
const MODIFIER_CONST = 0x0001;
const MODIFIER_VOLATILE = 0x0002;
const MODIFIER_UNALIGNED = 0x0004;
const MODIFIER_KNOWN_MASK = MODIFIER_CONST | MODIFIER_VOLATILE | MODIFIER_UNALIGNED;

/** CV_PUBSYMFLAGS: bit 1 marks a function. */
const CVPSF_FUNCTION = 0x00000002;

/**
 * Built-in type indices below 0x1000. Only the common ones are named; anything
 * else is reported as `unknown` rather than guessed.
 */
const PRIMITIVE_TYPES = Object.freeze({
  0x0003: { name: 'void', widthBits: 0, class: 'void' },
  0x0010: { name: 'char', widthBits: 8, class: 'integer' },
  0x0020: { name: 'unsigned char', widthBits: 8, class: 'integer' },
  0x0068: { name: 'int8_t', widthBits: 8, class: 'integer' },
  0x0069: { name: 'uint8_t', widthBits: 8, class: 'integer' },
  0x0070: { name: 'char', widthBits: 8, class: 'integer' },
  0x0071: { name: 'wchar_t', widthBits: 16, class: 'integer' },
  0x0072: { name: 'int16_t', widthBits: 16, class: 'integer' },
  0x0073: { name: 'uint16_t', widthBits: 16, class: 'integer' },
  0x0074: { name: 'int', widthBits: 32, class: 'integer' },
  0x0075: { name: 'unsigned', widthBits: 32, class: 'integer' },
  0x0076: { name: 'int64_t', widthBits: 64, class: 'integer' },
  0x0077: { name: 'uint64_t', widthBits: 64, class: 'integer' },
  0x0040: { name: 'float', widthBits: 32, class: 'float' },
  0x0041: { name: 'double', widthBits: 64, class: 'float' },
});

function bytesOf(value) {
  if (value == null) return null;
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return null;
}

function cstring(bytes, offset, limit = bytes.length) {
  let end = offset;
  while (end < limit && bytes[end] !== 0) end += 1;
  return new TextDecoder('utf8').decode(bytes.subarray(offset, end));
}

function cstringWithNext(bytes, offset, limit = bytes.length) {
  let end = offset;
  while (end < limit && bytes[end] !== 0) end += 1;
  if (end >= limit) return null;
  return {
    value: new TextDecoder('utf8').decode(bytes.subarray(offset, end)),
    next: end + 1,
  };
}

/** Reads the MSF superblock and stream directory. */
export function parseMsf(bytes) {
  const data = bytesOf(bytes);
  if (!data || data.length < 56) return { streams: [], diagnostics: ['file too small for an MSF superblock'], complete: false };
  const magic = new TextDecoder('latin1').decode(data.subarray(0, MSF_MAGIC.length));
  if (magic !== MSF_MAGIC) return { streams: [], diagnostics: ['not an MSF 7.00 container'], complete: false };

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const blockSize = view.getUint32(32, true);
  /* MSF's FreeBlockMapBlock selects which of blocks 1/2 holds the active free
     block map; the LLVM MSF format documentation allows only those two values
     (#5672). */
  const freeBlockMapBlock = view.getUint32(36, true);
  const numBlocks = view.getUint32(40, true);
  const numDirectoryBytes = view.getUint32(44, true);
  const blockMapAddr = view.getUint32(52, true);
  if (blockSize === 0 || (blockSize & (blockSize - 1)) !== 0) {
    return { streams: [], diagnostics: ['invalid MSF block size'], complete: false };
  }
  if (freeBlockMapBlock !== 1 && freeBlockMapBlock !== 2) {
    return { streams: [], diagnostics: [`invalid MSF free block map index ${freeBlockMapBlock}`], complete: false };
  }
  /* NumBlocks is the total block count of the on-disk file (LLVM MSF format
     documentation): NumBlocks * BlockSize must equal the file size, not
     merely stay within one block of it (#5665). A missing trailing block
     would let streams reference unreadable data while reporting complete. */
  if (numBlocks * blockSize !== data.length) {
    return { streams: [], diagnostics: ['MSF block count does not match the file size'], complete: false };
  }
  if (numDirectoryBytes < 4) {
    return { streams: [], diagnostics: ['MSF stream directory is truncated'], complete: false };
  }

  const readBlock = (index) => {
    const start = index * blockSize;
    if (start + blockSize > data.length) return null;
    return data.subarray(start, start + blockSize);
  };
  const concatBlocks = (indices, byteLength) => {
    if (indices.length * blockSize < byteLength) return null;
    const out = new Uint8Array(byteLength);
    let written = 0;
    for (const index of indices) {
      const block = readBlock(index);
      if (!block) return null;
      const take = Math.min(blockSize, byteLength - written);
      out.set(block.subarray(0, take), written);
      written += take;
      if (written >= byteLength) break;
    }
    return written === byteLength ? out : null;
  };

  // The directory is itself stored in blocks whose indices live in the block map.
  const directoryBlockCount = Math.ceil(numDirectoryBytes / blockSize);
  const mapBlock = readBlock(blockMapAddr);
  if (!mapBlock) return { streams: [], diagnostics: ['MSF block map is out of range'], complete: false };
  const mapView = new DataView(mapBlock.buffer, mapBlock.byteOffset, mapBlock.byteLength);
  const directoryBlocks = [];
  for (let index = 0; index < directoryBlockCount; index += 1) {
    if ((index + 1) * 4 > mapBlock.length) break;
    directoryBlocks.push(mapView.getUint32(index * 4, true));
  }
  const directory = concatBlocks(directoryBlocks, numDirectoryBytes);
  if (!directory) return { streams: [], diagnostics: ['MSF stream directory is truncated'], complete: false };

  const directoryView = new DataView(directory.buffer, directory.byteOffset, directory.byteLength);
  const numStreams = directoryView.getUint32(0, true);
  const sizes = [];
  let cursor = 4;
  for (let index = 0; index < numStreams; index += 1) {
    if (cursor + 4 > directory.length) return { streams: [], diagnostics: ['MSF directory sizes are truncated'], complete: false };
    const size = directoryView.getUint32(cursor, true);
    // 0xffffffff marks a stream that does not exist.
    sizes.push(size === 0xffffffff ? 0 : size);
    cursor += 4;
  }
  const streams = [];
  for (let index = 0; index < numStreams; index += 1) {
    const count = Math.ceil(sizes[index] / blockSize);
    const blocks = [];
    for (let block = 0; block < count; block += 1) {
      if (cursor + 4 > directory.length) return { streams, diagnostics: ['MSF directory block list is truncated'], complete: false };
      blocks.push(directoryView.getUint32(cursor, true));
      cursor += 4;
    }
    streams.push({ index, size: sizes[index], read: () => (sizes[index] === 0 ? new Uint8Array(0) : concatBlocks(blocks, sizes[index])) });
  }
  return { streams, blockSize, diagnostics: [], complete: true };
}

function guidString(bytes, offset) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const d1 = view.getUint32(offset, true);
  const d2 = view.getUint16(offset + 4, true);
  const d3 = view.getUint16(offset + 6, true);
  const rest = [...bytes.subarray(offset + 8, offset + 16)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${d1.toString(16).padStart(8, '0')}-${d2.toString(16).padStart(4, '0')}-${d3.toString(16).padStart(4, '0')}-${rest.slice(0, 4)}-${rest.slice(4)}`.toUpperCase();
}

/** Stream 1: version, signature, age, GUID. */
export function parsePdbInfoStream(bytes) {
  if (!bytes || bytes.length < 28) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    version: view.getUint32(0, true),
    signature: view.getUint32(4, true),
    age: view.getUint32(8, true),
    guid: guidString(bytes, 12),
  };
}

/**
 * DBI header (NewDBIHdr).
 *
 * The substream sizes matter as much as the stream indices: the optional debug
 * header, which names the section-header stream, sits after all of them, and
 * getting one size wrong silently points at the wrong stream.
 */
export const DBI_HEADER_SIZE = 64;
const DBI_MIN_VERSION_HEADER = 19990903;

export function parseDbiHeader(bytes) {
  if (!bytes || bytes.length < DBI_HEADER_SIZE) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const versionSignature = view.getInt32(0, true);
  const versionHeader = view.getUint32(4, true);
  // A length-only check can turn a corrupt stream 3 into authoritative DBI
  // provenance. Match the native PDB reader's minimum structural gate before
  // using its age or stream indices for symbol authority.
  if (versionSignature !== -1 || versionHeader < DBI_MIN_VERSION_HEADER) return null;
  const moduleSubstreamSize = view.getInt32(24, true);
  const sectionContributionSize = view.getInt32(28, true);
  const sectionMapSize = view.getInt32(32, true);
  const sourceInfoSize = view.getInt32(36, true);
  const typeServerMapSize = view.getInt32(40, true);
  const optionalDbgHeaderSize = view.getInt32(48, true);
  const ecSubstreamSize = view.getInt32(52, true);
  const substreamSizes = [
    moduleSubstreamSize,
    sectionContributionSize,
    sectionMapSize,
    sourceInfoSize,
    typeServerMapSize,
    optionalDbgHeaderSize,
    ecSubstreamSize,
  ];
  if (substreamSizes.some((size) => size < 0)) return null;
  const declaredLength = DBI_HEADER_SIZE
    + substreamSizes.reduce((total, size) => total + size, 0);
  if (declaredLength !== bytes.length) return null;
  return {
    versionSignature,
    versionHeader,
    age: view.getUint32(8, true),
    globalStreamIndex: view.getUint16(12, true),
    publicStreamIndex: view.getUint16(16, true),
    symRecordStreamIndex: view.getUint16(20, true),
    moduleSubstreamSize,
    sectionContributionSize,
    sectionMapSize,
    sourceInfoSize,
    typeServerMapSize,
    optionalDbgHeaderSize,
    ecSubstreamSize,
  };
}

/**
 * Module entries from the DBI module substream.
 *
 * Procedure symbols with type indices live in per-module streams, not in the
 * global symbol record stream, so reaching them means walking this list.
 */
export function parseModuleInfo(bytes, dbi) {
  const modules = [];
  // A silently truncated scan is indistinguishable from an empty module list
  // unless the scan reports its own completeness (#5746/#5744): missing module
  // entries mean missing per-module procedure symbols, so the caller must not
  // treat the provider evidence as complete.
  let complete = true;
  if (!dbi || dbi.moduleSubstreamSize <= 0) return { modules, complete };
  // A declared module substream with no backing bytes is truncated evidence,
  // not a complete empty list (#5746/#5744).
  if (!bytes) return { modules, complete: false };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const declaredEnd = DBI_HEADER_SIZE + dbi.moduleSubstreamSize;
  const end = Math.min(declaredEnd, bytes.length);
  if (end < declaredEnd) complete = false;
  let offset = DBI_HEADER_SIZE;
  while (offset + 64 <= end) {
    // ModInfo::ModuleSymStream is uint16_t. Treat only 0xffff as the PDB nil
    // sentinel; the upper half of the 16-bit namespace contains valid stream
    // indices and must not become negative through a signed read (#4431).
    const streamIndex = view.getUint16(offset + 34, true);
    const symbolByteSize = view.getUint32(offset + 36, true);
    const moduleNameEntry = cstringWithNext(bytes, offset + 64, end);
    if (!moduleNameEntry) { complete = false; break; }
    const objectNameEntry = cstringWithNext(bytes, moduleNameEntry.next, end);
    if (!objectNameEntry) { complete = false; break; }
    let cursor = objectNameEntry.next;
    // Entries are aligned to 4 bytes.
    cursor = (cursor + 3) & ~3;
    if (cursor <= offset || cursor > end) { complete = false; break; }
    modules.push({
      streamIndex,
      symbolByteSize,
      moduleName: moduleNameEntry.value,
      objectName: objectNameEntry.value,
    });
    offset = cursor;
  }
  if (end - offset >= 4 || (offset === DBI_HEADER_SIZE && end > offset)) complete = false;
  return { modules, complete };
}

/** PE section headers, as stored in the PDB's section-header stream. */
export function parseSectionHeaders(bytes) {
  const headers = [];
  if (!bytes) return headers;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 0; offset + 40 <= bytes.length; offset += 40) {
    headers.push({
      name: cstring(bytes, offset, offset + 8),
      virtualSize: view.getUint32(offset + 8, true),
      virtualAddress: view.getUint32(offset + 12, true),
      sizeOfRawData: view.getUint32(offset + 16, true),
    });
  }
  return headers;
}

/**
 * PE/COFF virtual extent of a section: VirtualSize is authoritative, falling
 * back to SizeOfRawData for the zero-VirtualSize legacy case (Microsoft
 * PE/COFF spec: a section occupies max(VirtualSize, SizeOfRawData) bytes of
 * its VA window; a VirtualSize of 0 means the field was never populated).
 */
function sectionVirtualExtent(header) {
  if (!header) return 0;
  const declared = header.virtualSize >>> 0;
  const raw = header.sizeOfRawData >>> 0;
  return declared > 0 ? declared : raw;
}

/**
 * Walks a CodeView symbol record stream.
 *
 * Records are length-prefixed, so an unrecognised kind can be skipped safely —
 * unlike DWARF forms, which have no self-describing length.
 */
export function parseSymbolRecords(bytes, budget = DEBUG_DEFAULT_BUDGET) {
  const { maxRecords } = resolveDebugBudget(budget);
  const symbols = [];
  const unmodelled = new Set();
  if (!bytes) return { symbols, unmodelled, complete: false };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  let recordCount = 0;
  while (offset + 4 <= bytes.length && recordCount < maxRecords) {
    const length = view.getUint16(offset, true);
    if (length < 2) break;
    const kind = view.getUint16(offset + 2, true);
    const end = offset + 2 + length;
    if (end > bytes.length) break;
    recordCount += 1;

    // Fixed-field reads are confined to the record's own end (#1845): a short
    // known-kind record must fail closed instead of reading the next record's
    // bytes as its fields, or faulting past the stream end.
    const fieldEnd = kind === S_PUB32 ? offset + 14
      : (kind === S_GPROC32 || kind === S_LPROC32 || kind === S_GPROC32_ID || kind === S_LPROC32_ID)
        ? offset + 38
        : end;
    if (fieldEnd > end) break;
    if (kind === S_PUB32) {
      const nameEntry = cstringWithNext(bytes, offset + 14, end);
      if (!nameEntry) break;
      const flags = view.getUint32(offset + 4, true);
      symbols.push({
        kind: 'public',
        flags,
        isFunction: (flags & CVPSF_FUNCTION) !== 0,
        offsetInSegment: view.getUint32(offset + 8, true),
        segment: view.getUint16(offset + 12, true),
        sizeBytes: null,
        name: nameEntry.value,
        recordOffset: offset,
      });
    } else if (kind === S_GPROC32 || kind === S_LPROC32 || kind === S_GPROC32_ID || kind === S_LPROC32_ID) {
      // PROCSYM32: parent/end/next (12) + length/dbgStart/dbgEnd (12) + typeIndex (4)
      // + offset (4) + segment (2) + flags (1) + name
      const nameEntry = cstringWithNext(bytes, offset + 39, end);
      if (!nameEntry) break;
      symbols.push({
        kind: 'procedure',
        isFunction: true,
        sizeBytes: view.getUint32(offset + 16, true),
        typeIndex: view.getUint32(offset + 28, true),
        offsetInSegment: view.getUint32(offset + 32, true),
        segment: view.getUint16(offset + 36, true),
        name: nameEntry.value,
        recordOffset: offset,
      });
    } else {
      unmodelled.add(kind);
    }
    offset = end;
  }
  return { symbols, unmodelled, complete: offset >= bytes.length };
}

/** Walks the TPI stream's leaf records. */
export function parseTpiStream(bytes, budget = DEBUG_DEFAULT_BUDGET) {
  const { maxRecords } = resolveDebugBudget(budget);
  const types = new Map();
  const unmodelled = new Set();
  if (!bytes || bytes.length < 56) return { types, unmodelled, complete: false, firstIndex: 0x1000 };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerSize = view.getUint32(4, true);
  const firstIndex = view.getUint32(8, true);
  const lastIndex = view.getUint32(12, true);
  const typeRecordBytes = view.getUint32(16, true);
  if (headerSize < 56 || headerSize > bytes.length) {
    return { types, unmodelled, complete: false, firstIndex };
  }
  // The header owns the record range: record data starts at HeaderSize and
  // covers exactly TypeRecordBytes bytes, and the declared index window
  // (TypeIndexEnd - TypeIndexBegin) must match what is actually parsed.
  // Anything past that range is not a type record and must never become one
  // (#5845).
  const typeDataStart = headerSize;
  const typeDataEnd = typeDataStart + typeRecordBytes;
  if (typeRecordBytes > bytes.length - typeDataStart) {
    return { types, unmodelled, complete: false, firstIndex };
  }
  const expectedCount = lastIndex >= firstIndex ? lastIndex - firstIndex : -1;
  if (expectedCount < 0) {
    return { types, unmodelled, complete: false, firstIndex };
  }
  let offset = typeDataStart;
  let index = firstIndex;
  let fieldListsComplete = true;

  while (offset + 4 <= typeDataEnd && index - firstIndex < expectedCount && types.size < maxRecords) {
    const length = view.getUint16(offset, true);
    if (length < 2) break;
    const leaf = view.getUint16(offset + 2, true);
    const end = offset + 2 + length;
    if (end > typeDataEnd) break;
    const body = offset + 4;

    // Fixed-field reads are confined to the record's own end (#1845): a short
    // known-leaf record must fail closed instead of reading the next record's
    // bytes as its fields, or faulting past the stream end.
    const bodyEnd = {
      [LF_STRUCTURE]: body + 18, [LF_CLASS]: body + 18, [LF_UNION]: body + 10,
      [LF_POINTER]: body + 8, [LF_MODIFIER]: body + 6, [LF_PROCEDURE]: body + 12,
      [LF_ARRAY]: body + 8, [LF_ENUM]: body + 8,
    }[leaf] ?? end;
    if (bodyEnd > end) break;

    if (leaf === LF_STRUCTURE || leaf === LF_CLASS || leaf === LF_UNION) {
      const count = view.getUint16(body, true);
      const properties = view.getUint16(body + 2, true);
      // LF_UNION carries MemberCount/Properties/FieldList/Size/Name just like
      // LF_STRUCTURE/LF_CLASS (only Size sits at a different offset): dropping
      // its FieldList index severed every union from its member layout (#6045).
      const fieldList = view.getUint32(body + 4, true);
      const sizeOffset = leaf === LF_UNION ? body + 8 : body + 16;
      const numeric = readNumeric(view, bytes, sizeOffset, end);
      if (!numeric) break;
      const { value: sizeBytes, next } = numeric;
      // Type names are NUL-terminated: a record that ends without one is
      // truncated, not a complete type with a shorter name (#5265).
      const nameEntry = cstringWithNext(bytes, next, end);
      if (!nameEntry) break;
      const keyword = leaf === LF_UNION ? 'union' : leaf === LF_CLASS ? 'class' : 'struct';
      types.set(index, {
        leaf, kind: 'aggregate', keyword,
        // Bit 7 of the property field marks a forward reference: it names the
        // type but carries no layout, so it is not a complete fact.
        forwardReference: (properties & 0x0080) !== 0,
        memberCount: count,
        fieldList,
        sizeBytes,
        name: nameEntry.value,
      });
    } else if (leaf === LF_POINTER) {
      types.set(index, { leaf, kind: 'pointer', referent: view.getUint32(body, true), attributes: view.getUint32(body + 4, true) });
    } else if (leaf === LF_MODIFIER) {
      types.set(index, { leaf, kind: 'modifier', underlying: view.getUint32(body, true), modifiers: view.getUint16(body + 4, true) });
    } else if (leaf === LF_PROCEDURE) {
      types.set(index, {
        leaf, kind: 'procedure',
        returnType: view.getUint32(body, true),
        callingConvention: view.getUint8(body + 4),
        functionOptions: view.getUint8(body + 5),
        parameterCount: view.getUint16(body + 6, true),
        argumentList: view.getUint32(body + 8, true),
      });
    } else if (leaf === LF_ARRAY) {
      const numeric = readNumeric(view, bytes, body + 8, end);
      if (!numeric) break;
      const { value: sizeBytes } = numeric;
      types.set(index, { leaf, kind: 'array', elementType: view.getUint32(body, true), sizeBytes });
    } else if (leaf === LF_ENUM) {
      types.set(index, { leaf, kind: 'enum', underlying: view.getUint32(body + 4, true), name: null });
    } else if (leaf === LF_FIELDLIST) {
      const fieldList = parseFieldList(view, bytes, body, end, unmodelled);
      if (!fieldList.complete) fieldListsComplete = false;
      types.set(index, { leaf, kind: 'field-list', members: fieldList.members, complete: fieldList.complete });
    } else if (leaf === LF_ARGLIST) {
      // Historical fixtures contain a leaf-only LF_ARGLIST. Preserve the
      // record boundary/stream walk, but never let that shape prove an exact
      // procedure signature because it does not carry a count.
      if (body + 4 > end) {
        types.set(index, { leaf, kind: 'arg-list', arguments: [], complete: false });
        offset = end;
        index += 1;
        continue;
      }
      const count = view.getUint32(body, true);
      const argumentBytes = count * 4;
      if (!Number.isSafeInteger(argumentBytes) || argumentBytes > end - (body + 4)) break;
      const arguments_ = [];
      for (let cursor = body + 4; cursor < body + 4 + argumentBytes; cursor += 4) {
        arguments_.push(view.getUint32(cursor, true));
      }
      types.set(index, { leaf, kind: 'arg-list', arguments: arguments_, complete: true });
    } else {
      unmodelled.add(leaf);
      types.set(index, { leaf, kind: 'unmodelled' });
    }
    offset = end;
    index += 1;
  }
  // An incomplete field-list child (unsupported subrecord) fails the stream
  // closed (#5773). Complete also only when the declared record extent was
  // fully consumed and the parsed record count matches TypeIndexEnd -
  // TypeIndexBegin; trailing bytes beyond TypeRecordBytes (e.g. hash data)
  // are not type records and do not block completeness (#5845).
  return {
    types,
    unmodelled,
    complete: fieldListsComplete && expectedCount >= 0 && offset >= typeDataEnd && index - firstIndex === expectedCount,
    firstIndex,
  };
}

/**
 * CodeView numeric leaves: a value below 0x8000 is the value itself; otherwise
 * the value's width is encoded in the leaf.
 *
 * Fixed-size leaves beyond 0x8004 (REAL32/64, QUADWORD/UQUADWORD, REAL80/128,
 * REAL48) carry payloads that must be consumed; anything else has no known
 * shape here and fails closed so the record desyncs loudly instead of
 * decoding its payload as the next field (#5262).
 */
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_BIGINT = -MAX_SAFE_BIGINT;
const NUMERIC_TAIL_BYTES = {
  0x8005: 4, 0x8006: 8, 0x8007: 10, 0x8008: 16, 0x8009: 8, 0x800a: 8, 0x800b: 6,
};
function readNumeric(view, bytes, offset, end = bytes.length) {
  if (offset + 2 > end) return null;
  const raw = view.getUint16(offset, true);
  if (raw < 0x8000) return { value: raw, next: offset + 2 };
  const tail = raw === 0x8000 ? 1
    : (raw === 0x8001 || raw === 0x8002) ? 2
      : (raw === 0x8003 || raw === 0x8004) ? 4
        : NUMERIC_TAIL_BYTES[raw] ?? null;
  if (tail == null) return null;
  if (offset + 2 + tail > end) return null;
  switch (raw) {
    case 0x8000: return { value: view.getInt8(offset + 2), next: offset + 3 };
    case 0x8001: return { value: view.getInt16(offset + 2, true), next: offset + 4 };
    case 0x8002: return { value: view.getUint16(offset + 2, true), next: offset + 4 };
    case 0x8003: return { value: view.getInt32(offset + 2, true), next: offset + 6 };
    case 0x8004: return { value: view.getUint32(offset + 2, true), next: offset + 6 };
    case 0x8005: return { value: view.getFloat32(offset + 2, true), next: offset + 6 };
    case 0x8006: return { value: view.getFloat64(offset + 2, true), next: offset + 10 };
    case 0x8009: {
      const quad = view.getBigInt64(offset + 2, true);
      return { value: quad >= MIN_SAFE_BIGINT && quad <= MAX_SAFE_BIGINT ? Number(quad) : null, next: offset + 10 };
    }
    case 0x800a: {
      const uquad = view.getBigUint64(offset + 2, true);
      return { value: uquad <= MAX_SAFE_BIGINT ? Number(uquad) : null, next: offset + 10 };
    }
    // REAL80/REAL128/REAL48 have no exact JS number: consume the payload so
    // the record stays in sync, but report no value.
    case 0x8007:
    case 0x8008:
    case 0x800b: return { value: null, next: offset + 2 + tail };
    default: return null;
  }
}

/**
 * Parses an LF_FIELDLIST's children. Only LF_MEMBER is modeled: any other
 * (valid) field-list subrecord — LF_STMEMBER, LF_BCLASS, LF_METHOD, ... —
 * cannot be skipped reliably, so the children after it are unreachable and
 * the field list is incomplete. That incompleteness propagates to the whole
 * TPI result instead of silently publishing a partial member list as an
 * exact layout (#5773).
 */
function parseFieldList(view, bytes, start, end, unmodelled) {
  const members = [];
  let offset = start;
  let complete = true;
  while (offset + 2 <= end) {
    const leaf = view.getUint16(offset, true);
    if (leaf !== LF_MEMBER) {
      unmodelled.add(leaf);
      complete = false;
      break;
    }
    if (offset + 8 > end) { complete = false; break; }
    const typeIndex = view.getUint32(offset + 4, true);
    const numeric = readNumeric(view, bytes, offset + 8, end);
    if (!numeric || numeric.value == null) { complete = false; break; }
    const { value: fieldOffset, next } = numeric;
    const nameEntry = cstringWithNext(bytes, next, end);
    if (!nameEntry) { complete = false; break; }
    members.push({ name: nameEntry.value, typeIndex, offset: fieldOffset });
    // Records are padded to a 4-byte boundary with 0xf1..0xf3 filler.
    let cursor = nameEntry.next;
    while (cursor < end && bytes[cursor] >= 0xf0) cursor += 1;
    if (cursor <= offset) { complete = false; break; }
    offset = cursor;
  }
  return { members, complete: complete && offset === end };
}

/** Renders a TPI type index as a nominal name plus machine facts. */
export function describeTypeIndex(index, types, depth = 0) {
  if (depth > 16) return { name: 'unknown', complete: false };
  if (index < 0x1000) {
    const primitive = PRIMITIVE_TYPES[index];
    if (primitive) return { ...primitive, complete: true };
    // The high nibble of a primitive index encodes an indirection mode:
    // 0x0400: NearPointer32, 0x0500: FarPointer32, 0x0600: NearPointer64, 0x0700: NearPointer128
    const mode = index & 0x0700;
    if (mode === 0x0400 || mode === 0x0500 || mode === 0x0600 || mode === 0x0700) {
      const widthBits = (mode === 0x0400 || mode === 0x0500) ? 32 : (mode === 0x0600) ? 64 : 128;
      const target = describeTypeIndex(index & 0x00ff, types, depth + 1);
      const isKnown = target.name !== 'unknown' && target.complete;
      return {
        name: isKnown ? `${target.name} *` : 'unknown *',
        widthBits,
        class: 'pointer',
        complete: isKnown,
      };
    }
    return { name: 'unknown', complete: false };
  }
  const record = types.get(index);
  if (!record) return { name: 'unknown', complete: false };
  if (record.kind === 'aggregate') {
    return {
      name: record.name ? `${record.keyword} ${record.name}` : `${record.keyword} <anonymous>`,
      sizeBytes: record.sizeBytes,
      isAggregate: true,
      complete: !record.forwardReference && record.sizeBytes != null,
    };
  }
  if (record.kind === 'pointer') {
    const target = describeTypeIndex(record.referent, types, depth + 1);
    const attrs = typeof record.attributes === 'number' ? record.attributes : 0;
    const sizeBytes = (attrs >> 13) & 0x3f;
    const pointerKind = attrs & 0x1f;
    let widthBits = sizeBytes > 0 ? sizeBytes * 8 : null;
    if (widthBits == null) {
      if (pointerKind === 0x0a || pointerKind === 0x0b) widthBits = 32;
      else if (pointerKind === 0x0c) widthBits = 64;
    }
    const isContradictory = sizeBytes > 0 && (
      ((pointerKind === 0x0a || pointerKind === 0x0b) && sizeBytes !== 4) ||
      (pointerKind === 0x0c && sizeBytes !== 8)
    );
    const isMalformed = widthBits == null || widthBits === 0 || isContradictory;
    const complete = !isMalformed && target.complete;
    return {
      name: `${target.name} *`,
      widthBits: isMalformed ? null : widthBits,
      class: 'pointer',
      complete,
    };
  }
  if (record.kind === 'modifier') {
    const target = describeTypeIndex(record.underlying, types, depth + 1);
    const modifiers = record.modifiers;
    const validModifiers = Number.isSafeInteger(modifiers) && modifiers >= 0 && modifiers <= 0xffff;
    const qualifiers = [];
    if (validModifiers && (modifiers & MODIFIER_CONST)) qualifiers.push('const');
    if (validModifiers && (modifiers & MODIFIER_VOLATILE)) qualifiers.push('volatile');
    if (validModifiers && (modifiers & MODIFIER_UNALIGNED)) qualifiers.push('unaligned');
    // A future CodeView flag must not be dropped while retaining complete:true:
    // the rendered name is useful context, but the modifier set is not fully
    // understood and therefore cannot support an exact type claim.
    const hasUnknownModifiers = !validModifiers || (modifiers & ~MODIFIER_KNOWN_MASK) !== 0;
    const name = qualifiers.length ? `${qualifiers.join(' ')} ${target.name}` : target.name;
    return { ...target, name, complete: target.complete && !hasUnknownModifiers };
  }
  if (record.kind === 'procedure') {
    const returns = describeTypeIndex(record.returnType, types, depth + 1);
    const argumentList = types.get(record.argumentList);
    const hasArgumentList = argumentList?.kind === 'arg-list'
      && argumentList.complete === true
      && Array.isArray(argumentList.arguments);
    let canonicalArgumentIndices = hasArgumentList;
    if (canonicalArgumentIndices) {
      for (let i = 0; i < argumentList.arguments.length; i += 1) {
        if (!Object.prototype.hasOwnProperty.call(argumentList.arguments, i)
          || !Number.isSafeInteger(argumentList.arguments[i])
          || argumentList.arguments[i] < 0
          || argumentList.arguments[i] > 0xffffffff) {
          canonicalArgumentIndices = false;
          break;
        }
      }
    }
    const arguments_ = canonicalArgumentIndices
      ? argumentList.arguments.map((argument) => describeTypeIndex(argument, types, depth + 1))
      : [];
    const validParameterCount = Number.isSafeInteger(record.parameterCount)
      && record.parameterCount >= 0 && record.parameterCount <= 0xffff;
    // Calling convention/function-option semantics are not rendered yet. Only
    // the canonical near-C/no-options encoding can therefore support an exact
    // textual signature; other encodings remain useful context but fail closed.
    const canonicalProcedureAttributes = record.callingConvention === 0 && record.functionOptions === 0;
    const argumentsComplete = canonicalArgumentIndices
      && validParameterCount
      && argumentList.arguments.length === record.parameterCount
      && arguments_.every((argument) => argument.complete === true);
    const parameters = canonicalArgumentIndices ? arguments_.map((argument) => argument.name).join(', ') : '';
    return {
      name: `${returns.name} (*)(${parameters})`,
      class: 'code',
      complete: returns.complete && argumentsComplete && canonicalProcedureAttributes,
    };
  }
  if (record.kind === 'array') {
    const element = describeTypeIndex(record.elementType, types, depth + 1);
    return { name: `${element.name}[]`, sizeBytes: record.sizeBytes, class: 'array', complete: false };
  }
  return { name: 'unknown', complete: false };
}

function expectedCodeViewIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const guid = value.guid;
  const age = value.age;
  if (typeof guid !== 'string') return null;
  const normalizedGuid = guid.trim().toUpperCase();
  if (!/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/.test(normalizedGuid)) return null;
  if (typeof age !== 'number' || !Number.isSafeInteger(age) || age < 0 || age > 0xffffffff) return null;
  return `${normalizedGuid}/${age}`;
}

export class PdbDebugInfoProvider extends DebugInfoProvider {
  constructor() {
    super({ id: PDB_PROVIDER_ID, version: PDB_PROVIDER_VERSION, ecosystem: 'pdb' });
  }

  /**
   * `image.pdbBytes` is the PDB file; `image.identity.codeView` is the RSDS
   * record from the PE debug directory: `{ guid, age, path }`.
   */
  probe(image, { budget = DEBUG_DEFAULT_BUDGET, signal = null } = {}) {
    const status = (completeness, stopReason) => createAnalysisStatus({
      snapshotId: image?.snapshotId ?? 'snapshot-unbound',
      analyzerId: PDB_PROVIDER_ID,
      analyzerVersion: PDB_PROVIDER_VERSION,
      completeness,
      stopReason,
    });

    if (signal?.aborted) {
      return createDebugProviderResult({
        ecosystem: 'pdb',
        identity: { verdict: 'unsupported', providerId: this.id, providerVersion: this.version, method: 'cancelled' },
        status: status('partial', 'cancelled'),
      });
    }

    const expectedCodeView = image?.identity?.codeView ?? null;
    const pdbBytes = bytesOf(image?.pdbBytes);
    const diagnostics = [];

    if (!pdbBytes) {
      return createDebugProviderResult({
        ecosystem: 'pdb',
        identity: {
          verdict: 'companion-missing',
          providerId: this.id, providerVersion: this.version,
          method: 'codeview-guid-age',
          expected: expectedCodeViewIdentity(expectedCodeView),
          observed: null,
          detail: expectedCodeView?.path
            ? `the binary references a PDB but its bytes were not supplied`
            : 'no PDB was supplied',
        },
        status: status('unsupported', 'dependency-missing'),
      });
    }

    const msf = parseMsf(pdbBytes);
    diagnostics.push(...msf.diagnostics);
    if (!msf.complete || msf.streams.length < 4) {
      return createDebugProviderResult({
        ecosystem: 'pdb',
        identity: {
          verdict: 'unsupported', providerId: this.id, providerVersion: this.version,
          method: 'codeview-guid-age', detail: 'the PDB container could not be read',
        },
        diagnostics,
        status: status('unsupported', 'unsupported-input'),
      });
    }

    const info = parsePdbInfoStream(msf.streams[1].read());
    const observed = info ? `${info.guid}/${info.age}` : null;
    const expected = expectedCodeViewIdentity(expectedCodeView);

    let verdict;
    let detail = null;
    if (expected == null || observed == null) {
      verdict = 'identity-unavailable';
      detail = expected == null
        ? (expectedCodeView == null
          ? 'the binary carries no CodeView debug directory entry'
          : 'the binary CodeView GUID/age is malformed')
        : 'the PDB has no info stream';
    } else if (expected === observed) {
      verdict = 'matched-authoritative';
    } else {
      verdict = 'identity-mismatch';
      detail = 'PDB GUID/age does not match the binary CodeView record';
    }

    const dbiBytes = msf.streams[3]?.read();
    const dbi = parseDbiHeader(dbiBytes);
    const symbolStream = dbi && dbi.symRecordStreamIndex < msf.streams.length
      ? msf.streams[dbi.symRecordStreamIndex].read()
      : null;
    const symbols = parseSymbolRecords(symbolStream, budget);
    // The DBI header is part of the identity/authority boundary: matching
    // CodeView and Info Stream data must not launder symbols from a missing or
    // truncated DBI into authoritative evidence (#6042).
    if (verdict === 'matched-authoritative' && dbi == null) {
      verdict = 'identity-unavailable';
      detail = 'PDB DBI header is missing or truncated';
      symbols.complete = false;
      diagnostics.push(detail);
    } else if (info && dbi && dbi.age !== info.age) {
      // The DBI stream header repeats the PDB Info stream age. An internally
      // inconsistent PDB must not stay authoritative: the DBI picks the
      // symbol/module/section-header streams the readers trust (#6042).
      diagnostics.push(`PDB DBI stream age ${dbi.age} does not match the info stream age ${info.age}`);
      symbols.complete = false;
      if (verdict === 'matched-authoritative') {
        verdict = 'identity-mismatch';
        detail = 'PDB DBI stream age is inconsistent with the info stream age';
      }
    }

    // Procedure symbols live in the per-module streams. Each module stream
    // begins with a 4-byte signature before its symbol records.
    const moduleInfo = parseModuleInfo(dbiBytes, dbi);
    const modules = moduleInfo.modules;
    if (!moduleInfo.complete) {
      symbols.complete = false;
      diagnostics.push('DBI module substream is malformed: the module list is incomplete');
    }
    for (const module of modules) {
      const declaredSize = module.symbolByteSize;
      if (declaredSize < 4) {
        symbols.complete = false;
        continue;
      }
      if (module.streamIndex === 0xffff) {
        // A nil ModuleSymStream is valid for modules with no private symbols;
        // a nonempty declared range is still missing evidence.
        if (declaredSize > 4) symbols.complete = false;
        continue;
      }
      if (module.streamIndex >= msf.streams.length) {
        if (declaredSize > 4) symbols.complete = false;
        continue;
      }
      const moduleBytes = msf.streams[module.streamIndex].read();
      if (!moduleBytes) {
        if (declaredSize > 4) symbols.complete = false;
        continue;
      }
      if (declaredSize > moduleBytes.length) {
        symbols.complete = false;
        continue;
      }
      // The module stream is [4-byte signature][symbols][C11][C13]... with the
      // symbol range exactly [4, SymByteSize): SymByteSize == 4 is the valid
      // boundary meaning zero symbol bytes, not a cue to scan line info as
      // symbol records (#5276).
      const moduleSymbols = parseSymbolRecords(moduleBytes.subarray(4, declaredSize), budget);
      symbols.complete = symbols.complete && moduleSymbols.complete;
      for (const symbol of moduleSymbols.symbols) {
        if (symbol.kind !== 'procedure') continue;
        symbols.symbols.push({ ...symbol, recordOffset: `${module.streamIndex}:${symbol.recordOffset}` });
      }
      for (const kind of moduleSymbols.unmodelled) symbols.unmodelled.add(kind);
    }

    const tpi = parseTpiStream(msf.streams[2]?.read(), budget);
    const sectionHeaders = parseSectionHeaders(findSectionHeaderStream(msf, dbi, dbiBytes));

    if (symbols.unmodelled.size) {
      diagnostics.push(`unmodelled CodeView symbol kinds: ${[...symbols.unmodelled].map((kind) => `0x${kind.toString(16)}`).slice(0, 8).join(', ')}`);
    }
    if (tpi.unmodelled.size) {
      diagnostics.push(`unmodelled TPI leaf kinds: ${[...tpi.unmodelled].map((leaf) => `0x${leaf.toString(16)}`).slice(0, 8).join(', ')}`);
    }
    if (!sectionHeaders.length) diagnostics.push('no section header stream: symbol addresses stay segment-relative');

    const result = createDebugProviderResult({
      ecosystem: 'pdb',
      identity: {
        verdict,
        providerId: this.id,
        providerVersion: this.version,
        expected,
        observed,
        method: 'codeview-guid-age',
        detail,
      },
      sections: ['pdb-info', 'dbi', 'tpi', 'symbol-records'],
      counts: { streams: msf.streams.length, symbols: symbols.symbols.length, types: tpi.types.size, modules: modules.length },
      diagnostics,
      status: symbols.complete && tpi.complete && diagnostics.length === 0
        ? status('complete', null)
        : status('partial', 'evidence-missing'),
    });
    return Object.freeze({ ...result, parsed: { info, dbi, symbols, tpi, sectionHeaders } });
  }

  symbols(result, { cursor = null, pageSize = DEBUG_DEFAULT_PAGE_SIZE } = {}) {
    const parsed = result.parsed;
    if (!parsed) return createDebugPage({ records: [] });
    const headers = parsed.sectionHeaders;
    const ordered = parsed.symbols.symbols;
    return page(ordered, cursor, pageSize, (symbol) => {
      // Segment indices are one-based. Without section headers the address
      // stays segment-relative and the record says so rather than inventing an
      // RVA. With headers, the offset must land inside the section's virtual
      // extent: a CodeView (segment, offset) pair outside it is corrupt, and
      // minting an RVA from it would feed false exact function evidence
      // downstream (#5678).
      const header = headers[symbol.segment - 1] ?? null;
      const extent = sectionVirtualExtent(header);
      // A procedure whose declared size runs past the section extent is
      // corrupt evidence too: the start may be in bounds, but the span it
      // claims is not backed by that section (#5678).
      const inBounds = symbol.offsetInSegment < extent
        && (symbol.sizeBytes == null || symbol.offsetInSegment + symbol.sizeBytes <= extent);
      const address = header && inBounds
        ? `0x${(header.virtualAddress + symbol.offsetInSegment).toString(16)}`
        : null;
      return createDebugRecord({
        kind: 'symbol',
        entityId: `pdb_sym_${symbol.recordOffset}`,
        name: symbol.name,
        address,
        sizeBytes: symbol.sizeBytes,
        descriptor: {
          isFunction: symbol.isFunction === true,
          segment: symbol.segment,
          offsetInSegment: symbol.offsetInSegment,
          complete: address != null,
        },
        providerId: result.providerId,
        providerVersion: result.providerVersion,
        buildIdentity: result.identity.observed,
        evidenceIds: [`pdb:sym:${symbol.recordOffset}`],
      });
    });
  }

  types(result, { cursor = null, pageSize = DEBUG_DEFAULT_PAGE_SIZE } = {}) {
    const parsed = result.parsed;
    if (!parsed) return createDebugPage({ records: [] });
    // Procedures carry the type index that names a function's signature; that
    // is the record the type graph can actually use.
    const typed = parsed.symbols.symbols.filter((symbol) => symbol.kind === 'procedure' && symbol.typeIndex);
    return page(typed, cursor, pageSize, (symbol) => {
      const described = describeTypeIndex(symbol.typeIndex, parsed.tpi.types);
      return createDebugRecord({
        kind: 'type',
        entityId: `pdb_sym_${symbol.recordOffset}`,
        name: symbol.name,
        descriptor: {
          layer: 'nominal',
          claim: { name: described.name, aliases: [] },
          machine: described.widthBits == null ? null : { widthBits: described.widthBits, class: described.class },
          complete: described.complete,
        },
        providerId: result.providerId,
        providerVersion: result.providerVersion,
        buildIdentity: result.identity.observed,
        evidenceIds: [`pdb:type:${symbol.typeIndex}`],
      });
    });
  }

  /** Aggregate layouts, for the structural type layer. */
  aggregates(result) {
    const parsed = result.parsed;
    if (!parsed) return [];
    const out = [];
    for (const [index, record] of parsed.tpi.types) {
      if (record.kind !== 'aggregate' || record.forwardReference || !record.fieldList) continue;
      const fields = parsed.tpi.types.get(record.fieldList);
      if (!fields || fields.kind !== 'field-list' || fields.complete !== true) continue;
      out.push({
        typeIndex: index,
        name: record.name,
        sizeBytes: record.sizeBytes,
        members: fields.members.map((member) => ({
          name: member.name,
          offset: member.offset,
          type: describeTypeIndex(member.typeIndex, parsed.tpi.types),
        })),
      });
    }
    return out;
  }
}

/**
 * The section header stream index lives after the DBI's variable-size
 * substreams, in the optional debug header. Walking there needs the substream
 * sizes, which is why the DBI header is parsed first.
 */
function findSectionHeaderStream(msf, dbi, dbiBytes) {
  if (!dbi || !dbiBytes) return null;
  const view = new DataView(dbiBytes.buffer, dbiBytes.byteOffset, dbiBytes.byteLength);
  const precedingSubstreamSizes = [
    dbi.moduleSubstreamSize,
    dbi.sectionContributionSize,
    dbi.sectionMapSize,
    dbi.sourceInfoSize,
    dbi.typeServerMapSize,
    dbi.ecSubstreamSize,
  ];
  // These fields are signed in the DBI header. Reject malformed sizes before
  // summing them: a negative component could move the optional header into
  // earlier bytes and make unrelated data look like stream-index authority.
  if (precedingSubstreamSizes.some((size) =>
    !Number.isSafeInteger(size) || size < 0)) return null;
  const optionalHeaderOffset = DBI_HEADER_SIZE
    + dbi.moduleSubstreamSize
    + dbi.sectionContributionSize
    + dbi.sectionMapSize
    + dbi.sourceInfoSize
    + dbi.typeServerMapSize
    + dbi.ecSubstreamSize;
  if (!Number.isSafeInteger(optionalHeaderOffset)
    || optionalHeaderOffset < DBI_HEADER_SIZE
    || optionalHeaderOffset > dbiBytes.length) return null;
  const optionalDbgHeaderSize = Number(dbi.optionalDbgHeaderSize);
  if (!Number.isSafeInteger(optionalDbgHeaderSize) || optionalDbgHeaderSize < 0) return null;
  const optionalHeaderEnd = optionalHeaderOffset + optionalDbgHeaderSize;
  if (!Number.isSafeInteger(optionalHeaderEnd)
    || optionalHeaderEnd > dbiBytes.length) return null;
  // The optional debug header is an array of stream indices; index 5 is the
  // original section header stream. Reading it requires the DBI header to
  // actually declare that entry: beyond the declared extent the bytes belong
  // to other substreams and must never mint section mapping authority (#5822).
  if (optionalDbgHeaderSize < (5 + 1) * 2) return null;
  const entryOffset = optionalHeaderOffset + 5 * 2;
  if (entryOffset + 2 > dbiBytes.length) return null;
  const streamIndex = view.getUint16(entryOffset, true);
  if (streamIndex === 0xffff || streamIndex >= msf.streams.length) return null;
  return msf.streams[streamIndex].read();
}

function page(items, cursor, pageSize, map) {
  /* A page size must make progress: pageSize 0 (or any non-positive value)
     would otherwise return the same cursor forever, letting a normal
     nextCursor consumer loop without advancing (#5691). */
  const size = Number.isSafeInteger(pageSize) && pageSize > 0 ? pageSize : DEBUG_DEFAULT_PAGE_SIZE;
  const start = cursor == null ? 0 : Number(cursor);
  const slice = items.slice(start, start + size);
  const next = start + slice.length;
  return createDebugPage({
    records: slice.map(map),
    nextCursor: next < items.length ? String(next) : null,
    truncated: next < items.length,
  });
}
