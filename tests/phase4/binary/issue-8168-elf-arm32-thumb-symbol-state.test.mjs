import test from 'node:test';
import assert from 'node:assert/strict';
import { parseELF } from '../../../js/binary/elf-core.js';

function makeElf32ArmFixture({ elfType = 1, value = 1, size = 16, funcSize = 4 } = {}) {
  const b = new Uint8Array(0x400);
  const v = new DataView(b.buffer);
  const w16 = (o, x) => v.setUint16(o, x, true);
  const w32 = (o, x) => v.setUint32(o, x, true);

  // ELF32 LE
  b.set([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1, 0], 0);
  w16(16, elfType);
  w16(18, 40); // EM_ARM
  w32(20, 1);
  w32(24, elfType === 1 ? 0 : 0x1000);
  w32(28, 0);
  const shoff = 0x200;
  w32(32, shoff);
  w32(36, 0);
  w16(40, 52);
  w16(42, 32);
  w16(44, 0);
  w16(46, 40);
  w16(48, 5);
  w16(50, 4);

  const textOff = 0x80;
  const strtabOff = 0x100;
  const strtab = new TextEncoder().encode('\0thumb_fn\0');
  b.set(strtab, strtabOff);

  const symtabOff = 0x140;
  w32(symtabOff + 16, 1); // name = "thumb_fn"
  w32(symtabOff + 16 + 4, value);
  w32(symtabOff + 16 + 8, funcSize);
  b[symtabOff + 16 + 12] = 0x12; // STB_GLOBAL | STT_FUNC
  b[symtabOff + 16 + 13] = 0;
  w16(symtabOff + 16 + 14, 1);

  const shstrOff = 0x180;
  const shstr = new TextEncoder().encode('\0.text\0.strtab\0.symtab\0.shstrtab\0');
  b.set(shstr, shstrOff);
  const nameOff = { text: 1, strtab: 7, symtab: 15, shstrtab: 23 };

  const sh = (i, name, type, flags, addr, off, sz, link = 0, info = 0, align = 4, entsize = 0) => {
    const p = shoff + i * 40;
    w32(p, name);
    w32(p + 4, type);
    w32(p + 8, flags);
    w32(p + 12, addr);
    w32(p + 16, off);
    w32(p + 20, sz);
    w32(p + 24, link);
    w32(p + 28, info);
    w32(p + 32, align);
    w32(p + 36, entsize);
  };

  sh(0, 0, 0, 0, 0, 0, 0);
  sh(1, nameOff.text, 1, 0x6, elfType === 1 ? 0 : 0x1000, textOff, size, 0, 0, 4, 0);
  sh(2, nameOff.strtab, 3, 0, 0, strtabOff, strtab.length);
  sh(3, nameOff.symtab, 2, 0, 0, symtabOff, 32, 2, 1, 4, 16);
  sh(4, nameOff.shstrtab, 3, 0, 0, shstrOff, shstr.length);

  return b;
}

test('issue #8168: ARM32 Thumb STT_FUNC state bit is masked to mint even canonical function start', () => {
  // st_value = 1 (Thumb function at offset 0)
  const bytes = makeElf32ArmFixture({ value: 1 });
  const image = parseELF(bytes);
  assert.equal(image.arch, 'arm');

  const sym = image.symbols.find((s) => s.name === 'thumb_fn');
  assert.ok(sym);
  // Canonical address must have bit 0 stripped (even address)
  assert.equal(sym.address % 2n, 0n, 'symbol address must be even');

  const fn = image.functions.find((f) => f.name === 'thumb_fn');
  assert.ok(fn);
  assert.equal(fn.address % 2n, 0n, 'function start must be even');
});

test('issue #8168: ARM32 Thumb STT_FUNC at section end is not rejected due to state bit', () => {
  // Section size 16, function at offset 12 with size 4.
  // Thumb st_value = 13 (12 | 1)
  const bytes = makeElf32ArmFixture({ value: 13, size: 16, funcSize: 4 });
  const image = parseELF(bytes);
  const fn = image.functions.find((f) => f.name === 'thumb_fn');
  assert.ok(fn, 'function at section end must be accepted');
  assert.equal(fn.exactFunctionStart, true);
  assert.equal(fn.address % 2n, 0n);
});
