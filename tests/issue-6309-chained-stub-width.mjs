import assert from 'node:assert/strict';
import { chainedImportSymbols } from '../js/chained.js';

function fixture({ reserved2 = 12, sectionSize = reserved2, fat = false } = {}) {
  const thin = new Uint8Array(0x600);
  const dv = new DataView(thin.buffer);
  const vmaddr = 0x100000000n;
  const stub = vmaddr + 0x200n;
  const slot = vmaddr + 0x300n;

  // mach_header_64 with LC_SEGMENT_64 + LC_DYLD_CHAINED_FIXUPS.
  dv.setUint32(0, 0xfeedfacf, true);
  dv.setInt32(4, 0x0100000c, true);
  dv.setUint32(12, 2, true);
  dv.setUint32(16, 2, true);
  dv.setUint32(20, 168, true);

  const seg = 32;
  dv.setUint32(seg, 0x19, true);
  dv.setUint32(seg + 4, 152, true);
  new TextEncoder().encodeInto('__TEXT', thin.subarray(seg + 8, seg + 24));
  dv.setBigUint64(seg + 24, vmaddr, true);
  dv.setBigUint64(seg + 32, BigInt(thin.length), true);
  dv.setBigUint64(seg + 40, 0n, true);
  dv.setBigUint64(seg + 48, BigInt(thin.length), true);
  dv.setUint32(seg + 64, 1, true);

  const sec = seg + 72;
  new TextEncoder().encodeInto('__stubs', thin.subarray(sec, sec + 16));
  new TextEncoder().encodeInto('__TEXT', thin.subarray(sec + 16, sec + 32));
  dv.setBigUint64(sec + 32, stub, true);
  dv.setBigUint64(sec + 40, BigInt(sectionSize), true);
  dv.setUint32(sec + 48, 0x200, true);
  dv.setUint32(sec + 64, 0x8, true);
  dv.setUint32(sec + 72, reserved2, true);

  const command = seg + 152;
  dv.setUint32(command, 0x80000034, true);
  dv.setUint32(command + 4, 16, true);
  dv.setUint32(command + 8, 0x400, true);
  dv.setUint32(command + 12, 0x80, true);

  // A syntactically valid ADRP/LDR/BR sequence must not override malformed metadata.
  dv.setUint32(0x200, 0x90000010, true);
  dv.setUint32(0x204, 0xf9418210, true);
  dv.setUint32(0x208, 0xd61f0200, true);
  dv.setBigUint64(0x300, 1n << 63n, true);

  const fixups = 0x400;
  dv.setUint32(fixups + 4, 28, true);
  dv.setUint32(fixups + 8, 64, true);
  dv.setUint32(fixups + 12, 68, true);
  dv.setUint32(fixups + 16, 1, true);
  dv.setUint32(fixups + 20, 1, true);
  dv.setUint32(fixups + 28, 1, true);
  dv.setUint32(fixups + 32, 8, true);
  dv.setUint32(fixups + 36, 24, true);
  dv.setUint16(fixups + 40, 0x1000, true);
  dv.setUint16(fixups + 42, 2, true);
  dv.setUint16(fixups + 56, 1, true);
  new TextEncoder().encodeInto('_target\0', thin.subarray(fixups + 68, fixups + 80));

  if (!fat) return { file: new Blob([thin]), stub, slot };
  const outer = new Uint8Array(0x100 + thin.length);
  const fdv = new DataView(outer.buffer);
  fdv.setUint32(0, 0xcafebabe, false);
  fdv.setUint32(4, 1, false);
  fdv.setUint32(8, 0x0100000c, false);
  fdv.setUint32(16, 0x100, false);
  fdv.setUint32(20, thin.length, false);
  outer.set(thin, 0x100);
  return { file: new Blob([outer]), stub, slot };
}

for (const fat of [false, true]) {
  for (const width of [12, 16]) {
    const value = fixture({ reserved2: width, sectionSize: width, fat });
    assert.deepEqual(await chainedImportSymbols(value.file, 0), [
      { addr: value.stub, name: '_target', kind: 1 },
      { addr: value.slot, name: '_target', kind: 2 },
    ], `${fat ? 'FAT' : 'thin'} coherent stub width ${width} regressed`);
  }

  const unspecified = fixture({ reserved2: 0, sectionSize: 12, fat });
  assert.deepEqual(await chainedImportSymbols(unspecified.file, 0), [],
    `${fat ? 'FAT' : 'thin'} reserved2=0 fabricated a 12-byte stub symbol`);
}

const thinOutOfRange = fixture();
assert.deepEqual(await chainedImportSymbols(thinOutOfRange.file, 3), [],
  'thin Mach-O accepted a nonzero out-of-range slice index');

for (const malformed of [
  { reserved2: 10, sectionSize: 20 }, // not instruction-aligned
  { reserved2: 16, sectionSize: 12 }, // entry exceeds section
  { reserved2: 8, sectionSize: 12 },  // section is not an exact entry multiple
]) {
  const value = fixture(malformed);
  assert.deepEqual(await chainedImportSymbols(value.file, 0), [],
    `incoherent stub geometry was decoded: ${JSON.stringify(malformed)}`);
}

console.log('issue #6309 chained stub-width regression: PASS');
