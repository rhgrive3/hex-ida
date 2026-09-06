import assert from 'node:assert/strict';
import { chainedImportSymbols } from '../../js/chained.js';

const VMADDR = 0x100000000n;
const STUB_OFFSET = 0x200;
const FIXUPS_OFFSET = 0x1800;
const ADRP_X16 = 0x90000010;
const ADRP_X17_NEXT_PAGE = 0xb0000011;
const LDR_X17_X16_300 = 0xf9418211;
const LDR_X16_X17_300 = 0xf9418230;
const LDR_X16_X0 = 0xf9400010;
const MOV_X16_X0 = 0xaa0003f0;
const MOV_X15_X0 = 0xaa0003ef;
const NOP = 0xd503201f;
const BR_X17 = 0xd61f0220;
const BR_X16 = 0xd61f0200;

function fixture(words, { slotOffset = 0x300 } = {}) {
  const stubSize = words.length * 4;
  const thin = new Uint8Array(0x2000);
  const dv = new DataView(thin.buffer);
  const stub = VMADDR + BigInt(STUB_OFFSET);
  const slot = VMADDR + BigInt(slotOffset);

  // mach_header_64 with one LC_SEGMENT_64 and LC_DYLD_CHAINED_FIXUPS.
  dv.setUint32(0, 0xfeedfacf, true);
  dv.setInt32(4, 0x0100000c, true);
  dv.setUint32(12, 2, true);
  dv.setUint32(16, 2, true);
  dv.setUint32(20, 168, true);

  const seg = 32;
  dv.setUint32(seg, 0x19, true);
  dv.setUint32(seg + 4, 152, true);
  new TextEncoder().encodeInto('__TEXT', thin.subarray(seg + 8, seg + 24));
  dv.setBigUint64(seg + 24, VMADDR, true);
  dv.setBigUint64(seg + 32, BigInt(thin.length), true);
  dv.setBigUint64(seg + 40, 0n, true);
  dv.setBigUint64(seg + 48, BigInt(thin.length), true);
  dv.setUint32(seg + 64, 1, true);

  const sec = seg + 72;
  new TextEncoder().encodeInto('__stubs', thin.subarray(sec, sec + 16));
  new TextEncoder().encodeInto('__TEXT', thin.subarray(sec + 16, sec + 32));
  dv.setBigUint64(sec + 32, stub, true);
  dv.setBigUint64(sec + 40, BigInt(stubSize), true);
  dv.setUint32(sec + 48, STUB_OFFSET, true);
  dv.setUint32(sec + 64, 0x8, true);
  dv.setUint32(sec + 72, stubSize, true);

  const command = seg + 152;
  dv.setUint32(command, 0x80000034, true);
  dv.setUint32(command + 4, 16, true);
  dv.setUint32(command + 8, FIXUPS_OFFSET, true);
  dv.setUint32(command + 12, 0x80, true);

  words.forEach((word, i) => dv.setUint32(STUB_OFFSET + i * 4, word, true));
  dv.setBigUint64(slotOffset, 1n << 63n, true); // ordinal 0, PTR_64 bind.

  const fixups = FIXUPS_OFFSET;
  dv.setUint32(fixups + 4, 28, true);
  dv.setUint32(fixups + 8, 64, true);
  dv.setUint32(fixups + 12, 68, true);
  dv.setUint32(fixups + 16, 1, true);
  dv.setUint32(fixups + 20, 1, true);
  dv.setUint32(fixups + 24, 0, true);
  dv.setUint32(fixups + 28, 1, true);
  dv.setUint32(fixups + 32, 8, true);
  dv.setUint32(fixups + 36, 24, true);
  dv.setUint16(fixups + 40, 0x1000, true);
  dv.setUint16(fixups + 42, 2, true);
  dv.setUint16(fixups + 56, 1, true);
  new TextEncoder().encodeInto('_target\0', thin.subarray(fixups + 68));

  return { file: new Blob([thin]), stub, slot };
}

async function expectRecovered(words, options = {}) {
  const fx = fixture(words, options);
  assert.deepEqual(await chainedImportSymbols(fx.file, 0), [
    { addr: fx.stub, name: '_target', kind: 1 },
    { addr: fx.slot, name: '_target', kind: 2 },
  ]);
}

await expectRecovered([ADRP_X16, LDR_X17_X16_300, BR_X17]);

const clobbered = fixture([ADRP_X16, MOV_X16_X0, LDR_X17_X16_300, BR_X17]);
assert.deepEqual(await chainedImportSymbols(clobbered.file, 0), [],
  'MOV clobber must invalidate the stale ADRP base even when its old slot contains a valid bind');

await expectRecovered([ADRP_X16, MOV_X15_X0, LDR_X17_X16_300, BR_X17]);
await expectRecovered([ADRP_X16, NOP, LDR_X17_X16_300, BR_X17]);

const loadClobber = fixture([ADRP_X16, LDR_X16_X0, LDR_X17_X16_300, BR_X17]);
assert.deepEqual(await chainedImportSymbols(loadClobber.file, 0), [],
  'an unrelated LDR that overwrites the base register must invalidate ADRP provenance');

await expectRecovered(
  [ADRP_X16, ADRP_X17_NEXT_PAGE, LDR_X16_X17_300, BR_X16],
  { slotOffset: 0x1300 },
);

console.log('issue #3778 chained stub base-provenance regression: PASS');
