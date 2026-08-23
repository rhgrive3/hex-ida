import { deepFreeze } from '../../core/identity/index.js';
import { createManagedImageId, createManagedModuleId } from '../shared/identity.js';

function fail(code) { throw new TypeError(code); }

const CLI_DIRECTORY_INDEX = 14;
const CLI_HEADER_SIZE = 72;
const METHOD_DEF_TABLE = 0x06;

function checkedRange(bytes, offset, size, code) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 || offset > bytes.length - size) {
    fail(code);
  }
  return { offset, size, end: offset + size };
}

function readU32(view, offset, code = 'cil-truncated-structure') {
  if (offset < 0 || offset + 4 > view.byteLength) fail(code);
  return view.getUint32(offset, true);
}

function readU16(view, offset, code = 'cil-truncated-structure') {
  if (offset < 0 || offset + 2 > view.byteLength) fail(code);
  return view.getUint16(offset, true);
}

function align4(offset) {
  return (offset + 3) & ~3;
}

function readPeCliLayout(bytes, view) {
  if (bytes.length < 64 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) return null;
  const peOffset = readU32(view, 0x3c, 'cil-truncated-pe-header');
  if (peOffset + 24 > bytes.length || bytes[peOffset] !== 0x50 || bytes[peOffset + 1] !== 0x45 || bytes[peOffset + 2] !== 0 || bytes[peOffset + 3] !== 0) {
    return null;
  }

  const sectionCount = readU16(view, peOffset + 6, 'cil-truncated-pe-coff-header');
  const optionalSize = readU16(view, peOffset + 20, 'cil-truncated-pe-coff-header');
  const optionalOffset = peOffset + 24;
  if (optionalSize < 2 || optionalOffset + optionalSize > bytes.length) return null;
  const optionalEnd = optionalOffset + optionalSize;
  const magic = readU16(view, optionalOffset, 'cil-truncated-pe-optional-header');
  let numberOfRvaAndSizesOffset;
  let dataDirectoryOffset;
  if (magic === 0x10b) {
    numberOfRvaAndSizesOffset = optionalOffset + 92;
    dataDirectoryOffset = optionalOffset + 96;
  } else if (magic === 0x20b) {
    numberOfRvaAndSizesOffset = optionalOffset + 108;
    dataDirectoryOffset = optionalOffset + 112;
  } else {
    return null;
  }
  if (numberOfRvaAndSizesOffset + 4 > optionalEnd) return null;
  const numberOfRvaAndSizes = readU32(view, numberOfRvaAndSizesOffset);
  if (numberOfRvaAndSizes <= CLI_DIRECTORY_INDEX || dataDirectoryOffset + (CLI_DIRECTORY_INDEX + 1) * 8 > optionalEnd) {
    return Object.freeze({ cliPresent: false });
  }

  const sectionTableOffset = optionalEnd;
  const sections = [];
  for (let index = 0; index < sectionCount; index++) {
    const sectionOffset = sectionTableOffset + index * 40;
    checkedRange(bytes, sectionOffset, 40, 'cil-truncated-pe-section-table');
    const virtualSize = readU32(view, sectionOffset + 8);
    const virtualAddress = readU32(view, sectionOffset + 12);
    const rawSize = readU32(view, sectionOffset + 16);
    const rawOffset = readU32(view, sectionOffset + 20);
    if (rawSize > 0) checkedRange(bytes, rawOffset, rawSize, 'cil-pe-section-out-of-bounds');
    sections.push({ virtualSize, virtualAddress, rawSize, rawOffset });
  }

  function mapRva(rva, size = 1, code = 'cil-rva-unmapped') {
    if (!Number.isSafeInteger(rva) || !Number.isSafeInteger(size) || rva < 0 || size < 0) fail(code);
    for (const section of sections) {
      const span = Math.max(section.virtualSize, section.rawSize);
      if (rva < section.virtualAddress || rva >= section.virtualAddress + span) continue;
      const delta = rva - section.virtualAddress;
      if (delta > section.rawSize || size > section.rawSize - delta) fail(code);
      const fileOffset = section.rawOffset + delta;
      checkedRange(bytes, fileOffset, size, code);
      return fileOffset;
    }
    fail(code);
  }

  const cliDirectoryOffset = dataDirectoryOffset + CLI_DIRECTORY_INDEX * 8;
  const cliRva = readU32(view, cliDirectoryOffset, 'cil-truncated-cli-directory');
  const cliSize = readU32(view, cliDirectoryOffset + 4, 'cil-truncated-cli-directory');
  if (cliRva === 0 || cliSize < CLI_HEADER_SIZE) return Object.freeze({ cliPresent: false });
  const cliOffset = mapRva(cliRva, CLI_HEADER_SIZE, 'cil-cli-header-unmapped');
  const metadataRva = readU32(view, cliOffset + 8, 'cil-truncated-cli-header');
  const metadataSize = readU32(view, cliOffset + 12, 'cil-truncated-cli-header');
  if (metadataRva === 0 || metadataSize < 20) fail('cil-cli-metadata-directory-invalid');
  const metadataOffset = mapRva(metadataRva, metadataSize, 'cil-cli-metadata-unmapped');
  return Object.freeze({ cliPresent: true, mapRva, cliOffset, cliSize, metadataOffset, metadataSize });
}

function codedIndexSize(rowCounts, tables, tagBits) {
  const maxRows = Math.max(...tables.map((table) => rowCounts[table] || 0));
  return maxRows < (1 << (16 - tagBits)) ? 2 : 4;
}

function tableIndexSize(rowCounts, table) {
  return (rowCounts[table] || 0) < 0x10000 ? 2 : 4;
}

function metadataRowSize(table, rowCounts, heapSizes) {
  const stringIndexSize = (heapSizes & 0x01) !== 0 ? 4 : 2;
  const guidIndexSize = (heapSizes & 0x02) !== 0 ? 4 : 2;
  const blobIndexSize = (heapSizes & 0x04) !== 0 ? 4 : 2;
  switch (table) {
    case 0x00: // Module
      return 2 + stringIndexSize + guidIndexSize * 3;
    case 0x01: // TypeRef
      return codedIndexSize(rowCounts, [0x00, 0x01, 0x1a, 0x23], 2) + stringIndexSize * 2;
    case 0x02: // TypeDef
      return 4 + stringIndexSize * 2
        + codedIndexSize(rowCounts, [0x01, 0x02, 0x1b], 2)
        + tableIndexSize(rowCounts, 0x04)
        + tableIndexSize(rowCounts, METHOD_DEF_TABLE);
    case 0x03: // FieldPtr
      return tableIndexSize(rowCounts, 0x04);
    case 0x04: // Field
      return 2 + stringIndexSize + blobIndexSize;
    case 0x05: // MethodPtr
      return tableIndexSize(rowCounts, METHOD_DEF_TABLE);
    case METHOD_DEF_TABLE: // MethodDef
      return 4 + 2 + 2 + stringIndexSize + blobIndexSize + tableIndexSize(rowCounts, 0x08);
    default:
      fail(`cil-metadata-table-unsupported:${table}`);
  }
}

function parseMetadataTables(bytes, view, tableStream) {
  if (!tableStream) fail('cil-metadata-tables-missing');
  checkedRange(bytes, tableStream.offset, tableStream.size, 'cil-metadata-tables-out-of-bounds');
  if (tableStream.size < 24) fail('cil-metadata-tables-truncated');
  const start = tableStream.offset;
  const end = start + tableStream.size;
  const heapSizes = bytes[start + 6];
  const validLow = BigInt(readU32(view, start + 8, 'cil-metadata-tables-truncated'));
  const validHigh = BigInt(readU32(view, start + 12, 'cil-metadata-tables-truncated'));
  const valid = validLow | (validHigh << 32n);
  const rowCounts = new Array(64).fill(0);
  let pos = start + 24;
  for (let table = 0; table < 64; table++) {
    if ((valid & (1n << BigInt(table))) === 0n) continue;
    if (pos + 4 > end) fail('cil-metadata-row-counts-truncated');
    rowCounts[table] = readU32(view, pos, 'cil-metadata-row-counts-truncated');
    pos += 4;
  }
  const methodCount = rowCounts[METHOD_DEF_TABLE] || 0;
  if (methodCount === 0) return [];
  if ((valid & (1n << BigInt(METHOD_DEF_TABLE))) === 0n) fail('cil-metadata-method-table-missing');

  const methodRvas = [];
  for (let table = 0; table <= METHOD_DEF_TABLE; table++) {
    const rows = rowCounts[table] || 0;
    if (rows === 0) continue;
    const rowSize = metadataRowSize(table, rowCounts, heapSizes);
    if (!Number.isSafeInteger(rowSize) || rowSize < 1 || rows > Math.floor((end - pos) / rowSize)) {
      fail('cil-metadata-table-data-truncated');
    }
    if (table === METHOD_DEF_TABLE) {
      for (let row = 0; row < rows; row++) {
        methodRvas.push(readU32(view, pos + row * rowSize, 'cil-metadata-method-row-truncated'));
      }
    }
    pos += rows * rowSize;
  }
  return methodRvas;
}

function parseMetadataRoot(bytes, view, metadataOffset, metadataSize) {
  checkedRange(bytes, metadataOffset, metadataSize, 'cil-metadata-root-out-of-bounds');
  const metadataEnd = metadataOffset + metadataSize;
  if (readU32(view, metadataOffset, 'cil-metadata-root-truncated') !== 0x424a5342) fail('cil-metadata-signature-invalid');
  const versionLength = readU32(view, metadataOffset + 12, 'cil-metadata-root-truncated');
  const versionStart = metadataOffset + 16;
  if (versionLength > metadataEnd - versionStart) fail('cil-metadata-version-truncated');
  const versionBytes = bytes.subarray(versionStart, versionStart + versionLength);
  const runtimeVersion = new TextDecoder('utf-8').decode(versionBytes).replace(/\0+$/, '');
  const flagsOffset = align4(versionStart + versionLength);
  if (flagsOffset + 4 > metadataEnd) fail('cil-metadata-stream-header-truncated');
  const streamCount = readU16(view, flagsOffset + 2, 'cil-metadata-stream-header-truncated');
  let streamPos = flagsOffset + 4;
  const streams = [];
  for (let stream = 0; stream < streamCount; stream++) {
    if (streamPos + 8 > metadataEnd) fail('cil-metadata-stream-header-truncated');
    const relativeOffset = readU32(view, streamPos, 'cil-metadata-stream-header-truncated');
    const size = readU32(view, streamPos + 4, 'cil-metadata-stream-header-truncated');
    streamPos += 8;
    const nameStart = streamPos;
    while (streamPos < metadataEnd && bytes[streamPos] !== 0) streamPos++;
    if (streamPos >= metadataEnd) fail('cil-metadata-stream-name-truncated');
    const name = new TextDecoder('ascii').decode(bytes.subarray(nameStart, streamPos));
    streamPos = align4(streamPos + 1);
    if (relativeOffset > metadataSize || size > metadataSize - relativeOffset) fail('cil-metadata-stream-out-of-bounds');
    streams.push({ name, offset: metadataOffset + relativeOffset, size });
  }

  const stringStream = streams.find((stream) => stream.name === '#Strings');
  const tableStream = streams.find((stream) => stream.name === '#~' || stream.name === '#-');
  const strings = [];
  if (stringStream) {
    checkedRange(bytes, stringStream.offset, stringStream.size, 'cil-metadata-strings-out-of-bounds');
    let position = stringStream.offset;
    const end = stringStream.offset + stringStream.size;
    while (position < end) {
      let value = '';
      while (position < end && bytes[position] !== 0) value += String.fromCharCode(bytes[position++]);
      position++;
      if (value) strings.push(value);
    }
  }
  return Object.freeze({ runtimeVersion, strings, methodRvas: parseMetadataTables(bytes, view, tableStream) });
}

function parseMethodBody(bytes, view, offset) {
  checkedRange(bytes, offset, 1, 'cil-method-body-unmapped');
  const headerByte = bytes[offset];
  if ((headerByte & 0x03) === 0x02) {
    const codeSize = headerByte >> 2;
    checkedRange(bytes, offset + 1, codeSize, 'cil-tiny-method-body-truncated');
    return {
      headerOffset: offset,
      isTiny: true,
      maxStack: 8,
      codeSize,
      bytecode: bytes.subarray(offset + 1, offset + 1 + codeSize),
      exceptionClauses: [],
    };
  }

  const flags = readU16(view, offset, 'cil-fat-method-header-truncated');
  if ((flags & 0x03) !== 0x03) fail('cil-invalid-method-header');
  const headerSize = (flags >> 12) * 4;
  if (headerSize < 12 || headerSize % 4 !== 0) fail('cil-invalid-fat-method-header');
  checkedRange(bytes, offset, headerSize, 'cil-fat-method-header-truncated');
  const maxStack = readU16(view, offset + 2, 'cil-fat-method-header-truncated');
  const codeSize = readU32(view, offset + 4, 'cil-fat-method-header-truncated');
  const localVarSigTok = readU32(view, offset + 8, 'cil-fat-method-header-truncated');
  const codeOffset = offset + headerSize;
  checkedRange(bytes, codeOffset, codeSize, 'cil-fat-method-body-truncated');
  const bytecode = bytes.subarray(codeOffset, codeOffset + codeSize);
  const exceptionClauses = [];

  if ((flags & 0x08) !== 0) {
    const extraOffset = align4(codeOffset + codeSize);
    checkedRange(bytes, extraOffset, 4, 'cil-method-extra-section-truncated');
    const kind = bytes[extraOffset];
    const dataSize = bytes[extraOffset + 1]
      | (bytes[extraOffset + 2] << 8)
      | (bytes[extraOffset + 3] << 16);
    if (dataSize < 4) fail('cil-invalid-method-extra-section');
    checkedRange(bytes, extraOffset, dataSize, 'cil-method-extra-section-truncated');
    if ((kind & 0x01) !== 0) {
      const clauseSize = (kind & 0x40) !== 0 ? 24 : 12;
      if ((dataSize - 4) % clauseSize !== 0) fail('cil-invalid-method-clause-size');
      const clauseCount = (dataSize - 4) / clauseSize;
      for (let clause = 0; clause < clauseCount; clause++) {
        const clauseOffset = extraOffset + 4 + clause * clauseSize;
        if (clauseSize === 24) {
          const clauseFlags = readU32(view, clauseOffset, 'cil-fat-method-clause-truncated');
          exceptionClauses.push({
            kind: clauseFlags === 1 ? 'filter' : clauseFlags === 2 ? 'finally' : clauseFlags === 4 ? 'fault' : 'catch',
            tryOffset: readU32(view, clauseOffset + 4, 'cil-fat-method-clause-truncated'),
            tryLength: readU32(view, clauseOffset + 8, 'cil-fat-method-clause-truncated'),
            handlerOffset: readU32(view, clauseOffset + 12, 'cil-fat-method-clause-truncated'),
            handlerLength: readU32(view, clauseOffset + 16, 'cil-fat-method-clause-truncated'),
            classTokenOrFilter: readU32(view, clauseOffset + 20, 'cil-fat-method-clause-truncated'),
          });
        } else {
          const clauseFlags = readU16(view, clauseOffset, 'cil-small-method-clause-truncated');
          exceptionClauses.push({
            kind: clauseFlags === 1 ? 'filter' : clauseFlags === 2 ? 'finally' : clauseFlags === 4 ? 'fault' : 'catch',
            tryOffset: readU16(view, clauseOffset + 2, 'cil-small-method-clause-truncated'),
            tryLength: bytes[clauseOffset + 4],
            handlerOffset: readU16(view, clauseOffset + 5, 'cil-small-method-clause-truncated'),
            handlerLength: bytes[clauseOffset + 7],
            classTokenOrFilter: readU32(view, clauseOffset + 8, 'cil-small-method-clause-truncated'),
          });
        }
      }
    }
  }

  return {
    headerOffset: offset,
    isTiny: false,
    maxStack,
    codeSize,
    localVarSigTok,
    bytecode,
    exceptionClauses,
  };
}

export function probeCil(bytes) {
  if (!bytes || bytes.length < 64) return { supported: false, confidence: 0, reason: 'too-small' };
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  
  // Direct metadata signature check: 'BSJB' (0x42534a42)
  for (let i = 0; i <= u8.length - 4; i += 4) {
    if (u8[i] === 0x42 && u8[i + 1] === 0x53 && u8[i + 2] === 0x4a && u8[i + 3] === 0x42) {
      return { supported: true, confidence: 1.0, formatVersion: 'cli-ecma-335', vmSpecEdition: 'clr-v4' };
    }
  }

  // DOS header 'MZ'
  if (u8[0] === 0x4d && u8[1] === 0x5a) {
    const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const peOff = view.getUint32(0x3c, true);
    if (peOff + 4 <= u8.length && u8[peOff] === 0x50 && u8[peOff + 1] === 0x45) {
      return { supported: true, confidence: 0.9, formatVersion: 'pe-cli', vmSpecEdition: 'clr-v4' };
    }
  }

  return { supported: false, confidence: 0, reason: 'invalid-signature' };
}

export function readCompressedInt(bytes, offset) {
  if (offset >= bytes.length) fail('cil-truncated-compressed-int');
  const b0 = bytes[offset];
  if ((b0 & 0x80) === 0) {
    return { value: b0, nextOffset: offset + 1 };
  } else if ((b0 & 0xc0) === 0x80) {
    if (offset + 1 >= bytes.length) fail('cil-truncated-compressed-int');
    return { value: ((b0 & 0x3f) << 8) | bytes[offset + 1], nextOffset: offset + 2 };
  } else if ((b0 & 0xe0) === 0xc0) {
    if (offset + 3 >= bytes.length) fail('cil-truncated-compressed-int');
    return {
      value: ((b0 & 0x1f) << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3],
      nextOffset: offset + 4,
    };
  }
  fail('cil-invalid-compressed-int');
}

export function parseCil(bytes, options = {}) {
  const probe = probeCil(bytes);
  if (!probe.supported) fail('cil-unsupported-binary');

  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

  const types = [];
  const methods = [];
  const fields = [];
  let strings = [];
  let runtimeVersion = 'v4.0.30319';

  // Real PE/CLI images must resolve the metadata through the optional-header
  // CLI data directory.  The synthetic Phase 11 fixture predates this path,
  // so retain its direct BSJB compatibility path below without using it for
  // structurally valid assemblies.
  const peCli = readPeCliLayout(u8, view);
  if (peCli?.cliPresent === false) fail('cil-cli-directory-missing');
  let bsjbOffset = peCli?.metadataOffset ?? -1;
  let metadataInfo = null;
  if (peCli?.cliPresent) {
    metadataInfo = parseMetadataRoot(u8, view, peCli.metadataOffset, peCli.metadataSize);
    strings = [...metadataInfo.strings];
    runtimeVersion = metadataInfo.runtimeVersion || runtimeVersion;
  } else {
    for (let i = 0; i <= u8.length - 4; i += 4) {
      if (u8[i] === 0x42 && u8[i + 1] === 0x53 && u8[i + 2] === 0x4a && u8[i + 3] === 0x42) {
        bsjbOffset = i;
        break;
      }
    }
  }

  if (!metadataInfo && bsjbOffset >= 0 && bsjbOffset + 20 <= u8.length) {
    const vLen = view.getUint32(bsjbOffset + 12, true);
    if (bsjbOffset + 16 + vLen <= u8.length) {
      const vBytes = u8.subarray(bsjbOffset + 16, bsjbOffset + 16 + vLen);
      runtimeVersion = new TextDecoder('utf-8').decode(vBytes).replace(/\0+$/, '');
    }

    const flagsOff = bsjbOffset + 16 + vLen;
    if (flagsOff + 4 <= u8.length) {
      const streamCount = view.getUint16(flagsOff + 2, true);
      let sPos = flagsOff + 4;
      const streams = [];
      for (let s = 0; s < streamCount; s++) {
        if (sPos + 8 > u8.length) break;
        const sOffset = view.getUint32(sPos, true);
        const sSize = view.getUint32(sPos + 4, true);
        sPos += 8;
        let sName = '';
        while (sPos < u8.length && u8[sPos] !== 0) {
          sName += String.fromCharCode(u8[sPos++]);
        }
        sPos = (sPos + 4) & ~3; // 4-byte align
        streams.push({ name: sName, offset: bsjbOffset + sOffset, size: sSize });
      }

      const stringStream = streams.find((st) => st.name === '#Strings');
      if (stringStream && stringStream.offset + stringStream.size <= u8.length) {
        let p = stringStream.offset;
        const end = stringStream.offset + stringStream.size;
        while (p < end) {
          let str = '';
          while (p < end && u8[p] !== 0) {
            str += String.fromCharCode(u8[p++]);
          }
          p++; // skip null
          if (str) strings.push(str);
        }
      }
    }
  }

  const methodBodies = [];
  if (metadataInfo && peCli?.cliPresent) {
    const seenOffsets = new Set();
    for (const methodRva of metadataInfo.methodRvas) {
      if (methodRva === 0) continue; // abstract or P/Invoke method
      const methodOffset = peCli.mapRva(methodRva, 1, 'cil-method-rva-unmapped');
      if (seenOffsets.has(methodOffset)) continue;
      seenOffsets.add(methodOffset);
      methodBodies.push(parseMethodBody(u8, view, methodOffset));
    }
  } else {
    // Compatibility for the deliberately minimal Phase 11 fixture, which has
    // a BSJB marker but no PE optional header or CLI metadata tables.  This is
    // never used for a structurally valid PE/CLI image.
    const startScan = bsjbOffset >= 0 ? bsjbOffset + 0x60 : 0x100;
    for (let offset = startScan; offset < u8.length; offset++) {
      const headerByte = u8[offset];
      if ((headerByte & 0x03) !== 0x02 && (headerByte & 0x0f) !== 0x03) continue;
      try {
        const body = parseMethodBody(u8, view, offset);
        if (!body.bytecode.some((byte) => byte === 0x2a)) continue;
        methodBodies.push(body);
        offset += body.isTiny ? body.codeSize : body.codeSize + 12;
      } catch {
        // The compatibility fixture is intentionally sparse; ignore bytes
        // that do not form a complete legacy method body.
      }
    }
  }

  const binaryId = options.binaryId || 'cil-binary';
  const imageId = createManagedImageId(binaryId);
  const moduleId = createManagedModuleId(imageId, 'Assembly.dll');

  return deepFreeze({
    imageId,
    moduleId,
    formatVersion: 'cli-ecma-335',
    vmSpecEdition: runtimeVersion,
    types,
    methods,
    fields,
    strings,
    methodBodies,
    rawBytes: u8,
  });
}
