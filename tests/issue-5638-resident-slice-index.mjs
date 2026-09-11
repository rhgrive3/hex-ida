import assert from 'node:assert/strict';
import { parseMachO } from '../js/binary/macho.js';
import { parseMachOSource } from '../js/binary/source-loaders.js';
import { asByteSource } from '../js/binary/source.js';

// Issue #5638: the resident FAT selector ignored the public sliceIndex option
// (only opts.arch reached selectFatSlice), so parseMachO/openBinary silently
// picked a different slice than the documented source-backed contract.

const CPU_ARM64 = 0x0100000c;

function fatFixture() {
  const bytes = new Uint8Array(0x9000), dv = new DataView(bytes.buffer);
  dv.setUint32(0, 0xcafebabe, false); dv.setUint32(4, 2, false);
  const writeFat = (p, subtype, off) => {
    dv.setUint32(p, CPU_ARM64, false); dv.setUint32(p + 4, subtype, false);
    dv.setUint32(p + 8, off, false); dv.setUint32(p + 12, 32, false); dv.setUint32(p + 16, 14, false);
  };
  writeFat(8, 2, 0x4000); writeFat(28, 0, 0x8000);
  const writeThin = (off, subtype) => {
    dv.setUint32(off, 0xfeedfacf, true);
    dv.setInt32(off + 4, CPU_ARM64, true); dv.setInt32(off + 8, subtype, true);
    dv.setUint32(off + 12, 2, true); dv.setUint32(off + 16, 0, true);
    dv.setUint32(off + 20, 0, true); dv.setUint32(off + 24, 0, true); dv.setUint32(off + 28, 0, true);
  };
  writeThin(0x4000, 2); writeThin(0x8000, 0);
  return bytes;
}

const bytes = fatFixture();

// sliceIndex is honored by the resident parser (same contract as
// parseMachOSource, which the existing issue-2516 test pins to 0x8000).
const indexed = parseMachO(bytes, { sliceIndex: 1 });
assert.equal(indexed.metadata.fat.selected.offset, 0x8000n, 'resident sliceIndex:1 selects slice 1');
assert.equal(indexed.metadata.fat.selected.subtype, 0);

const indexed0 = parseMachO(bytes, { sliceIndex: 0 });
assert.equal(indexed0.metadata.fat.selected.offset, 0x4000n, 'resident sliceIndex:0 selects slice 0');
assert.equal(indexed0.metadata.fat.selected.subtype, 2);

// String sliceIndex follows the source-backed coercion contract.
const indexedString = parseMachO(bytes, { sliceIndex: '1' });
assert.equal(indexedString.metadata.fat.selected.offset, 0x8000n, 'string sliceIndex is coerced like the source path');

// Structured sliceIndex values fail closed (no silent fallback).
assert.throws(
  () => parseMachO(bytes, { sliceIndex: ['1'] }),
  /requested Mach-O slice index/,
  'structured sliceIndex must not fall back to the architecture priority',
);

// Out-of-range index throws instead of silently choosing another slice.
assert.throws(() => parseMachO(bytes, { sliceIndex: 2 }), /requested Mach-O slice index 2/);

// Without sliceIndex the architecture preference still applies.
{
  const byArch = parseMachO(bytes, { arch: 'arm64' });
  assert.equal(byArch.metadata.fat.selected.offset, 0x8000n, 'arch preference without sliceIndex is unchanged');
  const defaulted = parseMachO(bytes, {});
  assert.equal(defaulted.metadata.fat.selected.offset, 0x4000n, 'arm64e default priority without any option is unchanged');
}

// Source-backed path still agrees with the resident path (contract parity).
{
  const source = await parseMachOSource(asByteSource(bytes), { sliceIndex: 1 });
  assert.equal(source.metadata.fat.selected.offset, 0x8000n);
}

// openBinary routes through the same resident selector.
{
  const { openBinary } = await import('../js/binary/index.js');
  const viaOpen = openBinary(bytes, { sliceIndex: 1 });
  assert.equal(viaOpen.metadata.fat.selected.offset, 0x8000n, 'openBinary honors sliceIndex');
}

console.log('issue #5638 resident FAT sliceIndex authority regression: PASS');
