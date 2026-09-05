import assert from 'node:assert/strict';
import {
  APPLE_KNOWLEDGE_SCHEMA,
  APPLE_KNOWLEDGE_FORMAT_MATRIX,
  assessAppleSigningImpact,
  buildAppleKnowledge,
  parseAppleCodeSignature,
  parseDyldSharedCache,
  probeAppleLanguageMetadata,
  parseSerializedAppleKnowledge,
  serializeAppleKnowledge,
} from '../js/apple/knowledge.js';
import {
  chainedPointerSites,
  decodeChainedPointer,
  parseChainedBindingSites,
  resolveMachOPointer,
} from '../js/binary/macho-dyld.js';
import { parseMachO } from '../js/binary/macho.js';
import { machOImageAuthority } from '../js/binary/macho-core.js';
import { ByteView } from '../js/binary/reader.js';
import { MemoryByteSource } from '../js/binary/source.js';
import { parseMachOSource } from '../js/binary/source-loaders.js';
import { SwiftMetadataProvider } from '../js/metadata/swift.js';
import { ObjcMetadataProvider } from '../js/metadata/objc.js';

function setAscii(bytes, offset, text, width = text.length) {
  const encoded = new TextEncoder().encode(text);
  bytes.set(encoded.subarray(0, width), offset);
}

function setU32be(view, offset, value) { view.setUint32(offset, value, false); }

function codeSignatureFixture({
  duplicateBlob = false,
  version = 0x20001,
  codeLimit = 0x30,
  codeLimit64 = 0n,
  pageSizeLog2 = 12,
  hashType = 2,
  hashSize = 32,
  spare2 = 0,
  spare3 = 0,
} = {}) {
  const count = duplicateBlob ? 2 : 1;
  const indexEnd = 12 + count * 8;
  const headerLength = version >= 0x20600 ? 108
    : version >= 0x20500 ? 96
      : version >= 0x20400 ? 88
        : version >= 0x20300 ? 64
          : version >= 0x20200 ? 52
            : version >= 0x20100 ? 48
              : 44;
  const identifierOffset = headerLength;
  const hashOffset = identifierOffset + 4;
  const effectiveCodeLimit = version >= 0x20300 && codeLimit64 !== 0n ? codeLimit64 : BigInt(codeLimit);
  const pageSize = pageSizeLog2 === 0 ? null : 1n << BigInt(pageSizeLog2);
  const codeSlotCount = effectiveCodeLimit === 0n ? 0 : pageSize == null ? 1 : Number((effectiveCodeLimit + pageSize - 1n) / pageSize);
  const directoryLength = hashOffset + codeSlotCount * hashSize;
  const total = indexEnd + directoryLength;
  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  setU32be(view, 0, 0xfade0cc0);
  setU32be(view, 4, total);
  setU32be(view, 8, count);
  setU32be(view, 12, 0);
  setU32be(view, 16, indexEnd);
  if (duplicateBlob) {
    setU32be(view, 20, 0x1000);
    setU32be(view, 24, indexEnd);
  }
  setU32be(view, indexEnd, 0xfade0c02);
  setU32be(view, indexEnd + 4, directoryLength);
  setU32be(view, indexEnd + 8, version);
  setU32be(view, indexEnd + 12, 0);
  setU32be(view, indexEnd + 16, hashOffset);
  setU32be(view, indexEnd + 20, identifierOffset);
  setU32be(view, indexEnd + 24, 0);
  setU32be(view, indexEnd + 28, codeSlotCount);
  setU32be(view, indexEnd + 32, codeLimit);
  view.setUint8(indexEnd + 36, hashSize);
  view.setUint8(indexEnd + 37, hashType);
  view.setUint8(indexEnd + 38, 0);
  view.setUint8(indexEnd + 39, pageSizeLog2);
  setU32be(view, indexEnd + 40, spare2);
  if (version >= 0x20300) setU32be(view, indexEnd + 52, spare3);
  if (version >= 0x20300) view.setBigUint64(indexEnd + 56, codeLimit64, false);
  setAscii(bytes, indexEnd + identifierOffset, 'app\0');
  return bytes;
}

function machoWithCodeSignature({ signature = codeSignatureFixture(), signatureOffset = 48, commandSize = 16 } = {}) {
  const bytes = new Uint8Array(Math.max(32 + commandSize, signatureOffset + signature.length));
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0xfeedfacf, true);
  view.setUint32(4, 0x0100000c, true);
  view.setUint32(8, 2, true);
  view.setUint32(12, 1, true);
  view.setUint32(16, 1, true);
  view.setUint32(20, commandSize, true);
  view.setUint32(32, 0x1d, true);
  view.setUint32(36, commandSize, true);
  if (commandSize >= 16) {
    view.setUint32(40, signatureOffset, true);
    view.setUint32(44, signature.length, true);
    bytes.set(signature, signatureOffset);
  }
  return bytes;
}

function fatMachO(thin, offset = 0x100) {
  const bytes = new Uint8Array(offset + thin.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0xcafebabe, false);
  view.setUint32(4, 1, false);
  view.setInt32(8, 0x0100000c, false);
  view.setInt32(12, 2, false);
  view.setUint32(16, offset, false);
  view.setUint32(20, thin.length, false);
  view.setUint32(24, 0, false);
  bytes.set(thin, offset);
  return bytes;
}

function machoWithMetadataSection(sectionName, { swiftDescriptor = false } = {}) {
  const bytes = new Uint8Array(0x3000);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0xfeedfacf, true);
  view.setUint32(4, 0x0100000c, true);
  view.setUint32(8, 2, true);
  view.setUint32(12, 1, true);
  view.setUint32(16, 1, true);
  view.setUint32(20, 152, true);
  view.setUint32(32, 0x19, true);
  view.setUint32(36, 152, true);
  setAscii(bytes, 40, '__DATA', 16);
  view.setBigUint64(56, 0x1000n, true);
  view.setBigUint64(64, 0x3000n, true);
  view.setBigUint64(72, 0n, true);
  view.setBigUint64(80, 0x3000n, true);
  view.setInt32(88, 3, true);
  view.setInt32(92, 3, true);
  view.setUint32(96, 1, true);
  setAscii(bytes, 104, sectionName, 16);
  setAscii(bytes, 120, '__DATA', 16);
  view.setBigUint64(136, 0x2000n, true);
  view.setBigUint64(144, 4n, true);
  view.setUint32(152, 0x200, true);
  if (swiftDescriptor) {
    view.setInt32(0x200, 0x100, true);
    view.setUint32(0x1100, 17, true);
    view.setInt32(0x1104, 0, true);
    view.setInt32(0x1108, 0xf8, true);
    view.setInt32(0x110c, 0, true);
    view.setInt32(0x1110, 0, true);
    view.setUint32(0x1114, 0, true);
    view.setUint32(0x1118, 0, true);
    setAscii(bytes, 0x1200, 'IssuedSwift\0');
  }
  return bytes;
}

function cacheFixture({ overlap = false, mappingCount = 2, truncate = false, architecture = 'arm64e' } = {}) {
  const bytes = new Uint8Array(truncate ? 128 : 0x280);
  const view = new DataView(bytes.buffer);
  setAscii(bytes, 0, `dyld_v1  ${architecture}`, 16);
  view.setUint32(16, 104, true);
  view.setUint32(20, mappingCount, true);
  view.setUint32(24, 0, true);
  view.setUint32(28, 0, true);
  view.setBigUint64(32, 0x180000000n, true);
  if (!truncate && mappingCount <= 2) {
    view.setBigUint64(104, 0x180000000n, true);
    view.setBigUint64(112, 0x40n, true);
    view.setBigUint64(120, 0x180n, true);
    view.setUint32(128, 5, true);
    view.setUint32(132, 1, true);
    if (mappingCount === 2) {
      view.setBigUint64(136, overlap ? 0x180000020n : 0x180001000n, true);
      view.setBigUint64(144, 0x40n, true);
      view.setBigUint64(152, 0x1c0n, true);
      view.setUint32(160, 3, true);
      view.setUint32(164, 3, true);
    }
  }
  return bytes;
}

function machoWithFormat4ChainedFixup() {
  const bytes = new Uint8Array(0x1100);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0xfeedfacf, true);
  view.setUint32(4, 0x0100000c, true);
  view.setUint32(8, 2, true); // arm64e
  view.setUint32(12, 2, true);
  view.setUint32(16, 2, true);
  view.setUint32(20, 88, true);

  view.setUint32(32, 0x19, true); // LC_SEGMENT_64
  view.setUint32(36, 72, true);
  setAscii(bytes, 40, '__DATA', 16);
  view.setBigUint64(56, 0x1000n, true);
  view.setBigUint64(64, 0x1000n, true);
  view.setBigUint64(72, 0x100n, true);
  view.setBigUint64(80, 0x1000n, true);
  view.setInt32(92, 3, true); // read/write

  view.setUint32(104, 0x80000034, true); // LC_DYLD_CHAINED_FIXUPS
  view.setUint32(108, 16, true);
  view.setUint32(112, 0x80, true);
  view.setUint32(116, 60, true);

  const fixups = 0x80;
  view.setUint32(fixups, 0, true); // version
  view.setUint32(fixups + 4, 28, true); // starts-in-image
  view.setUint32(fixups + 8, 28, true); // no imports
  view.setUint32(fixups + 12, 28, true); // no symbols
  view.setUint32(fixups + 16, 0, true);
  view.setUint32(fixups + 20, 1, true);
  view.setUint32(fixups + 24, 0, true);
  view.setUint32(fixups + 28, 1, true); // one segment
  view.setUint32(fixups + 32, 8, true); // starts record follows
  view.setUint32(fixups + 36, 24, true);
  view.setUint16(fixups + 40, 0x1000, true);
  view.setUint16(fixups + 42, 4, true); // DYLD_CHAINED_PTR_32_CACHE
  view.setBigUint64(fixups + 44, 0n, true); // segment offset from image base
  view.setUint32(fixups + 52, 0, true);
  view.setUint16(fixups + 56, 1, true);
  view.setUint16(fixups + 58, 0, true);
  view.setUint32(0x100, 0x2345, true); // next=0, cache-relative target
  return bytes;
}

function chainedFixture(raw, pointerFormat, { dyldCache = null } = {}) {
  const bytes = new Uint8Array(0x1200);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, 28, true);
  view.setUint32(28, 1, true);
  view.setUint32(32, 8, true);
  view.setUint32(36, 24, true);
  view.setUint16(40, 0x1000, true);
  view.setUint16(42, pointerFormat, true);
  view.setBigUint64(44, 0x1000n, true);
  view.setUint32(52, 0, true);
  view.setUint16(56, 1, true);
  view.setUint16(58, 0, true);
  if ([3, 4, 5].includes(pointerFormat)) view.setUint32(0x100, Number(raw), true);
  else view.setBigUint64(0x100, raw, true);
  const segment = { name: '__DATA', address: 0x2000n, size: 0x1000n, fileOffset: 0x100n, fileSize: 0x1000n };
  const image = {
    arch: 'arm64e',
    imageBase: 0x1000n,
    segments: [segment],
    metadata: {
      chainedFixups: { version: 0, complete: true, importsComplete: true },
      binaryIdentity: dyldCache?.binaryIdentity ?? 'unbound-binary',
      sliceIdentity: dyldCache?.sliceIdentity ?? 'unbound-slice',
      ...(dyldCache ? { dyldCache } : {}),
    },
    warnings: [],
    addressToOffset(address) {
      return address >= segment.address && address < segment.address + segment.fileSize
        ? segment.fileOffset + (address - segment.address)
        : null;
    },
  };
  const imports = [{ name: '_target', sites: [] }];
  parseChainedBindingSites(new ByteView(bytes), { offset: 0, size: 0x80 }, image, imports, [segment]);
  return { image, imports };
}

// Known 32/64-bit formats retain format-specific bind/rebase layouts.
{
  const generic32 = decodeChainedPointer((5n << 26n) | 0x12345n, 3, 0x1000n);
  assert.deepEqual({ bind: generic32.bind, target: generic32.target, next: generic32.next }, { bind: false, target: 0x12345n, next: 5 });
  const issuedCache = parseDyldSharedCache(cacheFixture());
  const cache32 = decodeChainedPointer((2n << 30n) | 0x2345n, 4, 0x100000000n, {
    dyldCache: issuedCache,
    binaryIdentity: issuedCache.binaryIdentity,
    sliceIdentity: issuedCache.sliceIdentity,
    architecture: 'arm64e',
  });
  assert.deepEqual({ bind: cache32.bind, target: cache32.target, targetOffset: cache32.targetOffset, next: cache32.next }, { bind: false, target: 0x180002345n, targetOffset: 0x2345n, next: 2 });
  assert.equal(cache32.target, 0x180002345n, 'format 4 target is shared-cache-base-relative');
  assert.equal(cache32.storageWidth, 4);
  assert.equal(decodeChainedPointer(0x2345n, 4, 0x100000000n).target, null, 'format 4 stays unresolved without an authoritative cache base');
  const clonedCache = structuredClone(issuedCache);
  assert.equal(decodeChainedPointer(0x2345n, 4, 0x100000000n, {
    dyldCache: clonedCache,
    binaryIdentity: issuedCache.binaryIdentity,
    sliceIdentity: issuedCache.sliceIdentity,
    architecture: 'arm64e',
  }).target, null, 'a cloned public cache shape has no cache-base authority');
  assert.equal(decodeChainedPointer(0x2345n, 4, 0x100000000n, { cacheBase: 0x180000000n }).target, null, 'a caller-supplied cache base has no authority');
  const firmware32 = decodeChainedPointer((17n << 26n) | 0x3456n, 5, 0n);
  assert.deepEqual({ bind: firmware32.bind, target: firmware32.target, next: firmware32.next }, { bind: false, target: 0x3456n, next: 17 });
  const expected64 = new Map([
    [1, { target: 0x2345n, stride: 8 }],
    [2, { target: 0x2345n, stride: 4 }],
    [6, { target: 0x100002345n, stride: 4 }],
    [7, { target: 0x100002345n, stride: 4 }],
    [9, { target: 0x100002345n, stride: 8 }],
    [10, { target: 0x2345n, stride: 4 }],
    [12, { target: 0x100002345n, stride: 8 }],
  ]);
  for (const [format, expected] of expected64) {
    const decoded = decodeChainedPointer(0x2345n, format, 0x100000000n);
    assert.equal(decoded.bind, false, `format ${format} must retain rebase semantics`);
    assert.equal(decoded.target, expected.target, `format ${format} must retain its coordinate system`);
    assert.equal(decoded.stride, expected.stride, `format ${format} must retain its ABI stride`);
    assert.equal(decoded.storageWidth, 8, `format ${format} must retain storage width separately from stride`);
  }
  assert.equal(decodeChainedPointer(0n, 8, 0n), null, 'unknown pointer layout must stay unknown');
  assert.equal(decodeChainedPointer(0x100000000n, 4, 0n), null, '32-bit format must reject a 33-bit raw word');
  assert.equal(decodeChainedPointer(-1n, 2, 0n), null, 'negative raw words must be rejected');
  assert.equal(decodeChainedPointer({ valueOf() { throw new Error('must-not-run'); } }, 2, 0n), null, 'pointer words are never coerced');
  assert.equal(decodeChainedPointer(0x3fffffffn, 6, 0xffffffffffffffffn), null, 'base-plus-offset overflow must be rejected');

  const unresolvedCache = chainedFixture(0x2345n, 4);
  assert.equal(unresolvedCache.image.metadata.chainedFixups.bindingSitesComplete, false);
  assert.equal(chainedPointerSites(unresolvedCache.image)[0].target, null);
  const authoritativeCache = chainedFixture(0x2345n, 4, {
    dyldCache: issuedCache,
  });
  assert.equal(authoritativeCache.image.metadata.chainedFixups.bindingSitesComplete, true);
  assert.equal(chainedPointerSites(authoritativeCache.image)[0].target, 0x180002345n);

  // Exercise the production Mach-O loader, not only the direct chained-site helper.
  const productionImage = parseMachO(machoWithFormat4ChainedFixup(), { dyldCache: issuedCache });
  assert.equal(productionImage.arch, 'arm64e');
  assert.equal(productionImage.metadata.chainedFixups.bindingSitesComplete, true);
  assert.equal(chainedPointerSites(productionImage)[0].target, 0x180002345n);
  assert.equal(machOImageAuthority(productionImage).dyldCache, issuedCache);
  assert.equal(buildAppleKnowledge({ image: productionImage, dyldCache: issuedCache }).cells.dyldCache.status, 'supported');

  const forgedProductionImage = parseMachO(machoWithFormat4ChainedFixup(), {
    dyldCache: structuredClone(issuedCache),
  });
  assert.equal(forgedProductionImage.metadata.chainedFixups.bindingSitesComplete, false);
  assert.equal(chainedPointerSites(forgedProductionImage)[0].target, null, 'a forged public cache cannot resolve a production format-4 site');

  const mismatchedCache = parseDyldSharedCache(cacheFixture({ architecture: 'x86_64' }));
  const mismatchedProductionImage = parseMachO(machoWithFormat4ChainedFixup(), { dyldCache: mismatchedCache });
  assert.equal(mismatchedProductionImage.metadata.chainedFixups.bindingSitesComplete, false);
  assert.equal(chainedPointerSites(mismatchedProductionImage)[0].target, null, 'a parser-issued cache for another architecture cannot resolve a format-4 site');
  assert.notEqual(buildAppleKnowledge({ image: mismatchedProductionImage, dyldCache: mismatchedCache }).cells.dyldCache.status, 'supported');
}

// arm64e authentication fields stay separate from ordinal/raw/target identity.
let authenticatedImage;
{
  const raw = (1n << 63n) | (1n << 62n) | (0x1234n << 32n) | (1n << 48n) | (2n << 49n);
  const { image, imports } = chainedFixture(raw, 12);
  authenticatedImage = image;
  assert.equal(imports[0].sites[0].authenticated, true);
  assert.deepEqual(imports[0].sites[0].authentication, { diversity: 0x1234, addressDiversity: true, key: 'DA' });
  const sites = chainedPointerSites(image);
  assert.equal(sites.length, 1);
  assert.equal(sites[0].semantics, 'bind');
  assert.equal(sites[0].ordinal, 0);
  assert.equal(sites[0].target, null);
  assert.equal(sites[0].raw, raw);
  assert.equal(sites[0].address, 0x2000n);
  assert.equal(sites[0].fileOffset, 0x100n);
  assert.equal(sites[0].storageWidth, 8);
  assert.deepEqual(sites[0].authentication, { diversity: 0x1234, addressDiversity: true, key: 'DA' });
}

// Duplicate chain starts retain both candidates and block single-site resolution.
{
  const bytes = new Uint8Array(0x1200);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, 28, true);
  view.setUint32(28, 1, true);
  view.setUint32(32, 8, true);
  view.setUint32(36, 28, true);
  view.setUint16(40, 0x1000, true);
  view.setUint16(42, 2, true);
  view.setBigUint64(44, 0x1000n, true);
  view.setUint16(56, 1, true);
  view.setUint16(58, 0x8000, true);
  view.setUint16(60, 0, true);
  view.setUint16(62, 0x8000, true);
  view.setBigUint64(0x100, 1n << 63n, true);
  const segment = { address: 0x2000n, size: 0x1000n, fileOffset: 0x100n, fileSize: 0x1000n };
  const image = {
    imageBase: 0x1000n, fileOffset: 0x4000n, segments: [segment],
    metadata: { chainedFixups: { complete: true } }, warnings: [],
    addressToOffset: (address) => segment.fileOffset + address - segment.address,
    segmentAt: (address) => address >= segment.address && address < segment.address + segment.size ? segment : null,
    sectionAt: () => null,
  };
  const imports = [{ name: '_duplicate', sites: [] }];
  const status = parseChainedBindingSites(new ByteView(bytes), { offset: 0, size: 0x80 }, image, imports, [segment]);
  const sites = chainedPointerSites(image);
  assert.equal(status.bindingSitesComplete, false);
  assert.equal(sites.length, 2);
  assert.ok(sites.every((site) => site.ambiguous && site.candidateCount === 2));
  assert.ok(sites.every((site) => site.fileOffset === 0x4100n && site.sliceFileOffset === 0x100n));
  assert.equal(resolveMachOPointer(image, 1n << 63n, { address: 0x2000n }), null);
}

// Shared-cache header/mapping parsing is exact and overlap is ambiguity, not selection.
{
  const cache = parseDyldSharedCache(cacheFixture(), {
    binaryIdentity: 'sha256:cache',
    sliceIdentity: 'thin:arm64e:cache',
    sourceOffset: 0x4000n,
  });
  assert.equal(cache.status, 'supported');
  assert.equal(cache.architecture, 'arm64e');
  assert.equal(cache.mappings.length, 2);
  assert.equal(cache.mappings[0].provenance.tableOffset, 0x4068n);
  assert.equal(cache.mappings[1].fileOffset, 0x1c0n);
  assert.equal(parseDyldSharedCache(cacheFixture()).status, 'supported', 'resident cache identity is derived from exact bytes');
  assert.notEqual(cache.binaryIdentity, 'sha256:cache', 'caller digest labels never replace parser-derived identity');

  const overlap = parseDyldSharedCache(cacheFixture({ overlap: true }), { binaryIdentity: 'sha256:cache' });
  assert.equal(overlap.status, 'ambiguous');
  assert.deepEqual(overlap.ambiguities[0].candidates, [0, 1]);
  assert.equal(overlap.mappings.length, 2);

  const unknown = new Uint8Array(104);
  setAscii(unknown, 0, 'dyld_v2  arm64e', 16);
  assert.equal(parseDyldSharedCache(unknown).status, 'unsupported');
  assert.equal(parseDyldSharedCache(cacheFixture({ mappingCount: 4097 })).status, 'malformed');
  assert.equal(parseDyldSharedCache(cacheFixture({ truncate: true })).status, 'malformed');
  assert.equal(parseDyldSharedCache(cacheFixture(), { sourceOffset: { valueOf() { throw new Error('must-not-run'); } } }).status, 'malformed');

  const overflow = cacheFixture({ mappingCount: 1 });
  new DataView(overflow.buffer).setBigUint64(120, 0xfffffffffffffff0n, true);
  assert.equal(parseDyldSharedCache(overflow).status, 'malformed');
}

// SuperBlob and CodeDirectory parsing is big-endian, bounded, and structural only.
let signature;
{
  signature = parseAppleCodeSignature(codeSignatureFixture(), { dataOffset: 0, commandOffset: 0x20n, containerOffset: 0x1000n });
  assert.equal(signature.status, 'structurally-valid');
  assert.equal(signature.validity, 'unknown');
  assert.equal(signature.authoritativeValidation, null);
  assert.equal(signature.codeDirectories[0].identifier, 'app');
  assert.equal(signature.codeDirectories[0].codeLimit, 0x30n);
  assert.equal(signature.provenance.commandOffset, 0x20n);
  assert.equal(signature.provenance.dataOffset, 0x1000n);

  const v23 = parseAppleCodeSignature(codeSignatureFixture({ version: 0x20300, codeLimit: 0x20, codeLimit64: 0x3000n }));
  assert.equal(v23.status, 'structurally-valid');
  assert.equal(v23.codeDirectories[0].codeLimit32, 0x20n);
  assert.equal(v23.codeDirectories[0].codeLimit64, 0x3000n);
  assert.equal(v23.codeDirectories[0].codeLimit, 0x3000n);
  assert.equal(assessAppleSigningImpact(v23, [{ offset: 0x2000n, size: 1 }]).state, 'invalidated-requires-resigning');

  const wrongEndian = codeSignatureFixture();
  new DataView(wrongEndian.buffer).setUint32(0, 0xfade0cc0, true);
  assert.equal(parseAppleCodeSignature(wrongEndian).status, 'unsupported');

  const truncated = codeSignatureFixture();
  new DataView(truncated.buffer).setUint32(4, truncated.length + 1, false);
  assert.equal(parseAppleCodeSignature(truncated).status, 'malformed');
  assert.equal(parseAppleCodeSignature(codeSignatureFixture({ duplicateBlob: true })).status, 'malformed');
  assert.equal(parseAppleCodeSignature(codeSignatureFixture(), { containerOffset: { valueOf() { throw new Error('must-not-run'); } } }).status, 'malformed');
  const future = codeSignatureFixture();
  new DataView(future.buffer).setUint32(28, 0x20700, false);
  assert.equal(parseAppleCodeSignature(future).status, 'unsupported');

  assert.equal(parseAppleCodeSignature(codeSignatureFixture({ pageSizeLog2: 0 })).status, 'structurally-valid', 'pageSize zero denotes one infinite code page');
  assert.equal(parseAppleCodeSignature(codeSignatureFixture({ hashType: 99 })).status, 'unsupported', 'unknown hash algorithms stay unsupported');
  assert.equal(parseAppleCodeSignature(codeSignatureFixture({ hashType: 2, hashSize: 20 })).status, 'malformed', 'known hash algorithms require their ABI hash width');
  assert.equal(parseAppleCodeSignature(codeSignatureFixture({ spare2: 1 })).status, 'malformed', 'reserved spare2 must be zero');
  assert.equal(parseAppleCodeSignature(codeSignatureFixture({ version: 0x20300, spare3: 1 })).status, 'malformed', 'reserved spare3 must be zero');
  for (const [version, fieldOffset, value] of [
    [0x20100, 44, 0xffffffff],
    [0x20200, 48, 0xffffffff],
    [0x20500, 92, 0xffffffff],
    [0x20600, 100, 0xffffffff],
  ]) {
    const malformedVersionField = codeSignatureFixture({ version });
    const directoryOffset = 20;
    new DataView(malformedVersionField.buffer).setUint32(directoryOffset + fieldOffset, value, false);
    assert.equal(parseAppleCodeSignature(malformedVersionField).status, 'malformed', `version 0x${version.toString(16)} offsets stay bounded`);
  }
}

// Canonical Mach-O parsing retains exact LC_CODE_SIGNATURE provenance without a validity claim.
{
  const image = parseMachO(machoWithCodeSignature());
  assert.equal(image.metadata.codeSignature.status, 'structurally-valid');
  assert.equal(image.metadata.codeSignature.provenance.commandOffset, 0x20n);
  assert.equal(image.metadata.codeSignature.provenance.dataOffset, 0x30n);
  assert.equal(image.metadata.codeSignature.validity, 'unknown');

  const malformedCommand = parseMachO(machoWithCodeSignature({ commandSize: 8 }));
  assert.equal(malformedCommand.metadata.codeSignature.status, 'malformed');
  assert.equal(malformedCommand.metadata.codeSignature.complete, false);
  assert.ok(malformedCommand.metadata.machoMetadata.reasons.includes('code-signature-command-malformed'));

  const tooShortCommand = parseMachO(machoWithCodeSignature({ commandSize: 4 }));
  assert.equal(tooShortCommand.metadata.codeSignature.status, 'malformed');
  assert.equal(tooShortCommand.metadata.codeSignature.complete, false);
  assert.equal(tooShortCommand.metadata.codeSignatureCommandsComplete, false);

  const truncatedTable = machoWithCodeSignature({ commandSize: 8 });
  new DataView(truncatedTable.buffer).setUint32(16, 2, true);
  const truncatedCommands = parseMachO(truncatedTable, {
    binaryIdentity: 'sha256:truncated',
    sliceIdentity: 'thin:arm64e:truncated',
  });
  assert.equal(truncatedCommands.metadata.codeSignature.status, 'malformed');
  assert.equal(truncatedCommands.metadata.codeSignatureCommandsComplete, false);
  const poisonedMatrix = buildAppleKnowledge({
    image: truncatedCommands,
    binaryIdentity: machOImageAuthority(truncatedCommands).binaryIdentity,
    sliceIdentity: machOImageAuthority(truncatedCommands).sliceIdentity,
  });
  assert.notEqual(poisonedMatrix.cells.codeSigning.status, 'absent');
  assert.equal(poisonedMatrix.cells.codeSigning.complete, false);

  const hiddenCommand = machoWithCodeSignature();
  new DataView(hiddenCommand.buffer).setUint32(16, 0, true);
  const hiddenSignature = parseMachO(hiddenCommand, {
    binaryIdentity: 'sha256:hidden',
    sliceIdentity: 'thin:arm64e:hidden',
  });
  assert.equal(hiddenSignature.metadata.codeSignature.status, 'malformed');
  assert.equal(hiddenSignature.metadata.codeSignatureCommandsComplete, false);
  let offsetCoerced = false;
  assert.throws(() => parseMachO(machoWithCodeSignature(), {
    containerOffset: { valueOf() { offsetCoerced = true; return 0; } },
  }), /container offset/);
  assert.equal(offsetCoerced, false, 'Mach-O structured offsets are never coerced');

  const thin = machoWithCodeSignature({ signatureOffset: 0x100 });
  const container = fatMachO(thin);
  const residentFat = parseMachO(container, { arch: 'arm64e' });
  assert.equal(residentFat.metadata.codeSignature.status, 'structurally-valid');
  assert.equal(residentFat.metadata.codeSignature.provenance.commandOffset, 0x120n);
  assert.equal(residentFat.metadata.codeSignature.provenance.dataOffset, 0x200n);
  const sourceFat = await parseMachOSource(new MemoryByteSource(container, { maxReadLength: 128 }), { sliceIndex: 0 }, null, {
    pageSize: 16, maxPageSize: 128, maxCachedBytes: 4096, maxReads: 128,
  });
  assert.equal(sourceFat.metadata.codeSignature.status, 'structurally-valid');
  assert.equal(sourceFat.metadata.codeSignature.provenance.commandOffset, 0x120n);
  assert.equal(sourceFat.metadata.codeSignature.provenance.dataOffset, 0x200n);
  assert.ok(sourceFat.metadata.sourceReads.largestRead <= 128);
  assert.ok(sourceFat.metadata.sourceReads.cachedBytes < thin.length, 'source parser need not materialize the whole signed slice');
  const sourceMatrix = buildAppleKnowledge({ image: sourceFat });
  assert.equal(sourceMatrix.identity.authoritative, false, 'bounded sparse reads do not fabricate whole-binary identity');
  assert.equal(sourceMatrix.cells.codeSigning.status, 'unknown');
  const sourceSwift = await probeAppleLanguageMetadata(sourceFat, 'swift');
  const sourceSwiftCell = buildAppleKnowledge({ image: sourceFat, swift: sourceSwift }).cells.swift;
  assert.equal(sourceSwiftCell.status, 'partial');
  assert.equal(sourceSwiftCell.complete, false, 'a sparse image without canonical resident content cannot prove language absence');
}

// Missing starts metadata and an early budget stop conservatively own every possibly chained segment.
{
  const segments = [
    { address: 0x2000n, size: 0x1000n, fileOffset: 0x100n, fileSize: 0x1000n },
    { address: 0x3000n, size: 0x1000n, fileOffset: 0x1100n, fileSize: 0x1000n },
  ];
  const imageFor = () => ({
    imageBase: 0x1000n, segments, fileOffset: 0n,
    metadata: { chainedFixups: { complete: true } }, warnings: [],
    segmentAt(value) { return segments.find((segment) => value >= segment.address && value < segment.address + segment.size) || null; },
    sectionAt() { return null; },
    addressToOffset(value) { const segment = this.segmentAt(value); return segment ? segment.fileOffset + value - segment.address : null; },
  });
  const missingBytes = new Uint8Array(64);
  const missingImage = imageFor();
  parseChainedBindingSites(new ByteView(missingBytes), { offset: 0, size: missingBytes.length }, missingImage, [], segments);
  assert.equal(resolveMachOPointer(missingImage, 0x2000n, { address: 0x3000n }), null);

  const bytes = new Uint8Array(0x2200);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, 28, true);
  view.setUint32(28, 2, true);
  view.setUint32(32, 12, true);
  view.setUint32(36, 36, true);
  for (const [record, segmentOffset] of [[40, 0x1000n], [64, 0x2000n]]) {
    view.setUint32(record, 24, true); view.setUint16(record + 4, 0x1000, true); view.setUint16(record + 6, 2, true);
    view.setBigUint64(record + 8, segmentOffset, true); view.setUint16(record + 20, 1, true); view.setUint16(record + 22, 0, true);
  }
  const budgetImage = imageFor();
  parseChainedBindingSites(new ByteView(bytes), { offset: 0, size: 0x80 }, budgetImage, [], segments, { take: () => false });
  assert.equal(resolveMachOPointer(budgetImage, 0x2000n, { address: 0x3000n }), null, 'later segment stays loader-owned after an earlier budget exit');

  const shortenedBytes = new Uint8Array(0x2200);
  const shortenedView = new DataView(shortenedBytes.buffer);
  shortenedView.setUint32(4, 28, true);
  shortenedView.setUint32(28, 1, true);
  shortenedView.setUint32(32, 8, true);
  shortenedView.setUint32(36, 24, true);
  shortenedView.setUint16(40, 0x1000, true);
  shortenedView.setUint16(42, 2, true);
  shortenedView.setBigUint64(44, 0x1000n, true);
  shortenedView.setUint16(56, 1, true);
  shortenedView.setUint16(58, 0xffff, true);
  const shortenedSegment = { address: 0x2000n, size: 0x2000n, fileOffset: 0x100n, fileSize: 0x2000n };
  const shortenedImage = {
    imageBase: 0x1000n, segments: [shortenedSegment], fileOffset: 0n,
    metadata: { chainedFixups: { complete: true } }, warnings: [],
    segmentAt: (value) => value >= 0x2000n && value < 0x4000n ? shortenedSegment : null,
    sectionAt: () => null,
    addressToOffset: (value) => 0x100n + value - 0x2000n,
  };
  const shortenedStatus = parseChainedBindingSites(new ByteView(shortenedBytes), { offset: 0, size: 0x80 }, shortenedImage, [], [shortenedSegment]);
  assert.equal(shortenedStatus.bindingSitesComplete, false);
  assert.match(shortenedStatus.bindingSiteReasons.join('\n'), /page_count.*cover segment/);
  assert.equal(resolveMachOPointer(shortenedImage, 0x3000n, { address: 0x3000n }), null, 'omitted chained pages remain loader-owned');
}

// Mutation consequences never become a signing-valid claim.
{
  const covered = assessAppleSigningImpact(signature, [{ offset: 8n, size: 4 }]);
  assert.equal(covered.state, 'invalidated-requires-resigning');
  assert.deepEqual(covered.coveredMutations[0].codeDirectories, [0]);
  assert.equal(covered.validity, 'unknown');
  const outside = assessAppleSigningImpact(signature, [{ offset: 0x100n, size: 1 }]);
  assert.equal(outside.state, 'authoritative-revalidation-required');
  assert.equal(outside.validity, 'unknown');
  assert.equal(assessAppleSigningImpact(signature, []).state, 'unchanged-signature-validity-unknown');
  assert.equal(assessAppleSigningImpact(signature, [{ offset: 4, before: [1], after: [2] }]).state, 'invalidated-requires-resigning');
  assert.equal(assessAppleSigningImpact(signature, [{ offset: 4, before: [1], after: [999] }]).state, 'blocked-mutation-bytes-invalid');
  assert.equal(assessAppleSigningImpact(signature, [{ offset: -1n, size: 1 }]).state, 'blocked-mutation-range-invalid');
  assert.equal(assessAppleSigningImpact(signature, [{ offset: 4n, size: '1' }]).state, 'blocked-mutation-range-invalid');
  assert.equal(assessAppleSigningImpact(signature, [{ offset: 4n, size: { valueOf() { throw new Error('must-not-run'); } } }]).state, 'blocked-mutation-range-invalid');
}

// Matrix assembly retains language verdicts, PAC metadata, exact identities and deterministic round-trip.
{
  authenticatedImage.metadata.codeSignature = signature;
  const swift = {
    providerId: 'metadata.swift', providerVersion: '1.0.0', authoritative: false,
    identity: { verdict: 'matched-partial', digest: 'swift:partial' },
    completeness: { present: true, complete: false, reasons: ['unresolved-symbolic-reference'] },
    counts: { types: 2 }, sections: ['__swift5_types'], diagnostics: [],
  };
  const objc = {
    providerId: 'metadata.objc', providerVersion: '1.0.0', authoritative: false,
    identity: { verdict: 'ambiguous', digest: 'objc:ambiguous' },
    completeness: { present: true, complete: true }, counts: { methods: 2 }, sections: ['__objc_classlist'], diagnostics: [],
  };
  const matrix = buildAppleKnowledge({
    image: authenticatedImage,
    binaryIdentity: 'sha256:macho',
    sliceIdentity: 'thin:arm64e:0:4608',
    swift,
    objc,
    dyldCache: parseDyldSharedCache(cacheFixture(), { binaryIdentity: 'sha256:cache' }),
    mutations: [{ offset: 4n, size: 4 }],
  });
  assert.equal(matrix.schema, APPLE_KNOWLEDGE_SCHEMA);
  assert.deepEqual(APPLE_KNOWLEDGE_FORMAT_MATRIX.chainedFixups.pointerFormats, [1, 2, 3, 4, 5, 6, 7, 9, 10, 12]);
  assert.equal(matrix.complete, false);
  assert.equal(matrix.identity.authoritative, false, 'caller identity strings cannot authorize a hand-built image');
  assert.equal(matrix.cells.swift.status, 'malformed');
  assert.equal(matrix.cells.objc.status, 'malformed');
  assert.equal(matrix.cells.pointerAuthentication.status, 'partial');
  assert.equal(matrix.cells.pointerAuthentication.complete, false);
  assert.equal(matrix.cells.pointerAuthentication.evidence.cryptographicValidation, 'not-performed');
  assert.equal(matrix.cells.codeSigning.evidence.validity, 'unknown');
  assert.equal(matrix.cells.codeSigning.complete, false);
  assert.ok(Object.isFrozen(matrix));
  assert.throws(() => serializeAppleKnowledge({ ...matrix }), /schema-invalid/, 'a cloned public shape has no serialization authority');
  const encoded = serializeAppleKnowledge(matrix);
  assert.equal(encoded, serializeAppleKnowledge(matrix));
  const reparsed = parseSerializedAppleKnowledge(encoded);
  assert.equal(reparsed.complete, false);
  assert.equal(reparsed.identity.authoritative, false);
  assert.equal(reparsed.cells.chainedFixups.status, 'unknown');
  assert.deepEqual(reparsed.cells.chainedFixups.evidence.sites, [], 'unissued image sites remain outside matrix evidence');
  assert.equal(reparsed.cells.dyldCache.evidence.mappings[0].provenance.tableOffset, 104n);
  assert.throws(() => parseSerializedAppleKnowledge(encoded.replace(APPLE_KNOWLEDGE_SCHEMA, 'hex-apple-knowledge/v2')), /contract-invalid/);
  assert.throws(() => parseSerializedAppleKnowledge('{"schema":'), /serialized-invalid/);
  const crafted = JSON.parse(encoded);
  crafted.complete = true;
  crafted.cells.swift.status = 'supported';
  crafted.cells.swift.complete = true;
  assert.throws(() => parseSerializedAppleKnowledge(JSON.stringify(crafted)), /contract-invalid/);

  const completeInMemory = buildAppleKnowledge({ binaryIdentity: 'sha256:empty', sliceIdentity: 'thin:empty' });
  assert.equal(completeInMemory.complete, false);
  assert.equal(completeInMemory.identity.authoritative, false);
  assert.ok(Object.values(completeInMemory.cells).every((value) => value.complete === false));
  const serializedComplete = JSON.parse(serializeAppleKnowledge(completeInMemory));
  assert.equal(serializedComplete.complete, false);
  assert.equal(serializedComplete.identity.authoritative, false);
  assert.ok(Object.values(serializedComplete.cells).every((value) => value.status === 'unknown' && value.complete === false));

  const futureProvider = buildAppleKnowledge({
    image: authenticatedImage,
    binaryIdentity: 'sha256:macho',
    sliceIdentity: 'thin:arm64e:0:4608',
    swift: { ...swift, providerVersion: '2.0.0', authoritative: true, completeness: { present: true, complete: true } },
    dyldCache: { status: 'supported', complete: true, reasons: [] },
  });
  assert.equal(futureProvider.cells.swift.status, 'malformed');
  assert.equal(futureProvider.cells.dyldCache.status, 'malformed');

  const issuedSignedImage = parseMachO(machoWithCodeSignature(), {
    binaryIdentity: 'sha256:macho',
    sliceIdentity: 'thin:arm64e:0:signed',
  });
  const issuedSigned = buildAppleKnowledge({
    image: issuedSignedImage,
  });
  assert.notEqual(machOImageAuthority(issuedSignedImage).binaryIdentity, 'sha256:macho');
  assert.equal(issuedSigned.identity.authoritative, true);
  assert.equal(issuedSigned.cells.codeSigning.status, 'supported');
  assert.equal(issuedSigned.cells.codeSigning.complete, true);
  assert.equal(issuedSigned.cells.swift.status, 'unknown');
  assert.equal(buildAppleKnowledge({
    image: issuedSignedImage,
    binaryIdentity: 'sha256:macho',
    sliceIdentity: 'thin:arm64e:0:signed',
  }).identity.authoritative, false, 'caller digest labels cannot authorize an issued image');

  const emptyThin = new Uint8Array(32);
  const emptyView = new DataView(emptyThin.buffer);
  emptyView.setUint32(0, 0xfeedfacf, true);
  emptyView.setUint32(4, 0x0100000c, true);
  emptyView.setUint32(8, 2, true);
  emptyView.setUint32(12, 1, true);
  const issuedEmptyImage = parseMachO(emptyThin, {
    binaryIdentity: 'sha256:empty',
    sliceIdentity: 'thin:arm64e:0:32',
  });
  const issuedAbsence = buildAppleKnowledge({
    image: issuedEmptyImage,
  });
  assert.equal(issuedAbsence.cells.codeSigning.status, 'absent');
  assert.equal(issuedAbsence.cells.codeSigning.complete, true);
  assert.equal(issuedAbsence.cells.chainedFixups.status, 'absent');
  assert.equal(issuedAbsence.cells.chainedFixups.complete, true);

  const partialChainedBytes = new Uint8Array(56);
  const partialChainedView = new DataView(partialChainedBytes.buffer);
  partialChainedView.setUint32(0, 0xfeedfacf, true);
  partialChainedView.setUint32(4, 0x0100000c, true);
  partialChainedView.setUint32(8, 2, true);
  partialChainedView.setUint32(12, 1, true);
  partialChainedView.setUint32(16, 1, true);
  partialChainedView.setUint32(20, 16, true);
  partialChainedView.setUint32(32, 0x80000034, true);
  partialChainedView.setUint32(36, 16, true);
  partialChainedView.setUint32(40, 48, true);
  partialChainedView.setUint32(44, 8, true);
  const partialChainedMatrix = buildAppleKnowledge({ image: parseMachO(partialChainedBytes) });
  assert.equal(partialChainedMatrix.cells.chainedFixups.complete, false);
  assert.notEqual(partialChainedMatrix.cells.pointerAuthentication.status, 'absent', 'partial chained coverage cannot prove PAC absence');
  assert.equal(partialChainedMatrix.cells.pointerAuthentication.complete, false);

  const laterIdentity = buildAppleKnowledge({
    image: parseMachO(emptyThin),
    binaryIdentity: 'sha256:empty',
    sliceIdentity: 'thin:arm64e:0:32',
  });
  assert.equal(laterIdentity.identity.authoritative, false, 'identity cannot be added after parsing');
  assert.equal(laterIdentity.cells.codeSigning.status, 'unknown');

  const issuedEmptyAuthority = machOImageAuthority(issuedEmptyImage);
  const forgedResult = (providerId, counts) => ({
    providerId,
    providerVersion: '1.0.0',
    authoritative: true,
    identity: {
      verdict: 'matched-authoritative',
      binaryIdentity: issuedEmptyAuthority.binaryIdentity,
      architecture: issuedEmptyAuthority.architecture,
    },
    completeness: { present: true, complete: true, reasons: [] },
    counts,
    sections: providerId === 'metadata.swift' ? ['__swift5_types'] : ['__objc_classlist'],
    diagnostics: [],
  });
  const originalSwiftProbe = SwiftMetadataProvider.prototype.probe;
  const originalObjcProbe = ObjcMetadataProvider.prototype.probe;
  const originalSwiftSectionsDescriptor = Object.getOwnPropertyDescriptor(SwiftMetadataProvider.prototype, 'sections');
  const originalObjcSectionsDescriptor = Object.getOwnPropertyDescriptor(ObjcMetadataProvider.prototype, 'sections');
  const originalSwiftCallDescriptor = Object.getOwnPropertyDescriptor(originalSwiftProbe, 'call');
  const originalObjcCallDescriptor = Object.getOwnPropertyDescriptor(originalObjcProbe, 'call');
  let inheritedSetterRuns = 0;
  let forgedCallRuns = 0;
  let forgedCallbackRuns = 0;
  try {
    Object.defineProperty(SwiftMetadataProvider.prototype, 'sections', {
      configurable: true,
      set() {
        inheritedSetterRuns++;
        Object.defineProperty(this, 'probe', { value: async () => forgedResult('metadata.swift', { types: 3000 }) });
      },
    });
    Object.defineProperty(ObjcMetadataProvider.prototype, 'sections', {
      configurable: true,
      set() {
        inheritedSetterRuns++;
        Object.defineProperty(this, 'probe', { value: async () => forgedResult('metadata.objc', { types: 3000 }) });
      },
    });
    Object.defineProperty(originalSwiftProbe, 'call', { configurable: true, value() { forgedCallRuns++; return forgedResult('metadata.swift', { types: 2001 }); } });
    Object.defineProperty(originalObjcProbe, 'call', { configurable: true, value() { forgedCallRuns++; return forgedResult('metadata.objc', { types: 2001 }); } });
    SwiftMetadataProvider.prototype.probe = async function forgedSwiftProbe() {
      SwiftMetadataProvider.prototype.probe = async () => forgedResult('metadata.swift', { types: 1000 });
      Object.defineProperty(this, 'probe', { value: async () => forgedResult('metadata.swift', { types: 1001 }) });
      return forgedResult('metadata.swift', { types: 999 });
    };
    const forgedObjcCallback = async () => {
      forgedCallbackRuns++;
      return forgedResult('metadata.objc', { types: 999, methods: 999 });
    };
    ObjcMetadataProvider.prototype.probe = forgedObjcCallback;
    const swiftPrototypeAttack = buildAppleKnowledge({
      image: issuedEmptyImage,
      swift: await probeAppleLanguageMetadata(issuedEmptyImage, 'swift'),
    }).cells.swift;
    const objcPrototypeAttack = buildAppleKnowledge({
      image: issuedEmptyImage,
      objc: await probeAppleLanguageMetadata(issuedEmptyImage, 'objc'),
    }).cells.objc;
    assert.equal(swiftPrototypeAttack.status, 'absent', 'exported Swift prototype replacement cannot mint canonical presence');
    assert.equal(swiftPrototypeAttack.evidence.counts.types ?? 0, 0);
    assert.equal(objcPrototypeAttack.status, 'absent', 'exported ObjC prototype replacement cannot mint canonical presence');
    assert.equal(objcPrototypeAttack.evidence.counts.types ?? 0, 0);
    let proxyGetterRuns = 0;
    SwiftMetadataProvider.prototype.probe = async () => new Proxy(forgedResult('metadata.swift', { types: 2000 }), {
      get(target, key, receiver) {
        proxyGetterRuns++;
        return Reflect.get(target, key, receiver);
      },
    });
    const proxyResultAttack = buildAppleKnowledge({
      image: issuedEmptyImage,
      swift: await probeAppleLanguageMetadata(issuedEmptyImage, 'swift'),
    }).cells.swift;
    assert.equal(proxyResultAttack.status, 'absent');
    assert.equal(proxyGetterRuns, 0, 'canonical issuance never inspects a prototype-injected proxy result');
    assert.equal(inheritedSetterRuns, 0, 'canonical probe contexts do not inherit exported provider setters');
    assert.equal(forgedCallRuns, 0, 'canonical invocation does not trust a mutable function.call property');
    assert.equal(forgedCallbackRuns, 0, 'caller callback results cannot enter canonical issuance');
  } finally {
    SwiftMetadataProvider.prototype.probe = originalSwiftProbe;
    ObjcMetadataProvider.prototype.probe = originalObjcProbe;
    if (originalSwiftSectionsDescriptor) Object.defineProperty(SwiftMetadataProvider.prototype, 'sections', originalSwiftSectionsDescriptor);
    else delete SwiftMetadataProvider.prototype.sections;
    if (originalObjcSectionsDescriptor) Object.defineProperty(ObjcMetadataProvider.prototype, 'sections', originalObjcSectionsDescriptor);
    else delete ObjcMetadataProvider.prototype.sections;
    if (originalSwiftCallDescriptor) Object.defineProperty(originalSwiftProbe, 'call', originalSwiftCallDescriptor);
    else delete originalSwiftProbe.call;
    if (originalObjcCallDescriptor) Object.defineProperty(originalObjcProbe, 'call', originalObjcCallDescriptor);
    else delete originalObjcProbe.call;
  }

  const issuedSwiftAbsence = await probeAppleLanguageMetadata(issuedEmptyImage, 'swift');
  const issuedObjcAbsence = await probeAppleLanguageMetadata(issuedEmptyImage, 'objc');
  const languageAbsence = buildAppleKnowledge({
    image: issuedEmptyImage,
    swift: issuedSwiftAbsence,
    objc: issuedObjcAbsence,
  });
  assert.equal(languageAbsence.cells.swift.status, 'absent');
  assert.equal(languageAbsence.cells.swift.complete, true);
  assert.notEqual(languageAbsence.cells.swift.status, 'supported');
  assert.equal(languageAbsence.cells.objc.status, 'absent');
  assert.equal(languageAbsence.cells.objc.complete, true);
  const incompleteCommandBytes = machoWithCodeSignature({ commandSize: 8 });
  new DataView(incompleteCommandBytes.buffer).setUint32(16, 2, true);
  const incompleteCommandImage = parseMachO(incompleteCommandBytes);
  const incompleteLanguage = await probeAppleLanguageMetadata(incompleteCommandImage, 'swift');
  assert.equal(buildAppleKnowledge({ image: incompleteCommandImage, swift: incompleteLanguage }).cells.swift.status, 'partial');
  const clonedLanguage = buildAppleKnowledge({
    image: issuedEmptyImage,
    swift: structuredClone(issuedSwiftAbsence),
  });
  assert.equal(clonedLanguage.cells.swift.status, 'malformed');
  assert.equal(clonedLanguage.cells.swift.complete, false);
  const sameBytesOtherImage = parseMachO(emptyThin.slice());
  const reboundLanguage = buildAppleKnowledge({ image: sameBytesOtherImage, swift: issuedSwiftAbsence });
  assert.equal(reboundLanguage.cells.swift.status, 'partial', 'issued provider evidence cannot move to another image instance');
  assert.equal(reboundLanguage.cells.swift.complete, false);

  const issuedSwiftImage = parseMachO(machoWithMetadataSection('__swift5_types', { swiftDescriptor: true }));
  const issuedSwiftAuthority = machOImageAuthority(issuedSwiftImage);
  assert.equal(await issuedSwiftAuthority.createMetadataSource().readAt(0x2000n, 1024 * 1024 + 1), null, 'canonical provider reads have a fixed allocation ceiling');
  const missingReader = new SwiftMetadataProvider({
    binaryIdentity: issuedSwiftAuthority.binaryIdentity,
    architecture: issuedSwiftAuthority.architecture,
    sections: issuedSwiftImage.sections,
  });
  const missingReaderResult = await missingReader.probe();
  assert.equal(missingReaderResult.completeness.present, true, 'an advertised Swift section without a reader is partial, not absent');
  assert.equal(missingReaderResult.completeness.complete, false);
  assert.equal(buildAppleKnowledge({ image: issuedSwiftImage, swift: missingReaderResult }).cells.swift.complete, false);
  await assert.rejects(() => probeAppleLanguageMetadata(missingReader, { image: issuedSwiftImage }), /image-unissued/);

  const copiedSections = issuedSwiftImage.sections.map((section) => ({ ...section }));
  const customReader = new SwiftMetadataProvider({
    binaryIdentity: issuedSwiftAuthority.binaryIdentity,
    architecture: issuedSwiftAuthority.architecture,
    sections: copiedSections,
    readAt: async () => new Uint8Array(64),
  });
  await assert.rejects(() => probeAppleLanguageMetadata(customReader, { image: issuedSwiftImage }), /image-unissued/);
  class SwiftSubclass extends SwiftMetadataProvider {
    async probe() { return forgedResult('metadata.swift', { types: 999 }); }
  }
  const subclass = new SwiftSubclass({
    binaryIdentity: issuedSwiftAuthority.binaryIdentity,
    architecture: issuedSwiftAuthority.architecture,
    sections: copiedSections,
    readAt: async () => new Uint8Array(64),
  });
  await assert.rejects(() => probeAppleLanguageMetadata(subclass, { image: issuedSwiftImage }), /image-unissued/);
  const issuedSwiftResult = await probeAppleLanguageMetadata(issuedSwiftImage, 'swift');
  const presentSwift = buildAppleKnowledge({ image: issuedSwiftImage, swift: issuedSwiftResult });
  assert.equal(issuedSwiftResult.completeness.present, true);
  assert.notEqual(presentSwift.cells.swift.status, 'absent');

  const issuedObjcImage = parseMachO(machoWithMetadataSection('__objc_data'));
  const issuedObjcAuthority = machOImageAuthority(issuedObjcImage);
  const copiedObjc = new ObjcMetadataProvider({
    binaryIdentity: issuedObjcAuthority.binaryIdentity,
    architecture: issuedObjcAuthority.architecture,
    sections: issuedObjcImage.sections.map((section) => ({ ...section })),
  });
  const copiedObjcResult = await copiedObjc.probe();
  assert.equal(copiedObjcResult.completeness.present, true);
  assert.equal(copiedObjcResult.completeness.complete, false);
  assert.equal(buildAppleKnowledge({ image: issuedObjcImage, objc: copiedObjcResult }).cells.objc.complete, false);
  const issuedObjcResult = await probeAppleLanguageMetadata(issuedObjcImage, 'objc');
  const presentObjc = buildAppleKnowledge({ image: issuedObjcImage, objc: issuedObjcResult });
  assert.notEqual(presentObjc.cells.objc.status, 'absent', 'a parser-issued ObjC section prevents a complete absence claim');
  assert.equal(presentObjc.cells.objc.complete, false);

  issuedEmptyImage.sections.push({ name: '__swift5_types', address: 0n, size: 4n });
  const mutatedPublicSections = await probeAppleLanguageMetadata(issuedEmptyImage, 'swift');
  assert.equal(buildAppleKnowledge({ image: issuedEmptyImage, swift: mutatedPublicSections }).cells.swift.status, 'absent', 'public section-array mutation cannot change parser-issued section evidence');
  issuedEmptyImage.bytes[0] ^= 1;
  const mutatedBytes = await probeAppleLanguageMetadata(issuedEmptyImage, 'swift');
  const mutatedBytesCell = buildAppleKnowledge({ image: issuedEmptyImage, swift: mutatedBytes }).cells.swift;
  assert.equal(mutatedBytesCell.status, 'partial');
  assert.equal(mutatedBytesCell.complete, false, 'post-issuance byte mutation invalidates provider absence');
  issuedEmptyImage.bytes[0] ^= 1;
}

console.log('HEX-X-02 Apple knowledge matrix: PASS');
