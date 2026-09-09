import assert from 'node:assert/strict';
import {
  augmentAnalysisResultWithChainedImports,
  chainedImportSymbols,
} from '../../../js/chained.js';

const VMADDR = 0x100000000n;
const FIXUPS_OFFSET = 0x1800;
const SLOT_OFFSET = 0x300;
const ADRP_X16 = 0x90000010;
const LDR_X17_X16_300 = 0xf9418211;
const BR_X17 = 0xd61f0220;
const STUB_SIZE = 12;

function fixture({
  stubAddr = VMADDR + 0x200n,
  stubOffset = 0x200,
  segmentVmsize = 0x1000n,
  segmentFilesize = 0x1000n,
} = {}) {
  const thin = new Uint8Array(0x2000);
  const dv = new DataView(thin.buffer);
  const slot = VMADDR + BigInt(SLOT_OFFSET);

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
  dv.setBigUint64(seg + 32, segmentVmsize, true);
  dv.setBigUint64(seg + 40, 0n, true);
  dv.setBigUint64(seg + 48, segmentFilesize, true);
  dv.setUint32(seg + 64, 1, true);

  const sec = seg + 72;
  new TextEncoder().encodeInto('__stubs', thin.subarray(sec, sec + 16));
  new TextEncoder().encodeInto('__TEXT', thin.subarray(sec + 16, sec + 32));
  dv.setBigUint64(sec + 32, stubAddr, true);
  dv.setBigUint64(sec + 40, BigInt(STUB_SIZE), true);
  dv.setUint32(sec + 48, stubOffset, true);
  dv.setUint32(sec + 64, 0x8, true);
  dv.setUint32(sec + 72, STUB_SIZE, true);

  const command = seg + 152;
  dv.setUint32(command, 0x80000034, true);
  dv.setUint32(command + 4, 16, true);
  dv.setUint32(command + 8, FIXUPS_OFFSET, true);
  dv.setUint32(command + 12, 0x80, true);

  [ADRP_X16, LDR_X17_X16_300, BR_X17]
    .forEach((word, i) => dv.setUint32(stubOffset + i * 4, word, true));
  dv.setBigUint64(SLOT_OFFSET, 1n << 63n, true); // ordinal 0, PTR_64 bind.

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

  return { file: new Blob([thin]), stub: stubAddr, slot };
}

function emptyResult() {
  return {
    addrs: new BigUint64Array(0),
    kinds: new Uint8Array(0),
    flags: new Uint8Array(0),
    names: [],
  };
}

async function expectRejected(options, label) {
  const fx = fixture(options);
  assert.deepEqual(await chainedImportSymbols(fx.file, 0), [], `${label}: public recovery path must reject escaped stubs`);

  const augmented = await augmentAnalysisResultWithChainedImports(fx.file, 0, emptyResult());
  assert.equal(augmented.addrs.length, 0, `${label}: augmentation must not publish an arbitrary-VA symbol`);
  assert.deepEqual(augmented.names, []);
}

const valid = fixture();
assert.deepEqual(await chainedImportSymbols(valid.file, 0), [
  { addr: valid.stub, name: '_target', kind: 1 },
  { addr: valid.slot, name: '_target', kind: 2 },
], 'fully contained S_SYMBOL_STUBS remains recoverable');
const validAugmented = await augmentAnalysisResultWithChainedImports(valid.file, 0, emptyResult());
assert.deepEqual(Array.from(validAugmented.addrs), [valid.stub, valid.slot]);
assert.deepEqual(validAugmented.names, ['_target', '_target']);

await expectRejected({
  segmentVmsize: 0x400n,
  stubAddr: VMADDR + 0x400n,
}, 'VM escape');

await expectRejected({
  segmentFilesize: 0x400n,
  stubOffset: 0x500,
}, 'file escape within slice');

await expectRejected({
  segmentVmsize: 0x40bn,
  stubAddr: VMADDR + 0x400n,
}, 'section end one byte past parent VM end');

console.log('issue #3787 chained stub public-path containment regression: PASS');
