import test from 'node:test';
import assert from 'node:assert/strict';

import { parseMachO } from '../../../js/binary/macho.js';

const CPU_ARM64 = 0x0100000c;
const CPU_ARM64_32 = 0x0200000c;
const CPU_X86_64 = 0x01000007;
const S_ATTR_SOME_INSTRUCTIONS = 0x00000400;
const S_ATTR_PURE_INSTRUCTIONS = 0x80000000;

function uleb(value) {
  let v = BigInt(value);
  const out = [];
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v) byte |= 0x80;
    out.push(byte);
  } while (v);
  return out;
}

function buildMacho64({
  cpu = CPU_ARM64,
  subtype = 0,
  symbolAddress = 0x1180n,
  sectionAddress = 0x1180n,
  sectionSize = 8n,
  sectionOffset = 0x180,
  sectionFlags = S_ATTR_PURE_INSTRUCTIONS | S_ATTR_SOME_INSTRUCTIONS,
  segmentFileSize = 0x300n,
  functionStarts = 'absent', // absent | partial | complete
  dataInCode = null,
} = {}) {
  const withFunctionStarts = functionStarts !== 'absent';
  const withDataInCode = dataInCode != null;
  const segmentCommandSize = 152;
  const sizeofcmds = segmentCommandSize + 24 + (withFunctionStarts ? 16 : 0) + (withDataInCode ? 16 : 0);
  const ncmds = 2 + (withFunctionStarts ? 1 : 0) + (withDataInCode ? 1 : 0);
  const bytes = new Uint8Array(0x500);
  const v = new DataView(bytes.buffer);
  const u32 = (o, x) => v.setUint32(o, Number(x) >>> 0, true);
  const i32 = (o, x) => v.setInt32(o, Number(x), true);
  const u64 = (o, x) => v.setBigUint64(o, BigInt(x), true);
  const put = (o, s) => bytes.set(Buffer.from(s), o);

  // mach_header_64
  u32(0, 0xfeedfacf);
  i32(4, cpu);
  i32(8, subtype);
  u32(12, 6); // MH_DYLIB
  u32(16, ncmds);
  u32(20, sizeofcmds);
  u32(24, 0);
  u32(28, 0);

  // LC_SEGMENT_64 __TEXT with one executable section.
  let p = 32;
  u32(p, 0x19);
  u32(p + 4, segmentCommandSize);
  put(p + 8, '__TEXT');
  u64(p + 24, 0x1000n);
  u64(p + 32, 0x1000n);
  u64(p + 40, 0n);
  u64(p + 48, segmentFileSize);
  i32(p + 56, 5);
  i32(p + 60, 5);
  u32(p + 64, 1);
  u32(p + 68, 0);

  const q = p + 72;
  put(q, '__text');
  put(q + 16, '__TEXT');
  u64(q + 32, sectionAddress);
  u64(q + 40, sectionSize);
  u32(q + 48, sectionOffset);
  u32(q + 52, 2); // 4-byte declared section alignment
  u32(q + 56, 0);
  u32(q + 60, 0);
  u32(q + 64, sectionFlags);
  u32(q + 68, 0);
  u32(q + 72, 0);
  u32(q + 76, 0);
  p += segmentCommandSize;

  // LC_SYMTAB with one external defined N_SECT symbol.
  const symoff = 0x300;
  const stroff = 0x320;
  u32(p, 0x2);
  u32(p + 4, 24);
  u32(p + 8, symoff);
  u32(p + 12, 1);
  u32(p + 16, stroff);
  u32(p + 20, 16);
  p += 24;

  if (withFunctionStarts) {
    const fsoff = 0x340;
    let stream;
    if (functionStarts === 'complete') {
      stream = [...uleb(symbolAddress - 0x1000n), 0];
    } else {
      stream = [0x80]; // incomplete ULEB -> partial stream
    }
    u32(p, 0x26);
    u32(p + 4, 16);
    u32(p + 8, fsoff);
    u32(p + 12, stream.length);
    bytes.set(stream, fsoff);
    p += 16;
  }

  if (withDataInCode) {
    const dicoff = 0x380;
    u32(p, 0x29);
    u32(p + 4, 16);
    u32(p + 8, dicoff);
    u32(p + 12, 8);
    u32(dicoff, dataInCode.offset);
    v.setUint16(dicoff + 4, dataInCode.length, true);
    v.setUint16(dicoff + 6, dataInCode.kind ?? 1, true);
    p += 16;
  }

  // A few file-backed instruction bytes. The parser does not decode them here,
  // but they make the static-byte boundary explicit.
  if (sectionOffset + 8 <= bytes.length) {
    u32(sectionOffset, 0xd65f03c0); // ARM64 RET (harmless for x86 controls)
    u32(sectionOffset + 4, 0xd65f03c0);
  }

  u32(symoff, 1); // n_strx
  bytes[symoff + 4] = 0x0f; // N_SECT | N_EXT
  bytes[symoff + 5] = 1;
  v.setUint16(symoff + 6, 0, true);
  u64(symoff + 8, symbolAddress);
  bytes[stroff] = 0;
  put(stroff + 1, '_f');
  bytes[stroff + 3] = 0;

  return bytes;
}

function symbolSeeds(image) {
  return image.functions.filter((f) => f.source === 'symbol');
}

function symbolRecord(image) {
  return image.symbols.find((s) => s.name === '_f');
}

test('#8159 aligned ARM64 symbol in PURE_INSTRUCTIONS remains a function fallback', () => {
  const image = parseMachO(buildMacho64({ symbolAddress: 0x1180n }));
  assert.deepEqual(symbolSeeds(image).map((f) => f.address), [0x1180n]);
  assert.equal(symbolSeeds(image)[0].name, '_f');
});

test('#8159 misaligned ARM64 symbol is retained as metadata but not promoted to a function', () => {
  const image = parseMachO(buildMacho64({ symbolAddress: 0x1182n }));
  assert.equal(symbolRecord(image)?.address, 0x1182n, 'the valid nlist record must remain visible');
  assert.deepEqual(symbolSeeds(image), [], 'mid-instruction symbol must not gain function authority');
  assert.equal(image.metadata.machoMetadata.complete, true, 'rejecting function promotion does not invalidate symbol metadata');
});

test('#8159 candidate whose ARM64 instruction unit crosses its section end is rejected even if the segment stays file-backed', () => {
  const image = parseMachO(buildMacho64({
    symbolAddress: 0x1184n,
    sectionAddress: 0x1180n,
    sectionSize: 6n,
    sectionOffset: 0x180,
    segmentFileSize: 0x300n,
  }));
  assert.equal(image.addressToOffset(0x1187n), 0x187n, 'the enclosing segment still backs bytes past the section');
  assert.deepEqual(symbolSeeds(image), [], 'symbol authority must not cross the owning code section boundary');
});

test('#8159 LC_DATA_IN_CODE exclusion blocks symbol fallback without deleting the symbol', () => {
  const image = parseMachO(buildMacho64({
    symbolAddress: 0x1180n,
    dataInCode: { offset: 0x180, length: 4, kind: 1 },
  }));
  assert.equal(image.isDataInCode(0x1180n), true);
  assert.equal(symbolRecord(image)?.address, 0x1180n);
  assert.deepEqual(symbolSeeds(image), []);
  assert.equal(image.metadata.machoMetadata.complete, true, 'data-in-code exclusion is not a metadata parse failure');
});

test('#8159 partial LC_FUNCTION_STARTS cannot fall back to a misaligned ARM64 symbol', () => {
  const image = parseMachO(buildMacho64({ symbolAddress: 0x1182n, functionStarts: 'partial' }));
  assert.equal(image.metadata.functionStarts?.complete, false);
  assert.equal(symbolRecord(image)?.address, 0x1182n);
  assert.deepEqual(symbolSeeds(image), []);
});

test('#8159 partial LC_FUNCTION_STARTS still recovers a valid aligned symbol under its existing executable-section policy', () => {
  const image = parseMachO(buildMacho64({
    symbolAddress: 0x1180n,
    functionStarts: 'partial',
    sectionFlags: 0,
  }));
  assert.equal(image.metadata.functionStarts?.complete, false);
  assert.deepEqual(symbolSeeds(image).map((f) => f.address), [0x1180n]);
});

test('#8159 x86_64 symbol fallback stays byte-granular', () => {
  const image = parseMachO(buildMacho64({ cpu: CPU_X86_64, symbolAddress: 0x1182n }));
  assert.equal(image.arch, 'x86_64');
  assert.deepEqual(symbolSeeds(image).map((f) => f.address), [0x1182n]);
});

test('#8159 arm64e uses the same 4-byte symbol-to-function boundary', () => {
  const image = parseMachO(buildMacho64({ subtype: 2, symbolAddress: 0x1182n }));
  assert.equal(image.arch, 'arm64e');
  assert.deepEqual(symbolSeeds(image), []);
});

test('#8159 arm64_32 uses the same 4-byte symbol-to-function boundary', () => {
  const image = parseMachO(buildMacho64({ cpu: CPU_ARM64_32, symbolAddress: 0x1182n }));
  assert.equal(image.arch, 'arm64_32');
  assert.deepEqual(symbolSeeds(image), []);
});

test('#8159 stronger complete LC_FUNCTION_STARTS evidence still wins and acquires the symbol name', () => {
  const image = parseMachO(buildMacho64({ symbolAddress: 0x1180n, functionStarts: 'complete' }));
  assert.equal(image.metadata.functionStarts?.complete, true);
  const exact = image.functions.filter((f) => f.address === 0x1180n);
  assert.equal(exact.length, 1);
  assert.equal(exact[0].source, 'function_starts');
  assert.equal(exact[0].name, '_f');
});

test('#8159 zero-fill executable sections never promote symbol-only function evidence', () => {
  const image = parseMachO(buildMacho64({
    symbolAddress: 0x1180n,
    sectionFlags: S_ATTR_PURE_INSTRUCTIONS | S_ATTR_SOME_INSTRUCTIONS | 0x1, // S_ZEROFILL
  }));
  assert.equal(image.addressToOffset(0x1180n), null);
  assert.equal(symbolRecord(image)?.address, 0x1180n);
  assert.deepEqual(symbolSeeds(image), []);
});
