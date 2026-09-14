/**
 * HEX-C3-03 — Go Runtime Metadata Provider.
 *
 * Implements toolchain-aware Go runtime metadata extraction from `.gopclntab`,
 * build-version discovery, and bounded type-descriptor decoding. Runtime type
 * enumeration through moduledata/typelinks is not implemented yet.
 *
 * Supported Go pclntab formats:
 * - Go 1.2  (magic: 0xfffffffb)
 * - Go 1.16 (magic: 0xfffffffa)
 * - Go 1.18 (magic: 0xfffffff0)
 * - Go 1.20+ (magic: 0xfffffff1)
 *
 * Strict fail-closed rules:
 * - Unrecognized pclntab magic -> explicit `unsupported` verdict; never guess layout.
 * - Truncated, cyclic, or out-of-bounds tables -> explicit `malformed` / `partial` completeness.
 * - Stripped binaries with no pclntab -> `present: false`, `identity-unavailable`, zero fabricated types.
 */

import {
  LanguageMetadataProvider,
  createLanguageMetadataIdentity,
  createLanguageMetadataRecord,
  createLanguageMetadataPage,
  createLanguageMetadataResult,
  METADATA_DEFAULT_BUDGET,
} from './provider.js';

export const GO_PROVIDER_ID = 'metadata.go';
export const GO_PROVIDER_VERSION = '1.0.0';

// Go function metadata is variable-width output. Keep the common byte
// budget authoritative and add bounded retained-output/object accounting so
// a record cap cannot turn into an unbounded resident-memory allocation.
const DEFAULT_GO_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const DEFAULT_GO_MAX_ESTIMATED_HEAP_BYTES = 16 * 1024 * 1024;
const DEFAULT_GO_ESTIMATED_RECORD_BYTES = 1024;

export const GO_PCLNTAB_MAGICS = Object.freeze({
  0xfffffffb: { version: '1.2', name: 'go1.2' },
  0xfffffffa: { version: '1.16', name: 'go1.16' },
  0xfffffff0: { version: '1.18', name: 'go1.18' },
  0xfffffff1: { version: '1.20+', name: 'go1.20+' },
});

export const GO_TYPE_KINDS = Object.freeze({
  1: 'bool',
  2: 'int',
  3: 'int8',
  4: 'int16',
  5: 'int32',
  6: 'int64',
  7: 'uint',
  8: 'uint8',
  9: 'uint16',
  10: 'uint32',
  11: 'uint64',
  12: 'uintptr',
  13: 'float32',
  14: 'float64',
  15: 'complex64',
  16: 'complex128',
  17: 'array',
  18: 'chan',
  19: 'func',
  20: 'interface',
  21: 'map',
  22: 'pointer',
  23: 'slice',
  24: 'string',
  25: 'struct',
  26: 'unsafePointer',
});

function u8(buf, off) {
  if (off < 0 || off >= buf.length) return null;
  return buf[off];
}

function u16(buf, off, little = true) {
  if (off < 0 || off + 2 > buf.length) return null;
  return little ? (buf[off] | (buf[off + 1] << 8)) : ((buf[off] << 8) | buf[off + 1]);
}

function u32(buf, off, little = true) {
  if (off < 0 || off + 4 > buf.length) return null;
  const val = little
    ? (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24))
    : ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]);
  return val >>> 0;
}

function i32(buf, off, little = true) {
  const val = u32(buf, off, little);
  return val == null ? null : (val | 0);
}

function u64(buf, off, little = true) {
  if (off < 0 || off + 8 > buf.length) return null;
  let val = 0n;
  if (little) {
    for (let i = 7; i >= 0; i--) val = (val << 8n) | BigInt(buf[off + i]);
  } else {
    for (let i = 0; i < 8; i++) val = (val << 8n) | BigInt(buf[off + i]);
  }
  return val;
}

function readPtr(buf, off, ptrSize, little = true) {
  return ptrSize === 4 ? BigInt(u32(buf, off, little) ?? 0) : (u64(buf, off, little) ?? 0n);
}

function decodeCString(buf, off, end) {
  if (off < 0 || end <= off || end > buf.length) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(off, end));
  } catch {
    return null;
  }
}

function goBudgetOption(options, names, fallback, code) {
  let value = fallback;
  for (const name of names) {
    if (options[name] != null) {
      value = options[name];
      break;
    }
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(code);
  }
  return value;
}

/**
 * Decodes Go varint / uvarint used in string length and offsets.
 */
function readUvarint(buf, off) {
  let value = 0;
  let shift = 0;
  let pos = off;
  while (pos < buf.length && shift < 35) {
    const b = buf[pos++];
    // The decoder is capped at 35 bits, which is safely below Number's 53-bit
    // integer precision. Arithmetic accumulation preserves bits 32..34; JS
    // bitwise operators would truncate them to a signed 32-bit value (#5373).
    value += (b & 0x7f) * (2 ** shift);
    if ((b & 0x80) === 0) return { value, bytesRead: pos - off };
    shift += 7;
  }
  return null;
}

function isValidSectionOffset(value, length) {
  return Number.isSafeInteger(value) && value >= 0 && value < length;
}

/**
 * Searches a byte buffer for Go build info (go1.x.y version).
 */
export function findGoBuildVersion(buffer) {
  if (!buffer || buffer.length < 16) return null;
  // Look for `\xff Go buildinf:` magic or `go1.` string pattern
  const text = new TextDecoder('utf-8', { fatal: false }).decode(buffer.subarray(0, Math.min(buffer.length, 1024 * 1024)));
  const match = text.match(/\bgo(1\.\d+(?:\.\d+)?(?:[a-zA-Z0-9_.-]+)?)\b/);
  return match ? match[1] : null;
}

/**
 * Parses the pclntab header and returns layout information.
 */
export function parsePclntabHeader(buf) {
  if (!buf || buf.length < 16) return { valid: false, reason: 'buffer-too-small' };

  let little = true;
  let magic = u32(buf, 0, true);
  if (!GO_PCLNTAB_MAGICS[magic]) {
    magic = u32(buf, 0, false);
    little = false;
  }

  if (!GO_PCLNTAB_MAGICS[magic]) {
    return { valid: false, reason: 'unrecognized-magic', magic: u32(buf, 0, true) };
  }

  const magicInfo = GO_PCLNTAB_MAGICS[magic];
  const minLC = u8(buf, 6);
  const ptrSize = u8(buf, 7);

  if (buf[4] !== 0 || buf[5] !== 0) {
    return { valid: false, reason: 'invalid-header-padding' };
  }

  if (minLC !== 1 && minLC !== 2 && minLC !== 4) {
    return { valid: false, reason: 'invalid-pc-quantum', minLC };
  }

  if (ptrSize !== 4 && ptrSize !== 8) {
    return { valid: false, reason: 'invalid-pointer-size', ptrSize };
  }

  const requiredHeaderSize = magicInfo.version === '1.2'
    ? 8 + ptrSize
    : magicInfo.version === '1.16'
      ? 8 + 7 * ptrSize
      : 8 + 8 * ptrSize;
  if (buf.length < requiredHeaderSize) {
    return { valid: false, reason: 'buffer-too-small' };
  }

  let nfunc = 0;
  let nfiles = 0;
  let textStart = 0n;
  let funcnametabOff = 0;
  let cutabOff = 0;
  let filetabOff = 0;
  let pctabOff = 0;
  let pclnOff = 0;
  let ftabOff = 0;

  if (magicInfo.version === '1.2') {
    nfunc = Number(readPtr(buf, 8, ptrSize, little));
    ftabOff = 8 + ptrSize;
  } else if (magicInfo.version === '1.16') {
    nfunc = Number(readPtr(buf, 8, ptrSize, little));
    nfiles = Number(readPtr(buf, 8 + ptrSize, ptrSize, little));
    funcnametabOff = Number(readPtr(buf, 8 + 2 * ptrSize, ptrSize, little));
    cutabOff = Number(readPtr(buf, 8 + 3 * ptrSize, ptrSize, little));
    filetabOff = Number(readPtr(buf, 8 + 4 * ptrSize, ptrSize, little));
    pctabOff = Number(readPtr(buf, 8 + 5 * ptrSize, ptrSize, little));
    pclnOff = Number(readPtr(buf, 8 + 6 * ptrSize, ptrSize, little));
  } else {
    // 1.18 and 1.20+
    nfunc = Number(readPtr(buf, 8, ptrSize, little));
    nfiles = Number(readPtr(buf, 8 + ptrSize, ptrSize, little));
    textStart = readPtr(buf, 8 + 2 * ptrSize, ptrSize, little);
    funcnametabOff = Number(readPtr(buf, 8 + 3 * ptrSize, ptrSize, little));
    cutabOff = Number(readPtr(buf, 8 + 4 * ptrSize, ptrSize, little));
    filetabOff = Number(readPtr(buf, 8 + 5 * ptrSize, ptrSize, little));
    pctabOff = Number(readPtr(buf, 8 + 6 * ptrSize, ptrSize, little));
    pclnOff = Number(readPtr(buf, 8 + 7 * ptrSize, ptrSize, little));
  }

  if (magicInfo.version !== '1.2') {
    const tableOffsets = { funcnametabOff, cutabOff, filetabOff, pctabOff, pclnOff };
    for (const [offsetName, offset] of Object.entries(tableOffsets)) {
      if (!isValidSectionOffset(offset, buf.length)) {
        return { valid: false, reason: 'invalid-table-offset', offsetName, offset };
      }
    }
    ftabOff = pclnOff;
  }

  return {
    valid: true,
    magic,
    version: magicInfo.version,
    versionName: magicInfo.name,
    little,
    minLC,
    ptrSize,
    nfunc,
    nfiles,
    textStart,
    funcnametabOff,
    cutabOff,
    filetabOff,
    pctabOff,
    pclnOff,
    ftabOff,
  };
}

/**
 * Parses Go pclntab function entries with bounds checking.
 */
export function parseGoFunctions(buf, header, options = {}) {
  // Keep the historical 50,000 default while honoring the common provider
  // maximum when it is tightened centrally.
  const maxRecords = options.maxRecords ?? Math.min(50000, METADATA_DEFAULT_BUDGET.maxRecords);
  if (typeof maxRecords !== 'number' || !Number.isSafeInteger(maxRecords) || maxRecords < 0) {
    throw new TypeError('go-metadata-invalid-max-records');
  }

  const maxBytesScanned = goBudgetOption(
    options,
    ['maxBytesScanned', 'maxScanBytes'],
    METADATA_DEFAULT_BUDGET.maxBytesScanned,
    'go-metadata-invalid-max-bytes-scanned',
  );
  const maxOutputBytes = goBudgetOption(
    options,
    ['maxOutputBytes', 'maxDecodedNameBytes', 'maxRetainedStringBytes'],
    DEFAULT_GO_MAX_OUTPUT_BYTES,
    'go-metadata-invalid-max-output-bytes',
  );
  const maxEstimatedHeapBytes = goBudgetOption(
    options,
    ['maxEstimatedHeapBytes', 'maxHeapBytes', 'maxRetainedBytes'],
    DEFAULT_GO_MAX_ESTIMATED_HEAP_BYTES,
    'go-metadata-invalid-max-estimated-heap-bytes',
  );
  const estimatedRecordBytes = goBudgetOption(
    options,
    ['estimatedRecordBytes', 'recordOverheadBytes'],
    DEFAULT_GO_ESTIMATED_RECORD_BYTES,
    'go-metadata-invalid-record-overhead-bytes',
  );

  const maxFuncs = Math.min(header.nfunc, maxRecords);
  const functions = [];
  let unreadableEntries = 0;
  let invalidEntries = 0;

  const ftabOff = header.ftabOff;
  const funcDataBase = header.version === '1.2' ? 0 : header.pclnOff;
  const is118Plus = header.version === '1.18' || header.version === '1.20+';
  const entrySize = is118Plus ? 8 : header.ptrSize * 2;
  const descriptorBytes = is118Plus
    ? 12
    : header.version === '1.16'
      ? header.ptrSize + 8
      : header.ptrSize + 12;

  const budget = {
    maxRecords,
    maxBytesScanned,
    maxOutputBytes,
    maxEstimatedHeapBytes,
    estimatedRecordBytes,
    bytesScanned: 0,
    outputBytes: 0,
    estimatedHeapBytes: 0,
    uniqueNames: 0,
    nameCacheEntries: 0,
    nameCacheHits: 0,
    nameDecodes: 0,
    invalidNameCacheEntries: 0,
    exhausted: false,
    exhaustedReason: null,
  };

  const exhaust = (reason) => {
    if (!budget.exhausted) {
      budget.exhausted = true;
      budget.exhaustedReason = reason;
    }
    return false;
  };
  const takeBytes = (count) => {
    if (count === 0) return true;
    if (!Number.isSafeInteger(count) || count < 0
        || count > budget.maxBytesScanned - budget.bytesScanned) {
      budget.bytesScanned = budget.maxBytesScanned;
      return exhaust('go-metadata-byte-budget-exhausted');
    }
    budget.bytesScanned += count;
    return true;
  };

  // Number of declared entries whose slot was actually examined. Iterations
  // after an early break were never attempted and must not be counted (#5861).
  let scanned = 0;
  const nameCache = new Map();

  const resolveName = (namePos) => {
    if (nameCache.has(namePos)) {
      budget.nameCacheHits++;
      return nameCache.get(namePos);
    }
    if (!Number.isSafeInteger(namePos) || namePos < 0 || namePos >= buf.length) {
      const invalid = { name: null, payloadBytes: 0, retained: false };
      nameCache.set(namePos, invalid);
      budget.nameCacheEntries++;
      budget.invalidNameCacheEntries++;
      return invalid;
    }

    const limit = Math.min(buf.length, namePos + 1024);
    let end = namePos;
    while (end < limit) {
      if (!takeBytes(1)) return { budgetExhausted: true };
      const byte = buf[end];
      if (byte === 0) {
        if (end === namePos) {
          const invalid = { name: null, payloadBytes: 0, retained: false };
          nameCache.set(namePos, invalid);
          budget.nameCacheEntries++;
          budget.invalidNameCacheEntries++;
          return invalid;
        }
        const name = decodeCString(buf, namePos, end);
        if (!name) {
          const invalid = { name: null, payloadBytes: end - namePos, retained: false };
          nameCache.set(namePos, invalid);
          budget.nameCacheEntries++;
          budget.invalidNameCacheEntries++;
          return invalid;
        }
        const resolved = { name, payloadBytes: end - namePos, retained: false };
        nameCache.set(namePos, resolved);
        budget.nameCacheEntries++;
        budget.nameDecodes++;
        return resolved;
      }
      if (byte < 0x20 || byte === 0x7f) {
        const invalid = { name: null, payloadBytes: end - namePos + 1, retained: false };
        nameCache.set(namePos, invalid);
        budget.nameCacheEntries++;
        budget.invalidNameCacheEntries++;
        return invalid;
      }
      end++;
    }
    const invalid = { name: null, payloadBytes: end - namePos, retained: false };
    nameCache.set(namePos, invalid);
    budget.nameCacheEntries++;
    budget.invalidNameCacheEntries++;
    return invalid;
  };

  for (let i = 0; i < maxFuncs; i++) {
    scanned++;
    const slot = ftabOff + i * entrySize;
    if (slot + entrySize > buf.length) {
      unreadableEntries++;
      break;
    }
    if (!takeBytes(entrySize)) break;

    let entryPC = 0n;
    let funcOff = 0;

    if (is118Plus) {
      const entryOff = u32(buf, slot, header.little);
      funcOff = u32(buf, slot + 4, header.little);
      if (entryOff == null || funcOff == null) { invalidEntries++; continue; }
      entryPC = header.textStart + BigInt(entryOff);
    } else {
      entryPC = readPtr(buf, slot, header.ptrSize, header.little);
      funcOff = Number(readPtr(buf, slot + header.ptrSize, header.ptrSize, header.little));
    }

    const funcPos = funcDataBase + funcOff;
    if (!Number.isSafeInteger(funcOff) || funcOff < 0 || !Number.isSafeInteger(funcPos) || funcPos >= buf.length) {
      invalidEntries++;
      continue;
    }
    const readableDescriptorBytes = Math.min(descriptorBytes, buf.length - funcPos);
    if (!takeBytes(readableDescriptorBytes)) break;
    if (readableDescriptorBytes < descriptorBytes) {
      invalidEntries++;
      continue;
    }

    // Read function descriptor _func.
    let name = null;
    let frameSize = null;
    let argsSize = null;
    let namePosition = null;

    if (is118Plus) {
      const nameOff = i32(buf, funcPos + 4, header.little);
      argsSize = i32(buf, funcPos + 8, header.little);
      if (nameOff != null) namePosition = header.funcnametabOff + nameOff;
    } else if (header.version === '1.16') {
      const nameOff = i32(buf, funcPos + header.ptrSize, header.little);
      argsSize = i32(buf, funcPos + header.ptrSize + 4, header.little);
      if (nameOff != null) namePosition = header.funcnametabOff + nameOff;
    } else {
      // 1.2
      const nameOff = i32(buf, funcPos + header.ptrSize, header.little);
      argsSize = i32(buf, funcPos + header.ptrSize + 4, header.little);
      frameSize = i32(buf, funcPos + header.ptrSize + 8, header.little);
      if (nameOff != null) namePosition = nameOff;
    }

    if (namePosition != null) {
      const resolved = resolveName(namePosition);
      if (resolved.budgetExhausted) break;
      name = resolved.name;
      if (name) {
        // Charge the decoded string once per validated offset and charge
        // every retained function record, including cache hits.
        const uniqueStringBytes = resolved.retained
          ? 0
          : resolved.payloadBytes + name.length * 2 + 16;
        if (uniqueStringBytes > budget.maxOutputBytes - budget.outputBytes) {
          exhaust('go-metadata-output-budget-exhausted');
          break;
        }
        const nextHeapBytes = budget.estimatedHeapBytes + estimatedRecordBytes + uniqueStringBytes;
        if (nextHeapBytes > budget.maxEstimatedHeapBytes) {
          exhaust('go-metadata-estimated-heap-budget-exhausted');
          break;
        }
        if (!resolved.retained) {
          resolved.retained = true;
          budget.uniqueNames++;
          budget.outputBytes += uniqueStringBytes;
        }
        budget.estimatedHeapBytes = nextHeapBytes;
      }
    }

    if (!name) {
      invalidEntries++;
      continue;
    }

    functions.push({
      index: i,
      name,
      address: `0x${entryPC.toString(16)}`,
      entryPC,
      argsSize,
      frameSize,
      funcOff,
    });
  }

  const capped = header.nfunc > maxFuncs || budget.exhausted;
  const complete = !capped && unreadableEntries === 0 && invalidEntries === 0 && functions.length === header.nfunc;
  // Keep the public completeness contract stable across the byte, output, and
  // heap sub-budgets. The detailed sub-budget remains available for callers
  // that need diagnostics without making the reason string part of the
  // provider's allocation strategy.
  const reasons = budget.exhausted ? ['go-metadata-budget-exhausted'] : [];

  return {
    functions,
    budget: {
      ...budget,
      nameCacheEntries: nameCache.size,
    },
    resourceAccounting: {
      maxBytesScanned: budget.maxBytesScanned,
      maxOutputBytes: budget.maxOutputBytes,
      maxEstimatedHeapBytes: budget.maxEstimatedHeapBytes,
      bytesScanned: budget.bytesScanned,
      outputBytes: budget.outputBytes,
      estimatedHeapBytes: budget.estimatedHeapBytes,
      nameCacheMisses: nameCache.size,
      nameCacheHits: budget.nameCacheHits,
      nameDecodes: budget.nameDecodes,
      uniqueNames: budget.uniqueNames,
      invalidNameCacheEntries: budget.invalidNameCacheEntries,
      exhausted: budget.exhausted,
      exhaustedReason: budget.exhaustedReason,
    },
    completeness: {
      present: true,
      declared: header.nfunc,
      scanned,
      parsed: functions.length,
      capped,
      unreadableEntries,
      invalidEntries,
      complete,
      reasons,
      bytesScanned: budget.bytesScanned,
      uniqueNames: budget.uniqueNames,
      nameCacheEntries: nameCache.size,
    },
  };
}
const GO_TYPE_LAYOUT_CURRENT = Object.freeze({
  strNameOffset: (ptrSize) => ptrSize * 4 + 8,
  headerBytes: (ptrSize) => ptrSize * 4 + 16,
});

// `internal/abi.Type` is not a format that can be selected from pointer width
// alone. Bind the decoder to the concrete Go toolchain range that this layout
// has been validated against. Pclntab generations such as "1.20+" are not
// sufficient authority because they intentionally span future toolchains.
const GO_TYPE_LAYOUT_MIN_MINOR = 16;
const GO_TYPE_LAYOUT_MAX_MINOR = 23;

function resolveGoTypeLayout(version) {
  if (typeof version !== 'string') return null;
  const match = /^1\.(\d+)(?:\.(\d+))?$/.exec(version);
  if (!match) return null;
  const minor = Number(match[1]);
  const patch = match[2] == null ? 0 : Number(match[2]);
  if (!Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) return null;
  if (minor < GO_TYPE_LAYOUT_MIN_MINOR || minor > GO_TYPE_LAYOUT_MAX_MINOR) return null;
  return GO_TYPE_LAYOUT_CURRENT;
}

/**
 * Parses Go type descriptor (_type) at a given buffer offset.
 */
export function parseGoTypeDescriptor(buf, typeOff, options = {}) {
  const ptrSize = options.ptrSize ?? 8;
  const little = options.little ?? true;
  const layout = resolveGoTypeLayout(options.version);

  if (!layout || (ptrSize !== 4 && ptrSize !== 8)) return null;
  if (!Number.isSafeInteger(typeOff) || typeOff < 0 || typeOff > buf.length - layout.headerBytes(ptrSize)) return null;

  const size = Number(readPtr(buf, typeOff, ptrSize, little));
  const ptrdata = Number(readPtr(buf, typeOff + ptrSize, ptrSize, little));
  const hash = u32(buf, typeOff + ptrSize * 2, little);
  const tflag = u8(buf, typeOff + ptrSize * 2 + 4);
  const align = u8(buf, typeOff + ptrSize * 2 + 5);
  const fieldAlign = u8(buf, typeOff + ptrSize * 2 + 6);
  const rawKind = u8(buf, typeOff + ptrSize * 2 + 7);

  if (rawKind == null) return null;
  const kindId = rawKind & 0x1f;
  const kind = GO_TYPE_KINDS[kindId] || 'unknown';

  const nameOff = i32(buf, typeOff + layout.strNameOffset(ptrSize), little);
  let name = null;
  if (Number.isSafeInteger(options.typesBase) && nameOff != null) {
    const strPos = options.typesBase + nameOff;
    if (Number.isSafeInteger(strPos) && strPos >= 0 && strPos <= buf.length - 2) {
      // Go name structure has 1 byte header flag followed by length varint
      const lenInfo = readUvarint(buf, strPos + 1);
      if (lenInfo && strPos + 1 + lenInfo.bytesRead + lenInfo.value <= buf.length) {
        try {
          name = new TextDecoder('utf-8', { fatal: true }).decode(
            buf.subarray(strPos + 1 + lenInfo.bytesRead, strPos + 1 + lenInfo.bytesRead + lenInfo.value)
          );
        } catch {
          name = null;
        }
      }
    }
  }

  return {
    kind,
    kindId,
    size,
    ptrdata,
    hash,
    tflag,
    align,
    fieldAlign,
    name: name || `go_type_${kind}_${typeOff.toString(16)}`,
    address: `0x${(BigInt(options.baseAddress ?? 0) + BigInt(typeOff)).toString(16)}`,
  };
}

/**
 * Go Language Metadata Provider implementation.
 */
export class GoMetadataProvider extends LanguageMetadataProvider {
  constructor({
    pclntabBuffer = null,
    rodataBuffer = null,
    sections = [],
    binaryIdentity = null,
    architecture = 'x86_64',
    platform = 'linux',
    baseAddress = 0n,
    options = {},
  } = {}) {
    super({ id: GO_PROVIDER_ID, version: GO_PROVIDER_VERSION, ecosystem: 'go' });
    this.pclntabBuffer = pclntabBuffer;
    this.rodataBuffer = rodataBuffer;
    this.sections = sections;
    this.binaryIdentity = binaryIdentity;
    this.architecture = architecture;
    this.platform = platform;
    this.baseAddress = BigInt(baseAddress);
    this.options = options;
    this.cachedHeader = null;
    this.cachedFunctions = null;
  }

  probe() {
    if (!this.pclntabBuffer || this.pclntabBuffer.length === 0) {
      // A section-table hit is metadata evidence even when its bytes were not
      // supplied for scanning. Keep that state distinct from a stripped
      // binary with no pclntab section (#5877).
      const hasPclntabSection = this.sections.some((section) => {
        const name = typeof section === 'string'
          ? section
          : (section?.name ?? section?.section ?? section?.sectname ?? '');
        return typeof name === 'string' && name.includes('gopclntab');
      });
      return createLanguageMetadataResult({
        providerId: this.id,
        providerVersion: this.version,
        ecosystem: 'go',
        identity: createLanguageMetadataIdentity({
          verdict: 'identity-unavailable',
          providerId: this.id,
          providerVersion: this.version,
          ecosystem: 'go',
          binaryIdentity: this.binaryIdentity,
          architecture: this.architecture,
          platform: this.platform,
          method: 'pclntab-probe',
          detail: hasPclntabSection
            ? 'pclntab section detected but its bytes were not supplied'
            : 'no pclntab section or buffer present',
        }),
        sections: this.sections.map((s) => s.name || s.section || String(s)),
        completeness: hasPclntabSection
          ? {
            present: true,
            declared: 0,
            scanned: 0,
            parsed: 0,
            complete: false,
            reasons: ['pclntab-section-bytes-unavailable'],
          }
          : { present: false, declared: 0, scanned: 0, parsed: 0, complete: true },
      });
    }

    if (this.pclntabBuffer.length < 16) {
      return createLanguageMetadataResult({
        providerId: this.id,
        providerVersion: this.version,
        ecosystem: 'go',
        identity: createLanguageMetadataIdentity({
          verdict: 'malformed',
          providerId: this.id,
          providerVersion: this.version,
          ecosystem: 'go',
          binaryIdentity: this.binaryIdentity,
          architecture: this.architecture,
          platform: this.platform,
          method: 'pclntab-probe',
          detail: 'pclntab buffer truncated (smaller than minimum header)',
        }),
        sections: this.sections.map((s) => s.name || s.section || String(s)),
        completeness: { present: true, declared: 0, scanned: 0, parsed: 0, complete: false, reasons: ['buffer-too-small'] },
      });
    }

    const header = parsePclntabHeader(this.pclntabBuffer);
    this.cachedHeader = header;

    if (!header.valid) {
      const verdict = header.reason === 'unrecognized-magic' ? 'unsupported' : 'malformed';
      return createLanguageMetadataResult({
        providerId: this.id,
        providerVersion: this.version,
        ecosystem: 'go',
        identity: createLanguageMetadataIdentity({
          verdict,
          providerId: this.id,
          providerVersion: this.version,
          ecosystem: 'go',
          binaryIdentity: this.binaryIdentity,
          architecture: this.architecture,
          platform: this.platform,
          method: 'pclntab-header',
          detail: `pclntab validation failed: ${header.reason}`,
        }),
        sections: this.sections.map((s) => s.name || s.section || String(s)),
        completeness: { present: true, declared: 0, scanned: 0, parsed: 0, complete: false, reasons: [header.reason] },
        diagnostics: [`Go pclntab invalid: ${header.reason}`],
      });
    }

    const buildVersion = findGoBuildVersion(this.rodataBuffer) || header.versionName;
    const funcResult = parseGoFunctions(this.pclntabBuffer, header, this.options);
    this.cachedFunctions = funcResult;

    // pclntab proves only the function-symbol domain. Runtime type metadata
    // (moduledata/typelinks) is not enumerated by this provider yet, so a
    // complete function-table scan cannot establish whole-provider completeness.
    const completeness = {
      ...funcResult.completeness,
      complete: false,
      reasons: [
        ...(funcResult.completeness.reasons ?? []),
        'go-runtime-types-unscanned',
      ],
    };
    const hasIdentityBinding = this.binaryIdentity != null;
    const identity = createLanguageMetadataIdentity({
      verdict: hasIdentityBinding ? 'matched-partial' : 'identity-unavailable',
      providerId: this.id,
      providerVersion: this.version,
      ecosystem: 'go',
      toolchainVersion: buildVersion,
      binaryIdentity: this.binaryIdentity,
      expected: this.binaryIdentity,
      observed: this.binaryIdentity,
      architecture: this.architecture,
      platform: this.platform,
      method: 'pclntab-magic',
      detail: hasIdentityBinding
        ? `Go ${header.versionName} (${funcResult.functions.length} functions)`
        : `Go ${header.versionName} without binary identity binding (${funcResult.functions.length} functions)`,
      coverage: {
        recordKinds: ['symbol'],
        addresses: funcResult.functions.map((f) => f.address),
      },
    });

    return createLanguageMetadataResult({
