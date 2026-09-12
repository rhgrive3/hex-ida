import assert from 'node:assert/strict';
import { chainedImportSymbols, __chainedInternalsForTests } from '../js/chained.js';

const { sliceOffset } = __chainedInternalsForTests;

function makeFatMockFile() {
  const size = 0x4000;
  const buffer = new Uint8Array(size);
  const dv = new DataView(buffer.buffer);

  // FAT header: FAT_MAGIC (0xcafebabe)
  dv.setUint32(0, 0xcafebabe, false);
  // nfat_arch = 2
  dv.setUint32(4, 2, false);

  // arch 0: offset 0x1000, size 0x1000
  dv.setUint32(8, 0x0100000c, false); // cputype
  dv.setUint32(12, 0, false);          // cpusubtype
  dv.setUint32(16, 0x1000, false);     // offset
  dv.setUint32(20, 0x1000, false);     // size
  dv.setUint32(24, 14, false);         // align

  // arch 1: offset 0x2000, size 0x1000
  dv.setUint32(28, 0x01000007, false); // cputype
  dv.setUint32(32, 0x80000003, false); // cpusubtype
  dv.setUint32(36, 0x2000, false);     // offset
  dv.setUint32(40, 0x1000, false);     // size
  dv.setUint32(44, 14, false);         // align

  return {
    size,
    slice(start, end) {
      const s = Number(start);
      const e = end === undefined ? size : Number(end);
      const sub = buffer.subarray(s, e);
      return {
        async arrayBuffer() {
          return sub.buffer.slice(sub.byteOffset, sub.byteOffset + sub.byteLength);
        },
      };
    },
  };
}

function makeMachOMockFile() {
  const size = 0x2000;
  const buffer = new Uint8Array(size);
  const dv = new DataView(buffer.buffer);

  // MH_MAGIC_64 (0xfeedfacf, little-endian)
  dv.setUint32(0, 0xfeedfacf, true);

  return {
    size,
    slice(start, end) {
      const s = Number(start);
      const e = end === undefined ? size : Number(end);
      const sub = buffer.subarray(s, e);
      return {
        async arrayBuffer() {
          return sub.buffer.slice(sub.byteOffset, sub.byteOffset + sub.byteLength);
        },
      };
    },
  };
}

async function runTests() {
  const fatFile = makeFatMockFile();
  const machoFile = makeMachOMockFile();

  // 1. FAT valid slice indexes
  const slice0 = await sliceOffset(fatFile, 0);
  assert.deepEqual(slice0, { base: 0x1000n, size: 0x1000n });

  const slice1 = await sliceOffset(fatFile, 1);
  assert.deepEqual(slice1, { base: 0x2000n, size: 0x1000n });

  const sliceNull = await sliceOffset(fatFile, null);
  assert.deepEqual(sliceNull, { base: 0x1000n, size: 0x1000n });

  const sliceUndef = await sliceOffset(fatFile, undefined);
  assert.deepEqual(sliceUndef, { base: 0x1000n, size: 0x1000n });

  // 2. FAT invalid / non-integer slice indexes (must fail-closed to null)
  const invalidIndexes = [
    '1',
    '0',
    ['1'],
    true,
    false,
    {},
    0.5,
    1.2,
    -1,
    NaN,
    Infinity,
    -Infinity,
    2,   // out of range (nfat_arch = 2)
    999, // out of range
  ];

  for (const invalid of invalidIndexes) {
    const res = await sliceOffset(fatFile, invalid);
    assert.equal(res, null, `expected sliceOffset to return null for invalid index ${String(invalid)}`);
    const syms = await chainedImportSymbols(fatFile, invalid);
    assert.deepEqual(syms, [], `expected chainedImportSymbols to return [] for invalid index ${String(invalid)}`);
  }

  // 3. Mach-O 64-bit slice indexes
  const machoSlice0 = await sliceOffset(machoFile, 0);
  assert.deepEqual(machoSlice0, { base: 0n, size: BigInt(machoFile.size) });

  const machoSliceNull = await sliceOffset(machoFile, null);
  assert.deepEqual(machoSliceNull, { base: 0n, size: BigInt(machoFile.size) });

  for (const invalid of ['0', '1', 1, true, false, 0.5, -1]) {
    const res = await sliceOffset(machoFile, invalid);
    assert.equal(res, null, `expected macho sliceOffset to return null for invalid index ${String(invalid)}`);
  }

  console.log('issue-5286 chained fat slice index coercion: PASS');
}

await runTests();
