import test from 'node:test';
import assert from 'node:assert/strict';
import { parseELF } from '../../../js/binary/elf-core.js';
import { makeElf64Fixture } from '../../universal-binary.mjs';
import { makeSectionlessElf64Fixture } from '../../universal-binary-sectionless.mjs';

const EM_RISCV = 243;
const STT_FUNC = 2;
const STT_GNU_IFUNC = 10;

function sectionBackedFixture({ elfType = 1, machine = EM_RISCV, value = 1n, symbolType = STT_FUNC } = {}) {
  const bytes = makeElf64Fixture();
  const view = new DataView(bytes.buffer);
  view.setUint16(16, elfType, true);
  view.setUint16(18, machine, true);
  bytes[0x190 + 4] = (1 << 4) | symbolType;
  view.setBigUint64(0x190 + 8, value, true);
  view.setBigUint64(0x190 + 16, 4n, true);
  if (elfType === 1) {
    view.setBigUint64(24, 0n, true);
    view.setBigUint64(32, 0n, true);
    view.setUint16(56, 0, true);
  }
  return bytes;
}

function sectionlessDynamicFixture({ machine = EM_RISCV, value = 0x400181n, symbolType = STT_FUNC } = {}) {
  const bytes = makeSectionlessElf64Fixture();
  const view = new DataView(bytes.buffer);
  view.setUint16(18, machine, true);
  bytes[0x358 + 4] = (1 << 4) | symbolType;
  view.setUint16(0x358 + 6, 0xfff1, true); // SHN_ABS
  view.setBigUint64(0x358 + 8, value, true);
  view.setBigUint64(0x358 + 16, 4n, true);
  return bytes;
}

function symbolSeed(image, source = 'symbol') {
  return image.functions.find((fn) => fn.source === source && fn.name?.startsWith('myfunc'))
    ?? image.functions.find((fn) => fn.source === source && fn.name?.startsWith('puts'))
    ?? null;
}

test('issue #8163: RISC-V odd STT_FUNC address cannot mint exact function start', () => {
  const image = parseELF(sectionBackedFixture({ value: 1n }));
  assert.equal(image.arch, 'riscv64');
  assert.equal(symbolSeed(image), null);
  assert.equal(image.metadata.elfMetadata.complete, false);
  assert.ok(image.metadata.elfMetadata.reasons.includes('symbols:3:function-alignment'));
});

test('issue #8163: RISC-V 2-byte aligned STT_FUNC keeps exact function start when compressed ISA is supported', () => {
  const image = parseELF(sectionBackedFixture({ value: 2n }));
  assert.equal(image.arch, 'riscv64');
  const seed = symbolSeed(image);
  assert.ok(seed);
  assert.equal(seed.exactFunctionStart, true);
});

test('issue #8163: sectionless PT_DYNAMIC RISC-V odd STT_FUNC cannot mint function start and is diagnosed', () => {
  const image = parseELF(sectionlessDynamicFixture({ value: 0x400181n }));
  assert.equal(symbolSeed(image), null);
  assert.equal(image.metadata.programDynamicPartial, true);
  assert.ok(image.metadata.programDynamicDiagnostics?.some((msg) => msg.includes('riscv')));
});

test('issue #8163: RISC-V odd STT_GNU_IFUNC resolver is rejected', () => {
  const image = parseELF(sectionBackedFixture({ value: 1n, symbolType: STT_GNU_IFUNC }));
  assert.equal(symbolSeed(image, 'ifunc-resolver'), null);
  assert.equal(image.metadata.elfMetadata.complete, false);
});
