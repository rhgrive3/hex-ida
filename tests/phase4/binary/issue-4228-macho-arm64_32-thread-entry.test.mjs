import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMachO } from '../../../js/binary/macho.js';
import { openBinarySource } from '../../../js/binary/source-loaders.js';
import { MemoryByteSource } from '../../../js/binary/source.js';

const CPU_TYPE_ARM64 = 0x0100000c;
const CPU_TYPE_ARM64_32 = 0x0200000c;
const MH_EXECUTE = 2;
const LC_SEGMENT_64 = 0x19;
const LC_THREAD = 0x4;
const LC_UNIXTHREAD = 0x5;
const LC_MAIN = 0x80000028;
const ARM_THREAD_STATE64 = 6;
const ARM_THREAD_STATE64_COUNT = 68;
const BASE = 0x100000000n;

function putName(bytes, offset, name) {
  bytes.set(new TextEncoder().encode(name).subarray(0, 16), offset);
}

function machoThreadFixture({ cpu = CPU_TYPE_ARM64_32, pc = BASE + 0x100n, mainEntryoff = null, threadCommand = LC_UNIXTHREAD, flavor = ARM_THREAD_STATE64, count = ARM_THREAD_STATE64_COUNT } = {}) {
  const segmentCommandSize = 72;
  const threadCommandSize = 16 + count * 4;
  const mainCommandSize = mainEntryoff == null ? 0 : 24;
  const sizeofcmds = segmentCommandSize + threadCommandSize + mainCommandSize;
  const bytes = new Uint8Array(32 + sizeofcmds);
  const view = new DataView(bytes.buffer);

  bytes.set([0xcf, 0xfa, 0xed, 0xfe], 0);
  view.setInt32(4, cpu, true);
  view.setInt32(8, 0, true);
  view.setUint32(12, MH_EXECUTE, true);
  view.setUint32(16, mainEntryoff == null ? 2 : 3, true);
  view.setUint32(20, sizeofcmds, true);
  view.setUint32(24, 0, true);
  view.setUint32(28, 0, true);

  let p = 32;
  view.setUint32(p, LC_SEGMENT_64, true);
  view.setUint32(p + 4, segmentCommandSize, true);
  putName(bytes, p + 8, '__TEXT');
  view.setBigUint64(p + 24, BASE, true);
  view.setBigUint64(p + 32, 0x1000n, true);
  view.setBigUint64(p + 40, 0n, true);
  view.setBigUint64(p + 48, BigInt(bytes.length), true);
  view.setInt32(p + 56, 5, true);
  view.setInt32(p + 60, 5, true);
  view.setUint32(p + 64, 0, true);
  view.setUint32(p + 68, 0, true);

  p += segmentCommandSize;
  view.setUint32(p, threadCommand, true);
  view.setUint32(p + 4, threadCommandSize, true);
  view.setUint32(p + 8, flavor, true);
  view.setUint32(p + 12, count, true);
  if (count >= 66) view.setBigUint64(p + 16 + 256, pc, true);

  if (mainEntryoff != null) {
    p += threadCommandSize;
    view.setUint32(p, LC_MAIN, true);
    view.setUint32(p + 4, mainCommandSize, true);
    view.setBigUint64(p + 8, BigInt(mainEntryoff), true);
    view.setBigUint64(p + 16, 0n, true);
  }
  return bytes;
}

function assertThreadEntrypoint(image, expected) {
  assert.equal(image.arch, 'arm64_32');
  assert.equal(image.entrypoint, expected);
  assert.equal(image.metadata.entrypointSource, 'LC_UNIXTHREAD');
  assert.equal(image.metadata.entrypointValid, true);
  assert.ok(image.functions.some((fn) => fn.address === expected && fn.source === 'entrypoint'));
}

test('ARM64_32 LC_UNIXTHREAD decodes ARM_THREAD_STATE64 PC', () => {
  const expected = BASE + 0x100n;
  assertThreadEntrypoint(parseMachO(machoThreadFixture({ pc: expected })), expected);
});

test('ARM64_32 LC_THREAD shares the ARM_THREAD_STATE64 PC path', () => {
  const expected = BASE + 0x110n;
  assertThreadEntrypoint(parseMachO(machoThreadFixture({ pc: expected, threadCommand: LC_THREAD })), expected);
});

test('malformed ARM64_32 thread state is not promoted to entrypoint truth', () => {
  assert.equal(parseMachO(machoThreadFixture({ count: ARM_THREAD_STATE64_COUNT - 1 })).entrypoint, null);
  assert.equal(parseMachO(machoThreadFixture({ flavor: ARM_THREAD_STATE64 + 1 })).entrypoint, null);
});

test('source-backed ARM64_32 uses the same thread entrypoint semantics', async () => {
  const expected = BASE + 0x120n;
  const bytes = machoThreadFixture({ pc: expected });
  const image = await openBinarySource(new MemoryByteSource(bytes), {
    ranges: { pageSize: 64, maxPageSize: 256, maxCachedBytes: 4096, maxReads: 32 },
  });
  assertThreadEntrypoint(image, expected);
  assert.equal(image.metadata.sourceBacked, true);
});

test('ARM64 ARM_THREAD_STATE64 control remains decoded', () => {
  const expected = BASE + 0x140n;
  const image = parseMachO(machoThreadFixture({ cpu: CPU_TYPE_ARM64, pc: expected }));
  assert.equal(image.arch, 'arm64');
  assert.equal(image.entrypoint, expected);
  assert.equal(image.metadata.entrypointValid, true);
});

test('ARM64_32 thread PC still requires an executable aligned mapping', () => {
  const unmapped = parseMachO(machoThreadFixture({ pc: BASE + 0x2000n }));
  assert.equal(unmapped.entrypoint, BASE + 0x2000n);
  assert.equal(unmapped.metadata.entrypointValid, false);
  assert.ok(!unmapped.functions.some((fn) => fn.address === BASE + 0x2000n && fn.source === 'entrypoint'));

  const misaligned = parseMachO(machoThreadFixture({ pc: BASE + 0x102n }));
  assert.equal(misaligned.entrypoint, BASE + 0x102n);
  assert.equal(misaligned.metadata.entrypointValid, false);
  assert.ok(!misaligned.functions.some((fn) => fn.address === BASE + 0x102n && fn.source === 'entrypoint'));
});

test('LC_MAIN keeps priority over ARM64_32 LC_UNIXTHREAD', () => {
  const image = parseMachO(machoThreadFixture({ pc: BASE + 0x180n, mainEntryoff: 0x100n }));
  assert.equal(image.entrypoint, BASE + 0x100n);
  assert.equal(image.metadata.entrypointSource, 'LC_MAIN');
  assert.equal(image.metadata.entrypointValid, true);
});
