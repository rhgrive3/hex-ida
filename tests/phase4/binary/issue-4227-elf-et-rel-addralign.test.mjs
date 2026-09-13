import assert from 'node:assert/strict';
import { parseELF } from '../../../js/binary/elf.js';

function makeRelocatableElf64({ textAlign = 0x02000000n, textSize = 0x80n } = {}) {
  const bytes = new Uint8Array(0x800);
  const view = new DataView(bytes.buffer);
  const w16 = (o, x) => view.setUint16(o, Number(x), true);
  const w32 = (o, x) => view.setUint32(o, Number(x), true);
  const w64 = (o, x) => view.setBigUint64(o, BigInt(x), true);
  const wi64 = (o, x) => view.setBigInt64(o, BigInt(x), true);

  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0);
  w16(16, 1); // ET_REL
  w16(18, 62); // EM_X86_64
  w32(20, 1);
  w64(40, 0x500);
  w16(52, 64);
  w16(58, 64);
  w16(60, 7);
  w16(62, 6);

  bytes[0x100] = 0x90; // preceding one-byte section makes cursor unaligned
  bytes.fill(0x90, 0x120, 0x1a0);
  const strtab = new TextEncoder().encode('\0func\0ext\0');
  bytes.set(strtab, 0x1c0);
  const sym = (p, name, info, shndx, value, size) => {
    w32(p, name); bytes[p + 4] = info; bytes[p + 5] = 0; w16(p + 6, shndx); w64(p + 8, value); w64(p + 16, size);
  };
  sym(0x200, 0, 0, 0, 0, 0);
  sym(0x218, 1, 0x12, 2, 0x10n, 0x10n);
  sym(0x230, 6, 0x12, 0, 0, 0);
  w64(0x260, 0x20n);
  w64(0x268, (2n << 32n) | 1n); // ext + R_X86_64_64
  wi64(0x270, 0n);

  const shstr = new TextEncoder().encode('\0.pad\0.text\0.strtab\0.symtab\0.rela.text\0.shstrtab\0');
  bytes.set(shstr, 0x300);
  const names = { pad: 1, text: 6, str: 12, sym: 20, rela: 28, shstr: 39 };
  const sh = (i, name, type, flags, off, size, link = 0, info = 0, align = 1n, entsize = 0n) => {
    const p = 0x500 + i * 64;
    w32(p, name); w32(p + 4, type); w64(p + 8, flags); w64(p + 16, 0); w64(p + 24, off); w64(p + 32, size);
    w32(p + 40, link); w32(p + 44, info); w64(p + 48, align); w64(p + 56, entsize);
  };
  sh(0, 0, 0, 0n, 0, 0, 0, 0, 0n, 0n);
  sh(1, names.pad, 1, 0n, 0x100, 1, 0, 0, 1n, 0n);
  sh(2, names.text, 1, 0x6n, 0x120, textSize, 0, 0, textAlign, 0n);
  sh(3, names.str, 3, 0n, 0x1c0, strtab.length, 0, 0, 1n, 0n);
  sh(4, names.sym, 2, 0n, 0x200, 72, 3, 1, 8n, 24n);
  sh(5, names.rela, 4, 0n, 0x260, 24, 4, 2, 8n, 24n);
  sh(6, names.shstr, 3, 0n, 0x300, shstr.length, 0, 0, 1n, 0n);
  return bytes;
}

function textOf(image) {
  const text = image.sections.find((section) => section.name === '.text');
  assert.ok(text);
  return text;
}

for (const [alignment, expected] of [
  [1n, 0x100000001n],
  [0x1000n, 0x100001000n],
  [0x1000000n, 0x101000000n],
  [0x2000000n, 0x102000000n],
  [0x4000000n, 0x104000000n],
  [1n << 40n, 1n << 40n],
]) {
  const image = parseELF(makeRelocatableElf64({ textAlign: alignment }));
  const text = textOf(image);
  assert.equal(text.address, expected, `synthetic address must preserve sh_addralign=${alignment}`);
  assert.equal(text.address % alignment, 0n);
  const fn = image.symbols.find((symbol) => symbol.name === 'func');
  assert.equal(fn?.address, text.address + 0x10n, 'ET_REL symbol identity follows aligned synthetic section base');
  assert.equal(image.relocations[0]?.address, text.address + 0x20n, 'ET_REL relocation identity follows aligned synthetic section base');
}

for (const alignment of [3n, 6n, 0x1800000n]) {
  const image = parseELF(makeRelocatableElf64({ textAlign: alignment }));
  const text = textOf(image);
  assert.equal(text.source, 'unmapped-section', 'invalid non-power-of-two sh_addralign must not become canonical synthetic mapping');
  assert.equal(image.metadata.elfMetadata?.complete, false);
  assert.ok(image.metadata.elfMetadata?.reasons?.some((reason) => reason.includes('section-addralign')));
  assert.equal(image.symbols.find((symbol) => symbol.name === 'func')?.address, null);
  assert.equal(image.relocations.length, 0, 'relocations targeting an invalid synthetic section must fail closed');
}

const zeroSizedInvalid = parseELF(makeRelocatableElf64({ textAlign: 3n, textSize: 0n }));
const zeroSizedText = textOf(zeroSizedInvalid);
assert.equal(zeroSizedText.source, 'unmapped-section', 'zero-sized ET_REL sections must still validate sh_addralign');
assert.equal(zeroSizedInvalid.metadata.elfMetadata?.complete, false);
assert.ok(zeroSizedInvalid.metadata.elfMetadata?.reasons?.some((reason) => reason.includes('section-addralign')));

console.log('issue #4227 ET_REL sh_addralign synthetic-layout regression: PASS');
