import test from 'node:test';
import assert from 'node:assert/strict';
import { parseELF } from '../../../js/binary/elf-core.js';
import { makeElf64Fixture } from '../../universal-binary.mjs';
import { makeSectionlessElf64Fixture } from '../../universal-binary-sectionless.mjs';

const EM_AARCH64 = 183;
const EM_X86_64 = 62;
const STT_FUNC = 2;
const STT_GNU_IFUNC = 10;

function sectionBackedFixture({ elfType = 1, machine = EM_AARCH64, value = 2n, symbolType = STT_FUNC } = {}) {
  const bytes = makeElf64Fixture();
  const view = new DataView(bytes.buffer);
  view.setUint16(16, elfType, true);
  view.setUint16(18, machine, true);
  bytes[0x190 + 4] = (1 << 4) | symbolType; // STB_GLOBAL | caller-selected type
  view.setBigUint64(0x190 + 8, value, true);
  view.setBigUint64(0x190 + 16, 4n, true);
  if (elfType === 1) {
    // ET_REL has no runtime program-header authority; section-relative
    // synthetic addresses are assigned by the parser.
    view.setBigUint64(24, 0n, true);
    view.setBigUint64(32, 0n, true);
    view.setUint16(56, 0, true);
  }
  return bytes;
}

function sectionlessDynamicFixture({ machine = EM_AARCH64, value = 0x400182n, symbolType = STT_FUNC } = {}) {
  const bytes = makeSectionlessElf64Fixture();
  const view = new DataView(bytes.buffer);
  view.setUint16(18, machine, true);
  if (machine === EM_AARCH64) {
    // The shared sectionless fixture carries an x86-64 JUMP_SLOT (type 7).
    // Keep this symbol-alignment fixture structurally valid after AArch64
    // relocation-width validation by using R_AARCH64_JUMP_SLOT (1026).
    view.setBigUint64(0x3a8, (1n << 32n) | 1026n, true);
  }
  // dynsym[1] lives at 0x358 in the shared fixture. SHN_ABS gives the
  // sectionless PT_DYNAMIC path a known defined symbol identity while the
  // executable PT_LOAD remains the canonical function-owner authority.
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

function namedSymbol(image, name) {
  return image.symbols.find((symbol) => symbol.name === name) ?? null;
}

test('AArch64 ET_REL misaligned STT_FUNC stays raw metadata and cannot mint exact function truth', () => {
  const image = parseELF(sectionBackedFixture());
  assert.equal(image.arch, 'arm64');
  assert.equal(namedSymbol(image, 'myfunc')?.address % 4n, 2n, 'malformed raw symbol is retained for diagnosis');
  assert.equal(symbolSeed(image), null);
  assert.equal(image.metadata.elfMetadata.complete, false);
  assert.ok(image.metadata.elfMetadata.reasons.includes('symbols:3:function-alignment'));
  assert.ok(image.warnings.some((warning) => warning.includes('myfunc') && warning.includes('4-byte alignment')));
});

test('AArch64 aligned ET_REL STT_FUNC keeps existing exact function authority', () => {
  const image = parseELF(sectionBackedFixture({ value: 4n }));
  const seed = symbolSeed(image);
  assert.ok(seed);
  assert.equal(seed.exactFunctionStart, true);
  assert.equal(seed.confidence, 0.995);
  assert.equal(image.metadata.elfMetadata.complete, true);
});

test('AArch64 section-backed ET_DYN misaligned STT_FUNC is rejected after executable extent validation', () => {
  const image = parseELF(sectionBackedFixture({ elfType: 3, value: 0x401002n }));
  assert.equal(namedSymbol(image, 'myfunc')?.address, 0x401002n);
  assert.equal(symbolSeed(image), null);
  assert.equal(image.metadata.elfMetadata.complete, false);
  assert.ok(image.metadata.elfMetadata.reasons.includes('symbols:3:function-alignment'));
});

test('AArch64 misaligned STT_GNU_IFUNC resolver cannot mint exact resolver truth', () => {
  const image = parseELF(sectionBackedFixture({ symbolType: STT_GNU_IFUNC }));
  assert.equal(namedSymbol(image, 'myfunc')?.kind, 'indirect-function');
  assert.equal(symbolSeed(image, 'ifunc-resolver'), null);
  assert.equal(image.metadata.elfMetadata.complete, false);
});

test('sectionless PT_DYNAMIC AArch64 misaligned STT_FUNC stays raw and is diagnosed', () => {
  const image = parseELF(sectionlessDynamicFixture());
  assert.equal(namedSymbol(image, 'puts')?.address, 0x400182n);
  assert.equal(symbolSeed(image), null);
  assert.equal(image.metadata.programDynamicPartial, true);
  assert.ok(image.metadata.programDynamicDiagnostics?.some((message) => message.includes('puts') && message.includes('4-byte alignment')));
});

test('sectionless PT_DYNAMIC AArch64 aligned STT_FUNC keeps exact function authority', () => {
  const image = parseELF(sectionlessDynamicFixture({ value: 0x400184n }));
  const seed = symbolSeed(image);
  assert.ok(seed);
  assert.equal(seed.address, 0x400184n);
  assert.equal(seed.exactFunctionStart, true);
  assert.equal(image.metadata.programDynamicPartial, undefined);
});

test('sectionless PT_DYNAMIC AArch64 misaligned STT_GNU_IFUNC resolver is rejected', () => {
  const image = parseELF(sectionlessDynamicFixture({ symbolType: STT_GNU_IFUNC }));
  assert.equal(namedSymbol(image, 'puts')?.kind, 'indirect-function');
  assert.equal(symbolSeed(image, 'ifunc-resolver'), null);
  assert.equal(image.metadata.programDynamicPartial, true);
});

test('x86_64 symbol starts retain byte-granular alignment semantics', () => {
  const image = parseELF(sectionBackedFixture({ machine: EM_X86_64 }));
  const seed = symbolSeed(image);
  assert.ok(seed);
  assert.equal(seed.address % 4n, 2n);
  assert.equal(seed.exactFunctionStart, true);
  assert.equal(image.metadata.elfMetadata.complete, true);
});
