import test from 'node:test';
import assert from 'node:assert/strict';
import { openBinary } from '../js/binary/index.js';
import { MemoryByteSource } from '../js/binary/source.js';
import { parseMachOSource } from '../js/binary/source-loaders.js';
import { machoInstructionUnit } from '../js/binary/macho-instruction-unit.js';

const CPU_X86_64 = 0x01000007;
const CPU_ARM64 = 0x0100000c;
const CPU_SUBTYPE_X86_64_ALL = 3;
const CPU_SUBTYPE_X86_64_H = 8;
const CPU_SUBTYPE_ARM64E = 2;

function makeThin64({ cpu = CPU_X86_64, subtype = CPU_SUBTYPE_X86_64_ALL } = {}) {
  const bytes = new Uint8Array(32);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0xfeedfacf, true);
  view.setInt32(4, cpu, true);
  view.setUint32(8, subtype >>> 0, true);
  view.setUint32(12, 2, true); // MH_EXECUTE
  view.setUint32(16, 0, true); // ncmds
  view.setUint32(20, 0, true); // sizeofcmds
  view.setUint32(24, 0, true);
  view.setUint32(28, 0, true);
  return bytes;
}

function makeFatX86Pair({ haswellSubtype = CPU_SUBTYPE_X86_64_H } = {}) {
  const generic = makeThin64({ subtype: CPU_SUBTYPE_X86_64_ALL });
  const haswell = makeThin64({ subtype: haswellSubtype });
  const firstOffset = 0x1000;
  const secondOffset = 0x2000;
  const bytes = new Uint8Array(secondOffset + haswell.byteLength);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0xcafebabe, false);
  view.setUint32(4, 2, false);
  const writeSlice = (at, subtype, offset, data) => {
    view.setUint32(at, CPU_X86_64, false);
    view.setUint32(at + 4, subtype >>> 0, false);
    view.setUint32(at + 8, offset, false);
    view.setUint32(at + 12, data.byteLength, false);
    view.setUint32(at + 16, 12, false);
    bytes.set(data, offset);
  };
  writeSlice(8, CPU_SUBTYPE_X86_64_ALL, firstOffset, generic);
  writeSlice(28, haswellSubtype, secondOffset, haswell);
  return bytes;
}

test('#4246 thin x86_64h preserves canonical architecture identity', () => {
  const generic = openBinary(makeThin64({ subtype: CPU_SUBTYPE_X86_64_ALL }));
  assert.equal(generic.arch, 'x86_64');
  assert.equal(generic.metadata.subtypeBase, CPU_SUBTYPE_X86_64_ALL);
  assert.equal(generic.metadata.subtypeName, String(CPU_SUBTYPE_X86_64_ALL));

  const haswell = openBinary(makeThin64({ subtype: CPU_SUBTYPE_X86_64_H }));
  assert.equal(haswell.arch, 'x86_64h');
  assert.equal(haswell.metadata.subtypeBase, CPU_SUBTYPE_X86_64_H);
  assert.equal(haswell.metadata.subtypeName, 'x86_64h');
});

test('#4246 subtype capability bits are ignored when deriving x86_64h identity', () => {
  assert.equal(openBinary(makeThin64({ subtype: 0x80000008 })).arch, 'x86_64h');
});

test('#4246 resident universal listing and explicit selection distinguish x86_64/x86_64h', () => {
  const fat = makeFatX86Pair();

  const generic = openBinary(fat, { arch: 'x86_64' });
  assert.deepEqual(generic.metadata.fat.slices.map((slice) => slice.arch), ['x86_64', 'x86_64h']);
  assert.equal(generic.metadata.fat.selected.arch, 'x86_64');
  assert.equal(generic.metadata.fat.selected.offset, 0x1000n);
  assert.equal(generic.arch, 'x86_64');

  const haswell = openBinary(fat, { arch: 'x86_64h' });
  assert.equal(haswell.metadata.fat.selected.arch, 'x86_64h');
  assert.equal(haswell.metadata.fat.selected.offset, 0x2000n);
  assert.equal(haswell.arch, 'x86_64h');
});

test('#4246 source-backed universal selection matches resident selection', async () => {
  const fat = makeFatX86Pair();
  const ranges = { pageSize: 64, maxPageSize: 64, maxCachedBytes: 4096 };

  const generic = await parseMachOSource(new MemoryByteSource(fat, { maxReadLength: 64 }), { arch: 'x86_64', ranges });
  assert.deepEqual(generic.metadata.fat.slices.map((slice) => slice.arch), ['x86_64', 'x86_64h']);
  assert.equal(generic.metadata.fat.selected.arch, 'x86_64');
  assert.equal(generic.metadata.fat.selected.offset, 0x1000n);
  assert.equal(generic.arch, 'x86_64');

  const haswell = await parseMachOSource(new MemoryByteSource(fat, { maxReadLength: 64 }), { arch: 'x86_64h', ranges });
  assert.equal(haswell.metadata.fat.selected.arch, 'x86_64h');
  assert.equal(haswell.metadata.fat.selected.offset, 0x2000n);
  assert.equal(haswell.arch, 'x86_64h');
});

test('#4246 existing arm64e identity remains subtype-aware and unrelated CPUs do not inherit x86_64h', () => {
  assert.equal(openBinary(makeThin64({ cpu: CPU_ARM64, subtype: CPU_SUBTYPE_ARM64E })).arch, 'arm64e');
  assert.equal(openBinary(makeThin64({ cpu: CPU_ARM64, subtype: 0x80000002 })).arch, 'arm64e');
  assert.equal(openBinary(makeThin64({ subtype: 9 })).arch, 'x86_64');
});

test('#4246 x86_64h retains the x86 instruction-width authority', () => {
  assert.equal(machoInstructionUnit('x86_64h'), 1n);
});
