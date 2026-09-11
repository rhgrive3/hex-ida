import test from 'node:test';
import assert from 'node:assert/strict';

import { parseMachO } from '../../../js/binary/macho.js';

const S_INIT_FUNC_OFFSETS = 0x16;

function put(bytes, off, text, width = 16) {
  for (let i = 0; i < width; i++) bytes[off + i] = i < text.length ? text.charCodeAt(i) : 0;
}

function buildMacho64({
  initOffsets = [0x180],
  initSize = null,
  initSection = true,
  codeAddr = 0x1180n,
  codeSize = 4n,
  textSegmentFileSize = 0x300n,
  extraDataTarget = false,
  withFunctionStarts = false,
} = {}) {
  const bytes = new Uint8Array(0x600);
  const v = new DataView(bytes.buffer);
  const u32 = (o, x) => v.setUint32(o, Number(x), true);
  const i32 = (o, x) => v.setInt32(o, Number(x), true);
  const u64 = (o, x) => v.setBigUint64(o, BigInt(x), true);

  const textSections = initSection ? 2 : 1;
  const textCmdSize = 72 + textSections * 80;
  const dataCmdSize = extraDataTarget ? 152 : 0;
  const functionStartsCmdSize = withFunctionStarts ? 16 : 0;
  const ncmds = 1 + (extraDataTarget ? 1 : 0) + (withFunctionStarts ? 1 : 0);

  bytes.set([0xcf, 0xfa, 0xed, 0xfe], 0);
  i32(4, 0x0100000c); // CPU_TYPE_ARM64
  i32(8, 0);
  u32(12, 6); // MH_DYLIB
  u32(16, ncmds);
  u32(20, textCmdSize + dataCmdSize + functionStartsCmdSize);

  let p = 32;
  u32(p, 0x19); // LC_SEGMENT_64
  u32(p + 4, textCmdSize);
  put(bytes, p + 8, '__TEXT');
  u64(p + 24, 0x1000n);
  u64(p + 32, 0x1000n);
  u64(p + 40, 0n);
  u64(p + 48, textSegmentFileSize);
  i32(p + 56, 5);
  i32(p + 60, 5);
  u32(p + 64, textSections);

  let q = p + 72;
  put(bytes, q, '__text');
  put(bytes, q + 16, '__TEXT');
  u64(q + 32, codeAddr);
  u64(q + 40, codeSize);
  u32(q + 48, 0x280);
  u32(q + 52, 2);
  u32(q + 64, 0x80000400);

  if (initSection) {
    const size = initSize ?? BigInt(initOffsets.length * 4);
    q += 80;
    put(bytes, q, '__init_offsets');
    put(bytes, q + 16, '__TEXT');
    u64(q + 32, 0x1184n);
    u64(q + 40, size);
    u32(q + 48, 0x284);
    u32(q + 52, 2);
    u32(q + 64, S_INIT_FUNC_OFFSETS);
    for (let i = 0; i < initOffsets.length; i++) u32(0x284 + i * 4, initOffsets[i]);
  }

  // One file-backed ARM64 RET at the default code target.
  u32(0x280, 0xd65f03c0);

  p += textCmdSize;
  if (extraDataTarget) {
    u32(p, 0x19);
    u32(p + 4, 152);
    put(bytes, p + 8, '__DATA');
    u64(p + 24, 0x2000n);
    u64(p + 32, 0x1000n);
    u64(p + 40, 0x400n);
    u64(p + 48, 0x100n);
    i32(p + 56, 3);
    i32(p + 60, 3);
    u32(p + 64, 1);
    q = p + 72;
    put(bytes, q, '__data');
    put(bytes, q + 16, '__DATA');
    u64(q + 32, 0x2000n);
    u64(q + 40, 4n);
    u32(q + 48, 0x400);
    u32(q + 52, 2);
    u32(q + 64, 0);
    p += 152;
  }

  if (withFunctionStarts) {
    u32(p, 0x26); // LC_FUNCTION_STARTS
    u32(p + 4, 16);
    u32(p + 8, 0x500);
    u32(p + 12, 3);
    bytes[0x500] = 0x80; // ULEB128(0x180)
    bytes[0x501] = 0x03;
    bytes[0x502] = 0x00; // terminator
  }

  return bytes;
}

function buildMacho32({ imageBase = 0x1000, codeOffset = 0x180, initOffset = 0x180 } = {}) {
  const bytes = new Uint8Array(0x500);
  const v = new DataView(bytes.buffer);
  const u32 = (o, x) => v.setUint32(o, Number(x) >>> 0, true);
  const i32 = (o, x) => v.setInt32(o, Number(x), true);

  // mach_header + LC_SEGMENT(__TEXT with __text + __init_offsets)
  const cmdSize = 56 + 2 * 68;
  bytes.set([0xce, 0xfa, 0xed, 0xfe], 0);
  i32(4, 7); // i386: byte-granular instruction alignment
  i32(8, 3);
  u32(12, 6);
  u32(16, 1);
  u32(20, cmdSize);

  const p = 28;
  u32(p, 1); // LC_SEGMENT
  u32(p + 4, cmdSize);
  put(bytes, p + 8, '__TEXT');
  u32(p + 24, imageBase);
  u32(p + 28, 0x1000);
  u32(p + 32, 0);
  u32(p + 36, 0x300);
  i32(p + 40, 5);
  i32(p + 44, 5);
  u32(p + 48, 2);

  let q = p + 56;
  put(bytes, q, '__text');
  put(bytes, q + 16, '__TEXT');
  u32(q + 32, (BigInt(imageBase) + BigInt(codeOffset)) & 0xffffffffn);
  u32(q + 36, 1);
  u32(q + 40, 0x180);
  u32(q + 44, 0);
  u32(q + 56, 0x80000400);

  q += 68;
  put(bytes, q, '__init_offsets');
  put(bytes, q + 16, '__TEXT');
  u32(q + 32, (BigInt(imageBase) + 0x184n) & 0xffffffffn);
  u32(q + 36, 4);
  u32(q + 40, 0x184);
  u32(q + 44, 2);
  u32(q + 56, S_INIT_FUNC_OFFSETS);

  bytes[0x180] = 0xc3;
  u32(0x184, initOffset);
  return bytes;
}

function reasons(image) {
  return image.metadata.machoMetadata?.reasons || [];
}

function initRecords(image) {
  return image.metadata.initializers || [];
}

test('valid ARM64 S_INIT_FUNC_OFFSETS entry becomes retained lifecycle metadata and exact constructor seed', () => {
  const image = parseMachO(buildMacho64());
  assert.equal(image.imageBase, 0x1000n);
  assert.equal(initRecords(image).length, 1);
  assert.deepEqual(initRecords(image)[0], {
    address: 0x1180n,
    raw: 0x180n,
    slotAddress: 0x1184n,
    section: '__init_offsets',
    encoding: 'S_INIT_FUNC_OFFSETS',
    valid: true,
  });
  assert.equal(image.functions.length, 1);
  assert.equal(image.functions[0].address, 0x1180n);
  assert.equal(image.functions[0].source, 'constructor');
  assert.equal(image.functions[0].exactFunctionStart, true);
  assert.match(image.functions[0].functionStartEvidence, /S_INIT_FUNC_OFFSETS/);
  assert.equal(image.metadata.machoMetadata.complete, true);
});

test('S_INIT_FUNC_OFFSETS remains 4 bytes per entry in 32-bit Mach-O', () => {
  const image = parseMachO(buildMacho32());
  assert.equal(initRecords(image).length, 1);
  assert.equal(initRecords(image)[0].raw, 0x180n);
  assert.equal(initRecords(image)[0].address, 0x1180n);
  assert.equal(image.functions.some((f) => f.address === 0x1180n && f.source === 'constructor'), true);
});

test('section tail not divisible by four is partial and never decoded as another entry', () => {
  const image = parseMachO(buildMacho64({ initSize: 5n }));
  assert.equal(initRecords(image).length, 1);
  assert.equal(initRecords(image)[0].address, 0x1180n);
  assert.equal(reasons(image).includes('init-offsets:truncated-section'), true);
  assert.equal(image.metadata.machoMetadata.complete, false);
});

test('ARM64 misaligned target is retained but never minted as function truth', () => {
  const image = parseMachO(buildMacho64({ initOffsets: [0x182] }));
  assert.equal(initRecords(image).length, 1);
  assert.equal(initRecords(image)[0].address, 0x1182n);
  assert.equal(initRecords(image)[0].valid, false);
  assert.equal(image.functions.some((f) => f.address === 0x1182n), false);
  assert.equal(reasons(image).includes('init-offsets:misaligned'), true);
});

test('unmapped target is retained as invalid lifecycle metadata without a seed', () => {
  const image = parseMachO(buildMacho64({ initOffsets: [0x5000] }));
  assert.equal(initRecords(image)[0].address, 0x6000n);
  assert.equal(initRecords(image)[0].valid, false);
  assert.equal(image.functions.length, 0);
  assert.equal(reasons(image).includes('init-offsets:unmapped'), true);
});

test('mapped non-executable target is rejected before function promotion', () => {
  const image = parseMachO(buildMacho64({ initOffsets: [0x1000], extraDataTarget: true }));
  assert.equal(initRecords(image)[0].address, 0x2000n);
  assert.equal(initRecords(image)[0].valid, false);
  assert.equal(image.functions.length, 0);
  assert.equal(reasons(image).includes('init-offsets:non-executable'), true);
});

test('executable zero-fill target is not static function evidence', () => {
  const image = parseMachO(buildMacho64({ initOffsets: [0x300], textSegmentFileSize: 0x288n }));
  assert.equal(initRecords(image)[0].address, 0x1300n);
  assert.equal(initRecords(image)[0].valid, false);
  assert.equal(image.functions.length, 0);
  assert.equal(reasons(image).includes('init-offsets:not-file-backed'), true);
});

test('first ARM64 instruction unit must fit entirely in one file-backed canonical mapping', () => {
  const image = parseMachO(buildMacho64({ codeSize: 2n }));
  assert.equal(initRecords(image).length, 1);
  assert.equal(initRecords(image)[0].address, 0x1180n);
  assert.equal(initRecords(image)[0].valid, false);
  assert.equal(image.functions.length, 0);
  assert.equal(reasons(image).includes('init-offsets:not-file-backed'), true);
});

test('initializer decoding obeys the shared metadata record budget before reading an entry', () => {
  const image = parseMachO(buildMacho64(), { metadataLimits: { records: 1 } });
  assert.deepEqual(initRecords(image), []);
  assert.equal(image.functions.length, 0);
  assert.equal(reasons(image).includes('budget:init-offsets:records'), true);
});

test('32-bit image-base addition that exceeds address domain is fail-closed', () => {
  const image = parseMachO(buildMacho32({ imageBase: 0xfffff000, codeOffset: 0, initOffset: 0x2000 }));
  assert.equal(initRecords(image).length, 1);
  assert.equal(initRecords(image)[0].raw, 0x2000n);
  assert.equal(initRecords(image)[0].address, null);
  assert.equal(initRecords(image)[0].valid, false);
  assert.equal(image.functions.length, 0);
  assert.equal(reasons(image).includes('init-offsets:address-out-of-domain'), true);
});

test('duplicate LC_FUNCTION_STARTS evidence merges to one canonical function without losing initializer provenance', () => {
  const image = parseMachO(buildMacho64({ withFunctionStarts: true }));
  assert.equal(initRecords(image).length, 1);
  assert.equal(initRecords(image)[0].encoding, 'S_INIT_FUNC_OFFSETS');
  assert.equal(image.functions.filter((f) => f.address === 0x1180n).length, 1);
  assert.equal(image.functions[0].sources.includes('function_starts'), true);
  assert.equal(image.functions[0].sources.includes('constructor'), true);
});

test('duplicate offset entries deduplicate function truth while retaining both lifecycle records', () => {
  const image = parseMachO(buildMacho64({ initOffsets: [0x180, 0x180], initSize: 8n }));
  assert.equal(initRecords(image).length, 2);
  assert.equal(initRecords(image).every((r) => r.address === 0x1180n && r.valid), true);
  assert.equal(image.functions.filter((f) => f.address === 0x1180n).length, 1);
});

test('Mach-O without S_INIT_FUNC_OFFSETS stays unchanged', () => {
  const image = parseMachO(buildMacho64({ initSection: false }));
  assert.equal(image.metadata.initializers, undefined);
  assert.equal(image.functions.length, 0);
  assert.equal(reasons(image).some((r) => r.startsWith('init-offsets:')), false);
});
