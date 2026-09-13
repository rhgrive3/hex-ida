import test from 'node:test';
import assert from 'node:assert/strict';
import { parseELF } from '../../../js/binary/elf-core.js';
import { makeSectionlessElf64 } from '../../issue-8096-elf-unmapped-relocation-target.mjs';

const BASE = 0x400000n;
const R_X86_64_RELATIVE = 8;

test('issue #3852: valid ELF64 DT_RELA with size=24, ent=24 is complete', () => {
  const bytes = makeSectionlessElf64({
    rela: [{ off: BASE + 0x40n, sym: 0, type: R_X86_64_RELATIVE, addend: 0x10n }],
  });
  const image = parseELF(bytes);
  assert.equal(image.metadata.programDynamicPartial, undefined);
  assert.equal(image.metadata.programDynamicDiagnostics, undefined);
  assert.equal(image.relocations.length, 1);
});

test('issue #3852: ELF64 DT_RELA with trailing bytes (size=25, ent=24) triggers programDynamicPartial', () => {
  const bytes = makeSectionlessElf64({
    rela: [{ off: BASE + 0x40n, sym: 0, type: R_X86_64_RELATIVE, addend: 0x10n }],
  });
  // Find DT_RELASZ (tag 8n) in PT_DYNAMIC and change 24n to 25n
  const view = new DataView(bytes.buffer);
  // tags start at 0x100
  let found = false;
  for (let i = 0; i < 20; i++) {
    const tag = view.getBigInt64(0x100 + i * 16, true);
    if (tag === 8n) { // DT_RELASZ
      view.setBigUint64(0x108 + i * 16, 25n, true);
      found = true;
      break;
    }
  }
  assert.ok(found, 'DT_RELASZ must be found in fixture');
  const image = parseELF(bytes);
  assert.equal(image.metadata.programDynamicPartial, true);
  assert.ok(image.metadata.programDynamicDiagnostics?.some((d) => d.includes('PT_DYNAMIC-RELA size 25 is not a multiple of entry size 24')));
  assert.equal(image.relocations.length, 1, 'valid entry is still decoded best-effort');
});

test('issue #3852: ELF64 DT_JMPREL with trailing bytes (size 25, ent 24) triggers programDynamicPartial', () => {
  const bytes = makeSectionlessElf64({
    jmprel: [{ off: BASE + 0x40n, sym: 0, addend: 0x10n }],
  });
  const view = new DataView(bytes.buffer);
  let found = false;
  for (let i = 0; i < 20; i++) {
    const tag = view.getBigInt64(0x100 + i * 16, true);
    if (tag === 2n) { // DT_PLTRELSZ
      view.setBigUint64(0x108 + i * 16, 25n, true);
      found = true;
      break;
    }
  }
  assert.ok(found, 'DT_PLTRELSZ must be found in fixture');
  const image = parseELF(bytes);
  assert.equal(image.metadata.programDynamicPartial, true);
  assert.ok(image.metadata.programDynamicDiagnostics?.some((d) => d.includes('PT_DYNAMIC-JMPREL-RELA size 25 is not a multiple of entry size 24')));
  assert.equal(image.relocations.length, 1);
});
