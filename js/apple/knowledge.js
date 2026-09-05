import { deepFreeze } from '../core/identity/index.js';
import { chainedPointerSites } from '../binary/macho-dyld.js';
import { machOImageAuthority } from '../binary/macho-core.js';
import {
  SWIFT_PROVIDER_ID,
  SWIFT_PROVIDER_VERSION,
  probeCanonicalSwiftMetadata,
} from '../metadata/swift.js';
import {
  OBJC_PROVIDER_ID,
  OBJC_PROVIDER_VERSION,
  probeCanonicalObjcMetadata,
} from '../metadata/objc.js';
import { IncrementalSha256 } from '../cache/content-identity.js';

export const APPLE_KNOWLEDGE_SCHEMA = 'hex-apple-knowledge/v1';
export const APPLE_KNOWLEDGE_PROVIDER_ID = 'apple.knowledge';
export const APPLE_KNOWLEDGE_PROVIDER_VERSION = '1.0.0';
export const APPLE_CODE_SIGNATURE_SCHEMA = 'hex-apple-code-signature/v1';
export const DYLD_SHARED_CACHE_SCHEMA = 'hex-dyld-shared-cache/v1';
export const APPLE_KNOWLEDGE_MATRIX_VERSION = '2026.09';

const DYLD_CACHE_HEADER_PREFIX_SIZE = 104;
const DYLD_CACHE_MAPPING_SIZE = 32;
const MAX_DYLD_CACHE_MAPPINGS = 4096;
const MAX_SIGNATURE_BLOBS = 4096;
const MAX_APPLE_IDENTITY_BYTES = 64 * 1024 * 1024;
const CSMAGIC_EMBEDDED_SIGNATURE = 0xfade0cc0;
const CSMAGIC_DETACHED_SIGNATURE = 0xfade0cc1;
const CSMAGIC_CODEDIRECTORY = 0xfade0c02;
const CODE_DIRECTORY_VERSIONS = Object.freeze([0x20001, 0x20100, 0x20200, 0x20300, 0x20400, 0x20500, 0x20600]);
const SUPPORTED_CACHE_ARCHITECTURES = new Set(['arm64', 'arm64e', 'arm64_32', 'x86_64', 'x86_64h']);
const FAILURE_CELL_STATUSES = new Set(['partial', 'unsupported', 'malformed', 'ambiguous', 'unknown']);
const APPLE_KNOWLEDGE_CELLS = Object.freeze(['dyldCache', 'chainedFixups', 'swift', 'objc', 'pointerAuthentication', 'codeSigning']);
const ISSUED_APPLE_KNOWLEDGE = new WeakSet();
const ISSUED_DYLD_CACHES = new WeakMap();
const ISSUED_LANGUAGE_RESULTS = new WeakMap();
const CODE_DIRECTORY_HASH_TYPES = new Map([
  [1, 20], // SHA-1
  [2, 32], // SHA-256
  [3, 20], // SHA-256 truncated
  [4, 48], // SHA-384
  [5, 64], // SHA-512
]);

export const APPLE_KNOWLEDGE_FORMAT_MATRIX = deepFreeze({
  version: APPLE_KNOWLEDGE_MATRIX_VERSION,
  dyldCache: { headers: ['dyld_v1'], architectures: [...SUPPORTED_CACHE_ARCHITECTURES].sort(), mappingRecordBytes: DYLD_CACHE_MAPPING_SIZE },
  chainedFixups: {
    versions: [0],
    importFormats: [1, 2, 3],
    symbolPoolFormats: [0],
    pointerFormats: [1, 2, 3, 4, 5, 6, 7, 9, 10, 12],
    authenticatedPointerFormats: [1, 7, 9, 10, 12],
  },
  swift: { providerId: 'metadata.swift', providerVersions: ['1.0.0'], abiFamilies: ['swift-5'] },
  objc: { providerId: 'metadata.objc', providerVersions: ['1.0.0'], runtimeFamilies: ['objc-2.0'] },
  codeSigning: {
    superBlobMagics: [CSMAGIC_EMBEDDED_SIGNATURE, CSMAGIC_DETACHED_SIGNATURE],
    codeDirectoryVersions: [...CODE_DIRECTORY_VERSIONS],
    validityAuthority: 'external-only',
  },
});

function residentBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new TypeError('apple-knowledge-bytes-required');
}

function byteBackingLength(input) {
  if (input instanceof Uint8Array) return input.byteLength;
  if (input instanceof ArrayBuffer) return input.byteLength;
  if (ArrayBuffer.isView(input)) return input.byteLength;
  if (input?.__binaryByteBacking === true && typeof input.subarray === 'function') {
    const size = typeof input.size === 'bigint' ? input.size : BigInt(input.length);
    if (size < 0n || size > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('apple-knowledge-backing-size-invalid');
    return Number(size);
  }
  throw new TypeError('apple-knowledge-bytes-required');
}

function residentRange(input, offset, size) {
  if (input?.__binaryByteBacking === true && !(input instanceof Uint8Array)) {
    return input.subarray(offset, offset + size);
  }
  return residentBytes(input).subarray(offset, offset + size);
}

function safeOffset(value, code) {
  const n = typeof value === 'bigint' ? value : Number.isSafeInteger(value) ? BigInt(value) : null;
  if (n == null || n < 0n || n > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(code);
  return Number(n);
}

function strictOffsetBigInt(value, code) {
  if (typeof value === 'bigint') {
    if (value >= 0n) return value;
  } else if (Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  throw new RangeError(code);
}

function rangeFits(length, offset, size) {
  return Number.isSafeInteger(offset) && Number.isSafeInteger(size)
    && offset >= 0 && size >= 0 && offset <= length && size <= length - offset;
}

function ascii(bytes, start, size) {
  let result = '';
  const end = start + size;
  for (let i = start; i < end; i++) result += String.fromCharCode(bytes[i]);
  return result.replace(/\0+$/, '').trimEnd();
}

function hexBytes(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function readCString(bytes, start, end) {
  if (!Number.isSafeInteger(start) || start < 0 || start >= end || end > bytes.length) return null;
  let cursor = start;
  while (cursor < end && bytes[cursor] !== 0) cursor++;
  if (cursor === end) return null;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(start, cursor)); }
  catch { return null; }
}

function uniqueReasons(reasons) {
  return [...new Set(reasons.filter((reason) => typeof reason === 'string' && reason))].sort();
}

function nonEmptyIdentity(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function residentBinaryIdentity(bytes) {
  if (bytes.byteLength > MAX_APPLE_IDENTITY_BYTES) return null;
  return `bin_sha256_${new IncrementalSha256().update(bytes).hexDigest()}`;
}

function dyldMalformed(reason, evidence = {}) {
  return deepFreeze({
    schema: DYLD_SHARED_CACHE_SCHEMA,
    status: 'malformed',
    complete: false,
    reasons: [reason],
    mappings: [],
    ambiguities: [],
    evidence,
  });
}

/**
 * Parse the stable dyld shared-cache v1 prefix and mapping table only.  Slide
 * info and image extraction intentionally remain unsupported rather than being
 * guessed from evolving private header tails.
 */
export function parseDyldSharedCache(input, options = {}) {
  let bytes;
  try { bytes = residentBytes(input); }
  catch { return dyldMalformed('bytes-required'); }
  const sourceValue = options.sourceOffset ?? 0n;
  const sourceOffset = typeof sourceValue === 'bigint'
    ? sourceValue
    : Number.isSafeInteger(sourceValue) ? BigInt(sourceValue) : -1n;
  if (sourceOffset < 0n) return dyldMalformed('source-offset-invalid');
  if (bytes.length < 16) return dyldMalformed('header-truncated', { byteLength: bytes.length, sourceOffset });

  const magic = ascii(bytes, 0, 16);
  const match = /^dyld_v1\s+([A-Za-z0-9_]+)$/.exec(magic);
  if (!match) {
    return deepFreeze({
      schema: DYLD_SHARED_CACHE_SCHEMA,
      status: 'unsupported',
      complete: false,
      reasons: ['unknown-cache-magic'],
      magic,
      architecture: null,
      binaryIdentity: options.binaryIdentity ?? null,
      mappings: [],
      ambiguities: [],
      evidence: { sourceOffset, byteLength: bytes.length },
    });
  }
  const architecture = match[1];
  if (!SUPPORTED_CACHE_ARCHITECTURES.has(architecture)) {
    return deepFreeze({
      schema: DYLD_SHARED_CACHE_SCHEMA,
      status: 'unsupported',
      complete: false,
      reasons: ['unknown-cache-architecture'],
      magic,
      architecture,
      binaryIdentity: options.binaryIdentity ?? null,
      mappings: [],
      ambiguities: [],
      evidence: { sourceOffset, byteLength: bytes.length },
    });
  }
  if (bytes.length < DYLD_CACHE_HEADER_PREFIX_SIZE) return dyldMalformed('header-prefix-truncated', { magic, architecture, sourceOffset, byteLength: bytes.length });

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const binaryIdentity = residentBinaryIdentity(bytes);
  const sliceIdentity = binaryIdentity == null ? null : `slice_dyld_${architecture}_${sourceOffset.toString(16)}_${bytes.byteLength.toString(16)}_${binaryIdentity.slice('bin_sha256_'.length)}`;
  const mappingOffset = view.getUint32(16, true);
  const mappingCount = view.getUint32(20, true);
  const imagesOffset = view.getUint32(24, true);
  const imagesCount = view.getUint32(28, true);
  const dyldBaseAddress = view.getBigUint64(32, true);
  const codeSignatureOffset = view.getBigUint64(40, true);
  const codeSignatureSize = view.getBigUint64(48, true);
  const slideInfoOffset = view.getBigUint64(56, true);
  const slideInfoSize = view.getBigUint64(64, true);
  const localSymbolsOffset = view.getBigUint64(72, true);
  const localSymbolsSize = view.getBigUint64(80, true);
  const uuid = hexBytes(bytes.subarray(88, 104));

  if (mappingCount > MAX_DYLD_CACHE_MAPPINGS) return dyldMalformed('mapping-count-unreasonable', { magic, architecture, mappingCount, sourceOffset });
  const mappingBytes = mappingCount * DYLD_CACHE_MAPPING_SIZE;
  if (!Number.isSafeInteger(mappingBytes) || mappingOffset < DYLD_CACHE_HEADER_PREFIX_SIZE || !rangeFits(bytes.length, mappingOffset, mappingBytes)) {
    return dyldMalformed('mapping-table-range-invalid', { magic, architecture, mappingOffset, mappingCount, sourceOffset });
  }

  const mappings = [];
  for (let index = 0; index < mappingCount; index++) {
    const tableOffset = mappingOffset + index * DYLD_CACHE_MAPPING_SIZE;
    const address = view.getBigUint64(tableOffset, true);
    const size = view.getBigUint64(tableOffset + 8, true);
    const fileOffset = view.getBigUint64(tableOffset + 16, true);
    const maxProtection = view.getUint32(tableOffset + 24, true);
    const initialProtection = view.getUint32(tableOffset + 28, true);
    if (size === 0n || fileOffset > BigInt(bytes.length) || size > BigInt(bytes.length) - fileOffset || address + size > 0xffffffffffffffffn) {
      return dyldMalformed('mapping-range-invalid', { magic, architecture, mappingIndex: index, tableOffset: sourceOffset + BigInt(tableOffset) });
    }
    mappings.push({
      index,
      address,
      size,
      fileOffset,
      maxProtection,
      initialProtection,
      provenance: { tableOffset: sourceOffset + BigInt(tableOffset), recordSize: DYLD_CACHE_MAPPING_SIZE },
    });
  }

  const ambiguities = [];
  for (let left = 0; left < mappings.length; left++) {
    const a = mappings[left];
    for (let right = left + 1; right < mappings.length; right++) {
      const b = mappings[right];
      const start = a.address > b.address ? a.address : b.address;
      const endA = a.address + a.size;
      const endB = b.address + b.size;
      const end = endA < endB ? endA : endB;
      if (start < end) ambiguities.push({ kind: 'overlapping-vm-mappings', candidates: [a.index, b.index], start, end });
    }
  }

  let codeSignature = null;
  if (codeSignatureOffset !== 0n || codeSignatureSize !== 0n) {
    if (codeSignatureOffset === 0n || codeSignatureSize === 0n || codeSignatureOffset > BigInt(bytes.length) || codeSignatureSize > BigInt(bytes.length) - codeSignatureOffset) {
      return dyldMalformed('code-signature-range-invalid', { magic, architecture, codeSignatureOffset, codeSignatureSize, sourceOffset });
    }
    codeSignature = parseAppleCodeSignature(bytes, {
      dataOffset: codeSignatureOffset,
      dataSize: codeSignatureSize,
      containerOffset: sourceOffset,
    });
  }

  const reasons = [];
  if (ambiguities.length) reasons.push('overlapping-vm-mappings');
  if (codeSignature && codeSignature.status !== 'structurally-valid' && codeSignature.status !== 'absent') reasons.push(`code-signature-${codeSignature.status}`);
  if (!binaryIdentity) reasons.push('binary-identity-budget-exhausted');
  const status = ambiguities.length
    ? 'ambiguous'
    : !binaryIdentity || codeSignature && codeSignature.status !== 'structurally-valid' && codeSignature.status !== 'absent'
      ? 'partial'
      : 'supported';
  const result = deepFreeze({
    schema: DYLD_SHARED_CACHE_SCHEMA,
    status,
    complete: status === 'supported',
    reasons: uniqueReasons(reasons),
    magic,
    architecture,
    binaryIdentity,
    sliceIdentity,
    uuid,
    header: {
      mappingOffset,
      mappingCount,
      imagesOffset,
      imagesCount,
      dyldBaseAddress,
      codeSignatureOffset,
      codeSignatureSize,
      slideInfoOffset,
      slideInfoSize,
      localSymbolsOffset,
      localSymbolsSize,
    },
    mappings,
    ambiguities,
    codeSignature,
    evidence: { sourceOffset, byteLength: bytes.length, headerOffset: sourceOffset, mappingTableOffset: sourceOffset + BigInt(mappingOffset) },
  });
  ISSUED_DYLD_CACHES.set(result, deepFreeze({ binaryIdentity, sliceIdentity, architecture }));
  return result;
}

/** Return a cache base only for an intact parser-issued cache bound to this slice. */
export function authoritativeDyldSharedCacheBase(cache, expected = null) {
  if (!cache || typeof cache !== 'object') return null;
  const binding = ISSUED_DYLD_CACHES.get(cache);
  if (!binding || cache.status !== 'supported' || cache.complete !== true) return null;
  if (expected && (binding.binaryIdentity !== nonEmptyIdentity(expected.binaryIdentity)
    || binding.sliceIdentity !== nonEmptyIdentity(expected.sliceIdentity)
    || binding.architecture !== nonEmptyIdentity(expected.architecture))) return null;
  const base = cache.header?.dyldBaseAddress;
  return typeof base === 'bigint' && base >= 0n && base <= 0xffffffffffffffffn ? base : null;
}

/** Internal parser binding for a cache object; unissued/public clones return null. */
export function dyldCacheAuthority(cache) {
  return cache && typeof cache === 'object' ? ISSUED_DYLD_CACHES.get(cache) ?? null : null;
}

/** Derive and execute an exact built-in provider from parser-issued image evidence. */
export async function probeAppleLanguageMetadata(image, ecosystem) {
  const imageAuthority = machOImageAuthority(image);
  if (!imageAuthority) throw new TypeError('apple-language-image-unissued');
  if (ecosystem !== 'swift' && ecosystem !== 'objc') throw new TypeError('apple-language-ecosystem-invalid');
  const binaryIdentity = imageAuthority.binaryIdentity;
  const architecture = imageAuthority.architecture;
  const sections = imageAuthority.sections;
  const metadataSource = imageAuthority.createMetadataSource();
  const relevantSections = sections.filter((section) => ecosystem === 'swift'
    ? section.name.includes('swift5') || section.name.includes('sw5')
    : section.name.includes('objc_') || section.name.includes('__OBJC'));
  const sourceComplete = imageAuthority.sourceComplete === true
    && metadataSource !== null
    && imageAuthority.machoMetadata?.complete === true
    && imageAuthority.codeSignatureCommandsComplete === true
    && imageAuthority.contentMatches();
  const common = {
    readAt: metadataSource?.readAt ?? null,
    sections,
    binaryIdentity,
    architecture,
    platform: imageAuthority.platform,
  };
  const expectedProviderId = ecosystem === 'swift' ? SWIFT_PROVIDER_ID : OBJC_PROVIDER_ID;
  const expectedProviderVersion = ecosystem === 'swift' ? SWIFT_PROVIDER_VERSION : OBJC_PROVIDER_VERSION;
  const result = ecosystem === 'swift'
    ? await probeCanonicalSwiftMetadata(common)
    : await probeCanonicalObjcMetadata({
      ...common,
      options: {
        imageBase: imageAuthority.imageBase,
        runtimeSections: {
          architecture,
          executableRanges: imageAuthority.segments
            .filter((segment) => segment.perms.execute)
            .map((segment) => ({ vmAddr: segment.address, size: segment.size })),
        },
      },
    });
  if (!result || typeof result !== 'object'
    || result.providerId !== expectedProviderId
    || result.providerVersion !== expectedProviderVersion
    || result.identity?.binaryIdentity !== binaryIdentity
    || result.identity?.architecture !== architecture) {
    throw new TypeError('apple-language-result-binding-invalid');
  }
  const contentMatches = imageAuthority.contentMatches();
  ISSUED_LANGUAGE_RESULTS.set(result, Object.freeze({
    binaryIdentity,
    architecture,
    image,
    ecosystem,
    sourceComplete: sourceComplete && contentMatches,
    declaredPresent: relevantSections.length > 0,
  }));
  return result;
}

function signatureResult(status, details = {}) {
  return deepFreeze({
    schema: APPLE_CODE_SIGNATURE_SCHEMA,
    status,
    complete: status === 'structurally-valid' || status === 'absent',
    reasons: [],
    validity: 'unknown',
    authoritativeValidation: null,
    blobs: [],
    codeDirectories: [],
    ...details,
  });
}

function malformedSignature(reason, details = {}) {
  return signatureResult('malformed', { ...details, complete: false, reasons: [reason] });
}

/** Represent a malformed signing load command without pretending it was absent. */
export function malformedAppleCodeSignature(reason, details = {}) {
  return malformedSignature(reason, details);
}

/** Parse Apple code-signing structure; never claim cryptographic validity. */
export function parseAppleCodeSignature(input, options = {}) {
  let inputLength;
  try { inputLength = byteBackingLength(input); }
  catch { return malformedSignature('bytes-required'); }
  let dataOffset, dataSize, containerOffset, commandOffset = null;
  try {
    dataOffset = safeOffset(options.dataOffset ?? 0, 'signature-data-offset-invalid');
    dataSize = options.dataSize == null ? inputLength - dataOffset : safeOffset(options.dataSize, 'signature-data-size-invalid');
    containerOffset = strictOffsetBigInt(options.containerOffset ?? 0n, 'signature-container-offset-invalid');
    if (options.commandOffset != null) {
      commandOffset = strictOffsetBigInt(options.commandOffset, 'signature-command-offset-invalid');
    }
  } catch (error) {
    return malformedSignature(error.message);
  }
  const provenance = {
    commandOffset,
    dataOffset: containerOffset + BigInt(dataOffset),
    dataSize,
  };
  if (dataSize === 0) return signatureResult('absent', { provenance });
  if (!rangeFits(inputLength, dataOffset, dataSize) || dataSize < 12) return malformedSignature('signature-range-invalid', { provenance });
  // Request exactly the declared LC_CODE_SIGNATURE range. Sparse source-backed
  // parsing will surface a cache miss for this one bounded range and restart;
  // it never needs to materialize the whole Mach-O slice.
  let bytes;
  try { bytes = residentRange(input, dataOffset, dataSize); }
  catch (error) {
    if (error?.code === 'BINARY_SOURCE_RANGE_MISSING') throw error;
    return malformedSignature('signature-range-invalid', { provenance });
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint32(0, false);
  if (magic !== CSMAGIC_EMBEDDED_SIGNATURE && magic !== CSMAGIC_DETACHED_SIGNATURE) {
    return signatureResult('unsupported', { complete: false, reasons: ['unsupported-superblob-magic'], magic, provenance });
  }
  const length = view.getUint32(4, false);
  const count = view.getUint32(8, false);
  if (length < 12 || length > dataSize) return malformedSignature('superblob-length-invalid', { magic, provenance });
  if (count > MAX_SIGNATURE_BLOBS || count > Math.floor((length - 12) / 8)) return malformedSignature('superblob-count-invalid', { magic, provenance });
  const indexEnd = 12 + count * 8;
  const blobs = [];
  const codeDirectories = [];
  const ranges = [];
  for (let index = 0; index < count; index++) {
    const entry = 12 + index * 8;
    const type = view.getUint32(entry, false);
    const relativeOffset = view.getUint32(entry + 4, false);
    if (relativeOffset < indexEnd || relativeOffset > length - 8) return malformedSignature('blob-offset-invalid', { magic, provenance, blobIndex: index });
    const blobOffset = relativeOffset;
    const blobMagic = view.getUint32(blobOffset, false);
    const blobLength = view.getUint32(blobOffset + 4, false);
    if (blobLength < 8 || blobLength > length - relativeOffset) return malformedSignature('blob-length-invalid', { magic, provenance, blobIndex: index });
    const range = { start: relativeOffset, end: relativeOffset + blobLength, index };
    if (ranges.some((other) => range.start < other.end && other.start < range.end)) return malformedSignature('blob-ranges-overlap', { magic, provenance, blobIndex: index });
    ranges.push(range);
    const blob = { index, type, offset: relativeOffset, magic: blobMagic, length: blobLength, provenance: { indexOffset: containerOffset + BigInt(dataOffset + entry), blobOffset: containerOffset + BigInt(dataOffset + blobOffset) } };
    blobs.push(blob);
    if (blobMagic !== CSMAGIC_CODEDIRECTORY) continue;
    if (blobLength < 44) return malformedSignature('code-directory-truncated', { magic, provenance, blobIndex: index });
    const version = view.getUint32(blobOffset + 8, false);
    const flags = view.getUint32(blobOffset + 12, false);
    const hashOffset = view.getUint32(blobOffset + 16, false);
    const identifierOffset = view.getUint32(blobOffset + 20, false);
    const specialSlotCount = view.getUint32(blobOffset + 24, false);
    const codeSlotCount = view.getUint32(blobOffset + 28, false);
    const codeLimit32 = view.getUint32(blobOffset + 32, false);
    const hashSize = view.getUint8(blobOffset + 36);
    const hashType = view.getUint8(blobOffset + 37);
    const platform = view.getUint8(blobOffset + 38);
    const pageSizeLog2 = view.getUint8(blobOffset + 39);
    const spare2 = view.getUint32(blobOffset + 40, false);
    if (!CODE_DIRECTORY_VERSIONS.includes(version)) {
      return signatureResult('unsupported', { complete: false, reasons: ['unsupported-code-directory-version'], magic, length, count, blobs, codeDirectories, provenance });
    }
    const versionedMinimum = version >= 0x20600 ? 108
      : version >= 0x20500 ? 96
        : version >= 0x20400 ? 88
          : version >= 0x20300 ? 64
            : version >= 0x20200 ? 52
              : version >= 0x20100 ? 48
                : 44;
    if (blobLength < versionedMinimum) return malformedSignature('code-directory-versioned-fields-truncated', { magic, provenance, blobIndex: index });
    if (spare2 !== 0) return malformedSignature('code-directory-spare2-nonzero', { magic, provenance, blobIndex: index });
    const scatterOffset = version >= 0x20100 ? view.getUint32(blobOffset + 44, false) : 0;
    const teamOffset = version >= 0x20200 ? view.getUint32(blobOffset + 48, false) : 0;
    const spare3 = version >= 0x20300 ? view.getUint32(blobOffset + 52, false) : 0;
    if (spare3 !== 0) return malformedSignature('code-directory-spare3-nonzero', { magic, provenance, blobIndex: index });
    const codeLimit64 = version >= 0x20300 ? view.getBigUint64(blobOffset + 56, false) : 0n;
    const codeLimit = codeLimit64 !== 0n ? codeLimit64 : BigInt(codeLimit32);
    if (!CODE_DIRECTORY_HASH_TYPES.has(hashType)) {
      return signatureResult('unsupported', { complete: false, reasons: ['unsupported-code-directory-hash-type'], magic, length, count, blobs, codeDirectories, provenance });
    }
    if (hashSize !== CODE_DIRECTORY_HASH_TYPES.get(hashType) || pageSizeLog2 > 31) {
      return malformedSignature('code-directory-hash-shape-invalid', { magic, provenance, blobIndex: index });
    }
    const codeHashBytes = codeSlotCount * hashSize;
    const specialHashBytes = specialSlotCount * hashSize;
    if (!Number.isSafeInteger(codeHashBytes) || !Number.isSafeInteger(specialHashBytes)
      || hashOffset < versionedMinimum + specialHashBytes || hashOffset > blobLength || codeHashBytes > blobLength - hashOffset) {
      return malformedSignature('code-directory-hash-range-invalid', { magic, provenance, blobIndex: index });
    }
    const pageSize = pageSizeLog2 === 0 ? null : 1n << BigInt(pageSizeLog2);
    const expectedCodeSlots = codeLimit === 0n ? 0n : pageSize == null ? 1n : (codeLimit + pageSize - 1n) / pageSize;
    if (BigInt(codeSlotCount) !== expectedCodeSlots) return malformedSignature('code-directory-slot-count-invalid', { magic, provenance, blobIndex: index });
    if (dataOffset > 0 && codeLimit > BigInt(dataOffset)) return malformedSignature('code-directory-limit-crosses-signature', { magic, provenance, blobIndex: index });
    const identifier = readCString(bytes, blobOffset + identifierOffset, blobOffset + blobLength);
    if (identifierOffset < versionedMinimum || identifier == null) return malformedSignature('code-directory-identifier-invalid', { magic, provenance, blobIndex: index });
    if (scatterOffset !== 0) {
      if (scatterOffset < versionedMinimum || scatterOffset > blobLength - 24) return malformedSignature('code-directory-scatter-range-invalid', { magic, provenance, blobIndex: index });
      let scatterCursor = scatterOffset;
      let terminated = false;
      for (let entryIndex = 0; entryIndex < 4096 && scatterCursor <= blobLength - 24; entryIndex++, scatterCursor += 24) {
        const entryCount = view.getUint32(blobOffset + scatterCursor, false);
        const scatterSpare = view.getBigUint64(blobOffset + scatterCursor + 16, false);
        if (scatterSpare !== 0n) return malformedSignature('code-directory-scatter-spare-nonzero', { magic, provenance, blobIndex: index });
        if (entryCount === 0) { terminated = true; break; }
      }
      if (!terminated) return malformedSignature('code-directory-scatter-unterminated', { magic, provenance, blobIndex: index });
    }
    const team = teamOffset === 0 ? null : readCString(bytes, blobOffset + teamOffset, blobOffset + blobLength);
    if (teamOffset !== 0 && (teamOffset < versionedMinimum || team == null)) return malformedSignature('code-directory-team-invalid', { magic, provenance, blobIndex: index });
    const preEncryptOffset = version >= 0x20500 ? view.getUint32(blobOffset + 92, false) : 0;
    if (preEncryptOffset !== 0 && (preEncryptOffset < versionedMinimum || preEncryptOffset > blobLength || codeHashBytes > blobLength - preEncryptOffset)) {
      return malformedSignature('code-directory-pre-encrypt-range-invalid', { magic, provenance, blobIndex: index });
    }
    const linkageHashType = version >= 0x20600 ? view.getUint8(blobOffset + 96) : 0;
    const linkageOffset = version >= 0x20600 ? view.getUint32(blobOffset + 100, false) : 0;
    const linkageSize = version >= 0x20600 ? view.getUint32(blobOffset + 104, false) : 0;
    if ((linkageOffset === 0) !== (linkageSize === 0)
      || (linkageSize !== 0 && (!CODE_DIRECTORY_HASH_TYPES.has(linkageHashType)
        || linkageOffset < versionedMinimum || linkageOffset > blobLength || linkageSize > blobLength - linkageOffset))) {
      return malformedSignature('code-directory-linkage-range-invalid', { magic, provenance, blobIndex: index });
    }
    codeDirectories.push({
      blobIndex: index,
      version,
      flags,
      hashOffset,
      identifierOffset,
      identifier,
      specialSlotCount,
      codeSlotCount,
      codeLimit,
      codeLimit32: BigInt(codeLimit32),
      codeLimit64,
      hashSize,
      hashType,
      platform,
      pageSizeLog2,
      scatterOffset,
      teamOffset,
      team,
      preEncryptOffset,
      linkageHashType,
      linkageOffset,
      linkageSize,
      provenance: { blobOffset: containerOffset + BigInt(dataOffset + blobOffset), directoryOffset: containerOffset + BigInt(dataOffset + blobOffset) },
    });
  }
  if (!codeDirectories.length) return signatureResult('unsupported', { complete: false, reasons: ['code-directory-missing'], magic, length, count, blobs, codeDirectories, provenance });
  return signatureResult('structurally-valid', { magic, length, count, blobs, codeDirectories, provenance });
}

function sameBytes(left, right) {
  if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array) || left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return false;
  return true;
}

function mutationBytes(value) {
  if (value == null) return null;
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value) && value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 0xff)) return Uint8Array.from(value);
  return undefined;
}

/** Classify mutation consequences without validating or fabricating a signature. */
export function assessAppleSigningImpact(signature, mutations = []) {
  if (!signature || signature.status === 'absent') return deepFreeze({ state: 'unsigned', validity: 'unknown', requiresAuthoritativeValidation: false, coveredMutations: [] });
  if (signature.status !== 'structurally-valid') return deepFreeze({ state: 'blocked-signature-structure-unknown', validity: 'unknown', requiresAuthoritativeValidation: true, coveredMutations: [] });
  if (!Array.isArray(mutations)) return deepFreeze({ state: 'blocked-mutation-list-invalid', validity: 'unknown', requiresAuthoritativeValidation: true, coveredMutations: [] });
  const limits = signature.codeDirectories.map((directory) => BigInt(directory.codeLimit));
  const coveredMutations = [];
  for (let index = 0; index < mutations.length; index++) {
    const mutation = mutations[index];
    let offset;
    try { offset = strictOffsetBigInt(mutation?.offset, 'mutation-offset-invalid'); }
    catch { return deepFreeze({ state: 'blocked-mutation-range-invalid', validity: 'unknown', requiresAuthoritativeValidation: true, coveredMutations: [] }); }
    if (offset < 0n) return deepFreeze({ state: 'blocked-mutation-range-invalid', validity: 'unknown', requiresAuthoritativeValidation: true, coveredMutations: [] });
    const before = mutationBytes(mutation?.before);
    const after = mutationBytes(mutation?.after);
    if (before === undefined || after === undefined) return deepFreeze({ state: 'blocked-mutation-bytes-invalid', validity: 'unknown', requiresAuthoritativeValidation: true, coveredMutations: [] });
    if (before && after && sameBytes(before, after)) continue;
    const explicitSize = mutation?.size == null ? null : Number(mutation.size);
    const size = explicitSize == null ? Math.max(before?.length ?? 0, after?.length ?? 0) : explicitSize;
    if (!Number.isSafeInteger(size) || size < 0 || (size === 0 && !(before || after))) return deepFreeze({ state: 'blocked-mutation-range-invalid', validity: 'unknown', requiresAuthoritativeValidation: true, coveredMutations: [] });
    const end = offset + BigInt(Math.max(1, size));
    const directories = limits.flatMap((limit, directoryIndex) => offset < limit && end > 0n ? [directoryIndex] : []);
    if (directories.length) coveredMutations.push({ mutationIndex: index, offset, size, codeDirectories: directories });
  }
  const changedMutationCount = mutations.filter((mutation) => {
    const before = mutationBytes(mutation?.before);
    const after = mutationBytes(mutation?.after);
    return !(before && after && sameBytes(before, after));
  }).length;
  return deepFreeze({
    state: coveredMutations.length
      ? 'invalidated-requires-resigning'
      : changedMutationCount
        ? 'authoritative-revalidation-required'
        : 'unchanged-signature-validity-unknown',
    validity: 'unknown',
    requiresAuthoritativeValidation: true,
    coveredMutations,
  });
}

function cell(status, version, evidence, reasons = [], complete = status === 'supported' || status === 'absent') {
  return { status, version: version ?? null, complete: !!complete, reasons: uniqueReasons(reasons), evidence: evidence ?? {} };
}

function languageCell(result, expectedProviderId, expectedProviderVersion, binding, matrixAuthoritative, image) {
  if (!result) return cell('unknown', null, {}, ['provider-evidence-missing'], false);
  const issued = ISSUED_LANGUAGE_RESULTS.get(result);
  if (!issued) return cell('malformed', null, {}, ['provider-result-unissued'], false);
  if (!matrixAuthoritative || issued.image !== image || issued.binaryIdentity !== binding.binaryIdentity || issued.architecture !== binding.architecture) {
    return cell('partial', result.providerVersion ?? null, {}, ['provider-result-binding-mismatch'], false);
  }
  if (issued.sourceComplete !== true) return cell('partial', result.providerVersion ?? null, {}, ['provider-source-incomplete'], false);
  if (result.providerId !== expectedProviderId || typeof result.providerVersion !== 'string' || !result.providerVersion) {
    return cell('malformed', result.providerVersion ?? null, {
      providerId: result.providerId ?? null,
      providerVersion: result.providerVersion ?? null,
      identity: result.identity ?? null,
      authoritative: false,
      completeness: result.completeness ?? null,
      counts: result.counts ?? {},
      sections: result.sections ?? [],
    }, [`provider-identity-mismatch:${expectedProviderId}`], false);
  }
  if (result.providerVersion !== expectedProviderVersion) {
    return cell('unsupported', result.providerVersion, {
      providerId: result.providerId,
      providerVersion: result.providerVersion,
      identity: result.identity ?? null,
      authoritative: false,
      completeness: result.completeness ?? null,
      counts: result.counts ?? {},
      sections: result.sections ?? [],
    }, [`provider-version-unsupported:${result.providerVersion}`], false);
  }
  const verdict = result.identity?.verdict ?? 'identity-unavailable';
  let status = 'partial';
  if (verdict === 'unsupported') status = 'unsupported';
  else if (verdict === 'malformed' || verdict === 'identity-mismatch') status = 'malformed';
  else if (verdict === 'ambiguous') status = 'ambiguous';
  else if (verdict === 'identity-unavailable' && result.completeness?.present !== true && issued.declaredPresent !== true) status = 'absent';
  else if (verdict === 'matched-authoritative' && result.authoritative === true && result.completeness?.complete === true) status = 'supported';
  const reasons = [...(result.completeness?.reasons || []), ...(result.diagnostics || [])];
  if (issued.declaredPresent === true && result.completeness?.present !== true) reasons.push('provider-declared-section-not-parsed');
  if (status !== 'supported' && status !== 'absent') reasons.push(`provider-verdict:${verdict}`);
  return cell(status, result.providerVersion ?? null, {
    providerId: result.providerId ?? null,
    providerVersion: result.providerVersion ?? null,
    identity: result.identity ?? null,
    authoritative: result.authoritative === true,
    completeness: result.completeness ?? null,
    counts: result.counts ?? {},
    sections: result.sections ?? [],
  }, reasons, status === 'supported' || status === 'absent');
}

export function buildAppleKnowledge({ image = null, binaryIdentity = null, sliceIdentity = null, swift = null, objc = null, dyldCache = null, mutations = [] } = {}) {
  const imageAuthority = machOImageAuthority(image);
  const requestedBinaryIdentity = binaryIdentity == null ? imageAuthority?.binaryIdentity ?? null : nonEmptyIdentity(binaryIdentity);
  const requestedSliceIdentity = sliceIdentity == null ? imageAuthority?.sliceIdentity ?? null : nonEmptyIdentity(sliceIdentity);
  const identityAuthoritative = !!imageAuthority
    && imageAuthority.binaryIdentity !== null
    && imageAuthority.sliceIdentity !== null
    && imageAuthority.binaryIdentity === requestedBinaryIdentity
    && imageAuthority.sliceIdentity === requestedSliceIdentity
    && imageAuthority.contentMatches();
  const identity = {
    binaryIdentity: requestedBinaryIdentity,
    sliceIdentity: requestedSliceIdentity,
    architecture: imageAuthority?.architecture ?? ISSUED_DYLD_CACHES.get(dyldCache)?.architecture ?? null,
    platform: 'apple',
    buildVersion: imageAuthority?.buildVersion ?? null,
    fileOffset: imageAuthority?.fileOffset ?? null,
    fileSize: imageAuthority?.fileSize ?? null,
    authoritative: identityAuthoritative,
  };
  const binding = {
    binaryIdentity: requestedBinaryIdentity,
    sliceIdentity: requestedSliceIdentity,
    architecture: identity.architecture,
  };
  const cacheIssued = !!dyldCache && ISSUED_DYLD_CACHES.has(dyldCache);
  const imageCacheAuthority = imageAuthority?.dyldCache === dyldCache ? imageAuthority.dyldCacheBinding : null;
  const cacheBinding = imageCacheAuthority ?? (imageAuthority ? null : binding);
  const cacheCell = !dyldCache
    ? cell('unknown', null, {}, ['dyld-cache-evidence-missing'], false)
    : !cacheIssued
      ? cell('malformed', null, {}, ['dyld-cache-evidence-unissued'], false)
      : authoritativeDyldSharedCacheBase(dyldCache, cacheBinding) == null
        ? cell(dyldCache.status === 'supported' ? 'partial' : dyldCache.status, 'dyld_v1', dyldCache, [...(dyldCache.reasons || []), 'dyld-cache-binding-unverified'], false)
        : cell('supported', 'dyld_v1', dyldCache, dyldCache.reasons, true);
  const machoComplete = imageAuthority?.machoMetadata?.complete === true
    && imageAuthority?.codeSignatureCommandsComplete === true;
  const chained = imageAuthority?.chainedFixups ?? null;
  const sites = imageAuthority?.chainedSites ?? [];
  let chainedStatus = !identityAuthoritative ? 'unknown' : machoComplete ? 'absent' : 'partial';
  if (identityAuthoritative && chained) {
    if (chained.version !== 0) chainedStatus = 'unsupported';
    else if (chained.partialReason === 'invalid-or-truncated-payload') chainedStatus = 'malformed';
    else chainedStatus = machoComplete && chained.complete === true && chained.importsComplete !== false && chained.bindingSitesComplete !== false ? 'supported' : 'partial';
  }
  const chainedReasons = [
    !identityAuthoritative ? 'mach-o-image-or-binding-unverified' : null,
    !machoComplete && identityAuthoritative ? 'mach-o-metadata-incomplete' : null,
    chained?.partialReason,
    chained?.importsPartialReason,
    ...(chained?.bindingSiteReasons || []),
  ];
  for (const format of chained?.unsupportedPointerFormats || []) chainedReasons.push(`unsupported-pointer-format:${format}`);
  const chainedCell = cell(chainedStatus, chained?.version ?? null, { metadata: chained, sites }, chainedReasons, chainedStatus === 'supported' || chainedStatus === 'absent');
  const authenticatedSites = sites.filter((site) => site.authenticated);
  let pacStatus = chainedCell.complete ? (authenticatedSites.length ? 'supported' : 'absent') : 'partial';
  const pacReasons = [];
  if (!chainedCell.complete) pacReasons.push('chained-fixup-coverage-incomplete');
  if (authenticatedSites.some((site) => !site.authentication)) { pacStatus = 'malformed'; pacReasons.push('authentication-fields-missing'); }
  if (authenticatedSites.length && identity.architecture !== 'arm64e') { pacStatus = 'ambiguous'; pacReasons.push('authenticated-pointer-on-non-arm64e-slice'); }
  const pacCell = cell(pacStatus, authenticatedSites.length ? 'arm64e-chained-auth/v1' : null, {
    sites: authenticatedSites,
    cryptographicValidation: 'not-performed',
  }, pacReasons, pacStatus === 'supported' || pacStatus === 'absent');
  const signature = imageAuthority?.codeSignature ?? null;
  let signatureStatus = !identityAuthoritative ? 'unknown' : !machoComplete ? 'partial' : 'absent';
  if (identityAuthoritative && signature) {
    if (signature.status === 'structurally-valid' && machoComplete) signatureStatus = 'supported';
    else if (signature.status === 'unsupported') signatureStatus = 'unsupported';
    else if (signature.status === 'malformed') signatureStatus = 'malformed';
    else if (signature.status === 'absent' && machoComplete) signatureStatus = 'absent';
  }
  const signingReasons = [
    ...(signature?.reasons || []),
    !identityAuthoritative ? 'mach-o-image-or-binding-unverified' : null,
    !machoComplete && identityAuthoritative ? 'mach-o-metadata-incomplete' : null,
  ];
  const signingCell = cell(signatureStatus, signature?.codeDirectories?.map((item) => item.version).join(',') || null, {
    structure: signature,
    consequence: assessAppleSigningImpact(signature, mutations),
    validity: 'unknown',
    authoritativeValidation: null,
  }, signingReasons, signatureStatus === 'supported' || signatureStatus === 'absent');
  const cells = {
    dyldCache: cacheCell,
    chainedFixups: chainedCell,
    swift: languageCell(swift, 'metadata.swift', '1.0.0', binding, identityAuthoritative, image),
    objc: languageCell(objc, 'metadata.objc', '1.0.0', binding, identityAuthoritative, image),
    pointerAuthentication: pacCell,
    codeSigning: signingCell,
  };
  const reasons = [];
  if (!identity.authoritative) reasons.push('binary-or-slice-identity-missing');
  for (const [name, value] of Object.entries(cells)) {
    if (FAILURE_CELL_STATUSES.has(value.status)) for (const reason of value.reasons.length ? value.reasons : [value.status]) reasons.push(`${name}:${reason}`);
  }
  const result = {
    schema: APPLE_KNOWLEDGE_SCHEMA,
    matrixVersion: APPLE_KNOWLEDGE_MATRIX_VERSION,
    formatMatrix: APPLE_KNOWLEDGE_FORMAT_MATRIX,
    provider: { id: APPLE_KNOWLEDGE_PROVIDER_ID, version: APPLE_KNOWLEDGE_PROVIDER_VERSION },
    identity,
    cells,
    complete: identity.authoritative && Object.values(cells).every((value) => value.complete),
    reasons: uniqueReasons(reasons),
  };
  const issued = deepFreeze(result);
  ISSUED_APPLE_KNOWLEDGE.add(issued);
  return issued;
}

function canonicalJsonValue(value) {
  if (typeof value === 'bigint') return { $bigint: value.toString() };
  if (value == null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('apple-knowledge-non-finite-number');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJsonValue(value[key])]));
  throw new TypeError('apple-knowledge-value-not-serializable');
}

function reviveBigInts(value) {
  if (Array.isArray(value)) return value.map(reviveBigInts);
  if (!value || typeof value !== 'object') return value;
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === '$bigint') {
    if (typeof value.$bigint !== 'string' || !/^-?(?:0|[1-9][0-9]*)$/.test(value.$bigint)) throw new TypeError('apple-knowledge-bigint-tag-invalid');
    return BigInt(value.$bigint);
  }
  return Object.fromEntries(keys.map((key) => [key, reviveBigInts(value[key])]));
}

export function serializeAppleKnowledge(result) {
  if (!result || result.schema !== APPLE_KNOWLEDGE_SCHEMA || !ISSUED_APPLE_KNOWLEDGE.has(result)) {
    throw new TypeError('apple-knowledge-schema-invalid');
  }
  const cells = Object.fromEntries(APPLE_KNOWLEDGE_CELLS.map((name) => {
    const source = result.cells[name];
    return [name, cell('unknown', source.version, source.evidence, [
      ...source.reasons,
      'serialized-evidence-requires-source-reparse',
    ], false)];
  }));
  const serialized = {
    schema: APPLE_KNOWLEDGE_SCHEMA,
    matrixVersion: APPLE_KNOWLEDGE_MATRIX_VERSION,
    formatMatrix: APPLE_KNOWLEDGE_FORMAT_MATRIX,
    provider: { id: APPLE_KNOWLEDGE_PROVIDER_ID, version: APPLE_KNOWLEDGE_PROVIDER_VERSION },
    identity: { ...result.identity, authoritative: false },
    cells,
    complete: false,
    reasons: uniqueReasons([...result.reasons, 'serialized-evidence-requires-source-reparse']),
    serializedEvidence: { authority: 'untrusted', assertedComplete: result.complete },
  };
  return JSON.stringify(canonicalJsonValue(serialized));
}

function serializedCell(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('apple-knowledge-contract-invalid');
  const allowedStatuses = new Set(['supported', 'absent', 'partial', 'unsupported', 'malformed', 'ambiguous', 'unknown']);
  if (!allowedStatuses.has(value.status)
      || (value.version != null && typeof value.version !== 'string' && !Number.isSafeInteger(value.version))
      || typeof value.complete !== 'boolean'
      || value.complete !== (value.status === 'supported' || value.status === 'absent')
      || !Array.isArray(value.reasons)
      || value.reasons.some((reason) => typeof reason !== 'string' || !reason)
      || !value.evidence || typeof value.evidence !== 'object' || Array.isArray(value.evidence)) {
    throw new TypeError('apple-knowledge-contract-invalid');
  }
  if (name === 'codeSigning'
      && (value.evidence.validity !== 'unknown' || value.evidence.authoritativeValidation !== null)) {
    throw new TypeError('apple-knowledge-contract-invalid');
  }
  return value;
}

export function parseSerializedAppleKnowledge(text) {
  if (typeof text !== 'string') throw new TypeError('apple-knowledge-serialized-text-required');
  let parsed;
  try { parsed = reviveBigInts(JSON.parse(text)); }
  catch (error) { throw new TypeError(`apple-knowledge-serialized-invalid:${error.message}`); }
  if (!parsed || parsed.schema !== APPLE_KNOWLEDGE_SCHEMA
    || parsed.matrixVersion !== APPLE_KNOWLEDGE_MATRIX_VERSION
    || JSON.stringify(canonicalJsonValue(parsed.formatMatrix)) !== JSON.stringify(canonicalJsonValue(APPLE_KNOWLEDGE_FORMAT_MATRIX))
    || parsed.provider?.id !== APPLE_KNOWLEDGE_PROVIDER_ID
    || parsed.provider?.version !== APPLE_KNOWLEDGE_PROVIDER_VERSION
    || !parsed.identity || !parsed.cells || typeof parsed.complete !== 'boolean'
    || typeof parsed.identity.authoritative !== 'boolean'
    || Object.keys(parsed.cells).sort().join('\0') !== [...APPLE_KNOWLEDGE_CELLS].sort().join('\0')) {
    throw new TypeError('apple-knowledge-contract-invalid');
  }
  const sourceCells = Object.fromEntries(APPLE_KNOWLEDGE_CELLS.map((name) => [name, serializedCell(parsed.cells[name], name)]));
  const assertedComplete = parsed.identity.authoritative && Object.values(sourceCells).every((value) => value.complete);
  if (parsed.complete !== assertedComplete
      || parsed.complete !== false
      || parsed.identity.authoritative !== false
      || parsed.serializedEvidence?.authority !== 'untrusted'
      || Object.values(sourceCells).some((value) => value.status !== 'unknown' || value.complete !== false)) {
    throw new TypeError('apple-knowledge-contract-invalid');
  }

  // A JSON payload has no private/module identity and carries no raw Mach-O
  // bytes from which completeness can be rederived. Preserve its candidate
  // evidence for inspection, but withdraw every authority-bearing verdict.
  const cells = Object.fromEntries(APPLE_KNOWLEDGE_CELLS.map((name) => {
    const source = sourceCells[name];
    return [name, cell('unknown', source.version, source.evidence, [
      ...source.reasons,
      'serialized-evidence-requires-source-reparse',
    ], false)];
  }));
  return deepFreeze({
    schema: APPLE_KNOWLEDGE_SCHEMA,
    matrixVersion: APPLE_KNOWLEDGE_MATRIX_VERSION,
    formatMatrix: APPLE_KNOWLEDGE_FORMAT_MATRIX,
    provider: { id: APPLE_KNOWLEDGE_PROVIDER_ID, version: APPLE_KNOWLEDGE_PROVIDER_VERSION },
    identity: { ...parsed.identity, authoritative: false },
    cells,
    complete: false,
    reasons: uniqueReasons([
      ...(Array.isArray(parsed.reasons) ? parsed.reasons.filter((reason) => typeof reason === 'string') : []),
      'serialized-evidence-requires-source-reparse',
    ]),
    serializedEvidence: { authority: 'untrusted', assertedComplete: parsed.complete },
  });
}
