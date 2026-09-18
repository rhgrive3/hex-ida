import assert from 'node:assert/strict';
import test from 'node:test';

import { openBinary } from '../../../js/binary/index.js';
import { parsePE } from '../../../js/binary/pe.js';
import { architecturePluginV2 } from '../../../js/targets/architecture/index.js';

const IMAGE_BASE64 = 0x140000000n;
const TEXT_RVA = 0x1000;
const RDATA_RVA = 0x2000;
const LOAD_CONFIG_RVA = 0x2000;
const LOAD_CONFIG_FILE = 0x600;
const CHPE_META_RVA = 0x2100;
const CHPE_META_FILE = 0x700;
const CHPE_MAP_RVA = 0x2160;
const CHPE_MAP_FILE = 0x760;

function buildARM64ECPE({
  machine = 0x8664,
  loadConfigDeclaredSize = 208,
  loadConfigDirectorySize = loadConfigDeclaredSize,
  hasLoadConfig = true,
  chpeMetadataPointer = hasLoadConfig && loadConfigDeclaredSize >= 208 ? IMAGE_BASE64 + BigInt(CHPE_META_RVA) : 0n,
  chpeVersion = 1,
  chpeCodeMapRva = CHPE_MAP_RVA,
  chpeCodeMapCount = null,
  codeMapEntries = [
    { startOffset: 0x1000 | 1, length: 4 }, // ARM64EC ret
    { startOffset: 0x1100 | 2, length: 6 }, // AMD64 mov eax, 3; ret
  ],
} = {}) {
  const bytes = new Uint8Array(0x1000);
  const view = new DataView(bytes.buffer);
  const u16 = (o, x) => view.setUint16(o, x, true);
  const u32 = (o, x) => view.setUint32(o, x >>> 0, true);
  const u64 = (o, x) => view.setBigUint64(o, BigInt(x), true);
  const put = (o, s) => bytes.set(new TextEncoder().encode(s), o);

  // DOS Header
  u16(0, 0x5a4d);
  u32(0x3c, 0x80);

  // PE Header
  u32(0x80, 0x00004550);
  const coff = 0x84;
  u16(coff + 0, machine); // Machine
  u16(coff + 2, 2);      // NumberOfSections = 2
  u16(coff + 16, 0xf0);  // SizeOfOptionalHeader = 240
  u16(coff + 18, 0x0022);// Characteristics = EXECUTABLE_IMAGE | LARGE_ADDRESS_AWARE

  // Optional Header (PE32+)
  const opt = coff + 20;
  u16(opt + 0, 0x20b); // Magic = PE32+
  u32(opt + 16, TEXT_RVA); // AddressOfEntryPoint = 0x1000
  u32(opt + 20, TEXT_RVA); // BaseOfCode = 0x1000
  u64(opt + 24, IMAGE_BASE64); // ImageBase
  u32(opt + 32, 0x1000); // SectionAlignment = 4096
  u32(opt + 36, 0x200);  // FileAlignment = 512
  u32(opt + 56, 0x3000); // SizeOfImage
  u32(opt + 60, 0x200);  // SizeOfHeaders
  u32(opt + 108, 16);    // NumberOfRvaAndSizes

  const dirBase = opt + 112;
  if (hasLoadConfig) {
    u32(dirBase + 10 * 8, LOAD_CONFIG_RVA);
    u32(dirBase + 10 * 8 + 4, loadConfigDirectorySize);
  }

  // Sections
  // .text
  let s = opt + 0xf0;
  put(s, '.text');
  u32(s + 8, 0x1000);
  u32(s + 12, TEXT_RVA);
  u32(s + 16, 0x400);
  u32(s + 20, 0x200);
  u32(s + 36, 0x60000020); // EXECUTE | READ | CODE

  // .rdata
  s += 40;
  put(s, '.rdata');
  u32(s + 8, 0x1000);
  u32(s + 12, RDATA_RVA);
  u32(s + 16, 0x400);
  u32(s + 20, 0x600);
  u32(s + 36, 0x40000040); // READ | INITIALIZED_DATA

  // .text code contents:
  // 0x1000 (offset 0x200): A64 ret instruction (c0 03 5f d6)
  bytes[0x200] = 0xc0;
  bytes[0x201] = 0x03;
  bytes[0x202] = 0x5f;
  bytes[0x203] = 0xd6;

  // 0x1100 (offset 0x300): x86_64 mov eax, 3; ret (b8 03 00 00 00 c3)
  bytes[0x300] = 0xb8;
  bytes[0x301] = 0x03;
  bytes[0x302] = 0x00;
  bytes[0x303] = 0x00;
  bytes[0x304] = 0x00;
  bytes[0x305] = 0xc3;

  // Load Config Directory (.rdata, offset 0x600)
  if (hasLoadConfig) {
    u32(LOAD_CONFIG_FILE + 0, loadConfigDeclaredSize);
    if (loadConfigDeclaredSize >= 208) {
      u64(LOAD_CONFIG_FILE + 200, chpeMetadataPointer);
    }
  }

  // IMAGE_ARM64EC_METADATA (.rdata, offset 0x700)
  const actualCount = chpeCodeMapCount !== null ? chpeCodeMapCount : codeMapEntries.length;
  u32(CHPE_META_FILE + 0, chpeVersion);
  u32(CHPE_META_FILE + 4, chpeCodeMapRva);
  u32(CHPE_META_FILE + 8, actualCount);

  // IMAGE_CHPE_RANGE_ENTRY array (.rdata, offset 0x760)
  codeMapEntries.forEach((entry, idx) => {
    u32(CHPE_MAP_FILE + idx * 8 + 0, entry.startOffset);
    u32(CHPE_MAP_FILE + idx * 8 + 4, entry.length);
  });

  return bytes;
}

test('Issue #8184 - Criterion 1: loader detects image as hybrid/ARM64EC-capable rather than uniformly x86_64', () => {
  const bytes = buildARM64ECPE();
  const image = openBinary(bytes);

  assert.equal(image.format, 'pe');
  assert.equal(image.arch, 'arm64ec');
  assert.equal(image.bits, 64);
  assert.equal(image.metadata.machine, 0x8664);
  assert.equal(image.metadata.hybrid, true);
  assert.equal(image.metadata.isHybrid, true);
  assert.equal(image.entrypoint, IMAGE_BASE64 + 0x1000n);
  assert.ok(Array.isArray(image.chpeCodeMap));
  assert.equal(image.chpeCodeMap.length, 2);
});

test('Issue #8184 - Criterion 2: code-map range boundaries and types are retained exactly', () => {
  const bytes = buildARM64ECPE();
  const image = parsePE(bytes);

  assert.equal(image.chpeCodeMap.length, 2);
  const [range0, range1] = image.chpeCodeMap;

  assert.equal(range0.startRva, 0x1000);
  assert.equal(range0.endRva, 0x1004);
  assert.equal(range0.length, 4);
  assert.equal(range0.type, 1);
  assert.equal(range0.arch, 'arm64ec');
  assert.equal(range0.startAddress, IMAGE_BASE64 + 0x1000n);
  assert.equal(range0.endAddress, IMAGE_BASE64 + 0x1004n);

  assert.equal(range1.startRva, 0x1100);
  assert.equal(range1.endRva, 0x1106);
  assert.equal(range1.length, 6);
  assert.equal(range1.type, 2);
  assert.equal(range1.arch, 'x86_64');
  assert.equal(range1.startAddress, IMAGE_BASE64 + 0x1100n);
  assert.equal(range1.endAddress, IMAGE_BASE64 + 0x1106n);
});

test('Issue #8184 - Criteria 3 & 4: ARM64EC range routes to ARM64 and AMD64 range routes to x86_64', () => {
  const bytes = buildARM64ECPE();
  const image = parsePE(bytes);

  // Both VA and RVA queries
  assert.equal(image.archAt(IMAGE_BASE64 + 0x1000n), 'arm64ec');
  assert.equal(image.archAt(0x1000), 'arm64ec');
  assert.equal(image.archAt(0x1003), 'arm64ec');

  assert.equal(image.archAt(IMAGE_BASE64 + 0x1100n), 'x86_64');
  assert.equal(image.archAt(0x1100), 'x86_64');
  assert.equal(image.archAt(0x1105), 'x86_64');

  const arm64Plugin = architecturePluginV2(image.archAt(0x1000));
  assert.equal(arm64Plugin.id, 'arm64ec');
  assert.equal(arm64Plugin.instructionAlignment, 4);

  const x86Plugin = architecturePluginV2(image.archAt(0x1100));
  assert.equal(x86Plugin.id, 'x86_64');
  assert.equal(x86Plugin.instructionAlignment, 1);
});

test('Issue #8184 - Criterion 5: both functions produce correct architecture-specific control effects', () => {
  const bytes = buildARM64ECPE();
  const image = parsePE(bytes);

  const arm64Plugin = architecturePluginV2(image.archAt(0x1000));
  const x86Plugin = architecturePluginV2(image.archAt(0x1100));

  // Control flow classification
  assert.equal(arm64Plugin.classifyControlFlow({ mnemonic: 'ret' }), 'return');
  assert.equal(x86Plugin.classifyControlFlow({ mnemonic: 'ret' }), 'return');

  // Lifter machine effects
  const arm64Effects = arm64Plugin.liftExact({
    instructionId: 'a64:ret',
    mnemonic: 'ret',
    address: IMAGE_BASE64 + 0x1000n,
    operands: [],
  }, { architectureId: 'arm64ec' });
  assert.ok(arm64Effects);
  assert.equal(arm64Effects.controlEffect.kind, 'return');

  const x86Effects = x86Plugin.liftExact({
    instructionId: 'x86:ret:1',
    instructionCode: 1,
    instructionFamily: 'ret',
    length: 1,
    rawBytes: new Uint8Array([0xc3]),
    bytes: new Uint8Array([0xc3]),
    address: IMAGE_BASE64 + 0x1105n,
    mode: 'long-64',
    detailAvailable: true,
    detailStatus: 'complete',
    mnemonic: 'ret',
    opStr: '',
    detail: {
      operandCount: 0,
      operands: [],
      implicitReads: [],
      implicitWrites: [],
      prefixes: { legacy: new Uint8Array(0), rex: null, vector: null },
    },
    operands: [],
  }, { architectureId: 'x86_64' });
  assert.ok(x86Effects);
  assert.equal(x86Effects.controlEffect.kind, 'return');
});

test('Issue #8184 - Criterion 6: malformed/out-of-range/overlapping code-map entries fail closed and downgrade completeness', () => {
  // Case A: invalid type 3
  {
    const bytes = buildARM64ECPE({
      codeMapEntries: [{ startOffset: 0x1000 | 3, length: 4 }],
    });
    const image = parsePE(bytes);
    assert.equal(image.metadata.hybrid, true);
    assert.equal(image.chpeCodeMap.length, 0);
    assert.equal(image.metadata.peMetadata?.complete, false);
    assert.ok(image.metadata.peMetadata?.reasons.includes('load-config:chpe-codemap-invalid'));
    assert.equal(image.archAt(0x1000), null);
    assert.equal(image.archAt(IMAGE_BASE64 + 0x1000n), null);
  }

  // Case B: length <= 0
  {
    const bytes = buildARM64ECPE({
      codeMapEntries: [{ startOffset: 0x1000 | 1, length: 0 }],
    });
    const image = parsePE(bytes);
    assert.equal(image.chpeCodeMap.length, 0);
    assert.equal(image.metadata.peMetadata?.complete, false);
    assert.ok(image.metadata.peMetadata?.reasons.includes('load-config:chpe-codemap-invalid'));
    assert.equal(image.archAt(0x1000), null);
  }

  // Case C: overlapping ranges
  {
    const bytes = buildARM64ECPE({
      codeMapEntries: [
        { startOffset: 0x1000 | 1, length: 16 },
        { startOffset: 0x1008 | 2, length: 8 }, // starts before 0x1010
      ],
    });
    const image = parsePE(bytes);
    assert.equal(image.chpeCodeMap.length, 0);
    assert.equal(image.metadata.peMetadata?.complete, false);
    assert.ok(image.metadata.peMetadata?.reasons.includes('load-config:chpe-codemap-invalid'));
    assert.equal(image.archAt(0x1000), null);
  }

  // Case D: out-of-range metadata pointer (not file-backed)
  {
    const bytes = buildARM64ECPE({
      chpeMetadataPointer: IMAGE_BASE64 + 0x5000n, // unmapped RVA
    });
    const image = parsePE(bytes);
    assert.equal(image.chpeCodeMap.length, 0);
    assert.equal(image.metadata.peMetadata?.complete, false);
    assert.ok(image.metadata.peMetadata?.reasons.includes('load-config:chpe-codemap-invalid'));
    assert.equal(image.archAt(0x1000), null);
  }
});

test('Issue #8184 - Criterion 7: pure AMD64 and pure ARM64 PE fixtures keep existing behavior', () => {
  // Pure AMD64: machine 0x8664 with no CHPE pointer
  {
    const bytes = buildARM64ECPE({
      loadConfigDeclaredSize: 144, // smaller than 208, no CHPE
      chpeMetadataPointer: 0n,
    });
    const image = parsePE(bytes);
    assert.equal(image.arch, 'x86_64');
    assert.equal(image.metadata.hybrid, undefined);
    assert.equal(image.archAt(0x1000), 'x86_64');
    assert.equal(image.archAt(IMAGE_BASE64 + 0x1000n), 'x86_64');
  }

  // Pure ARM64: machine 0xaa64 with no CHPE pointer
  {
    const bytes = buildARM64ECPE({
      machine: 0xaa64,
      loadConfigDeclaredSize: 144,
      chpeMetadataPointer: 0n,
    });
    const image = parsePE(bytes);
    assert.equal(image.arch, 'arm64');
    assert.equal(image.metadata.hybrid, undefined);
    assert.equal(image.archAt(0x1000), 'arm64');
  }
});

test('Issue #8184 - Criterion 8: no fallback silently interprets unclassified hybrid executable range as COFF machine ISA', () => {
  const bytes = buildARM64ECPE();
  const image = parsePE(bytes);

  // Address 0x1200 is inside the executable .text section (RVA 0x1000..0x2000),
  // but outside any registered CHPE code-map range ([0x1000, 0x1004) and [0x1100, 0x1106)).
  assert.equal(image.archAt(IMAGE_BASE64 + 0x1200n), null);
  assert.equal(image.archAt(0x1200), null);
  assert.notEqual(image.archAt(0x1200), 'x86_64');
  assert.notEqual(image.archAt(0x1200), 'arm64ec');
});
