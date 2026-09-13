import assert from 'node:assert/strict';
import { parseELF } from '../js/binary/elf.js';

const BASE = 0x400000n;
const R_X86_64_RELATIVE = 8;
const R_X86_64_32 = 10;
const R_X86_64_JUMP_SLOT = 7;
const UNMAPPED_NEXT_PAGE = BASE + 0x1000n;
const UNMAPPED_FAR = 0x100000000n;

export function makeSectionlessElf64({ exec = false, memsz = 0x300n, rela = null, jmprel = null } = {}) {
  const b = new Uint8Array(0x300);
  const v = new DataView(b.buffer);
  const w16 = (o, x) => v.setUint16(o, x, true);
  const w32 = (o, x) => v.setUint32(o, x, true);
  const w64 = (o, x) => v.setBigUint64(o, BigInt(x), true);
  const wi64 = (o, x) => v.setBigInt64(o, BigInt(x), true);
  b.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0);
  w16(16, exec ? 2 : 3);
  w16(18, 62);
  w32(20, 1);
  w64(24, 0n);
  w64(32, 0x40n);
  w64(40, 0n);
  w32(48, 0);
  w16(52, 64);
  w16(54, 56);
  w16(56, 2);
  w16(58, 64);
  w16(60, 0);
  w16(62, 0);
  const ph = (i, type, off, va, filesz, mem = filesz, flags = 6) => {
    const p = 0x40 + i * 56;
    w32(p, type);
    w32(p + 4, flags);
    w64(p + 8, off);
    w64(p + 16, va);
    w64(p + 24, va);
    w64(p + 32, filesz);
    w64(p + 40, mem);
    w64(p + 48, 0x1000n);
  };
  ph(0, 1, 0, BASE, 0x300n, memsz);
  ph(1, 2, 0x100, BASE + 0x100n, 0x100n);
  const dyn = (i, tag, val) => {
    wi64(0x100 + i * 16, tag);
    w64(0x108 + i * 16, val);
  };
  const entry = (p, e) => {
    w64(p, e.off);
    w64(p + 8, (BigInt(e.sym ?? 0) << 32n) | BigInt(e.type ?? R_X86_64_RELATIVE));
    wi64(p + 16, e.addend ?? 0n);
  };
  (rela || []).forEach((e, i) => entry(0x210 + i * 24, e));
  (jmprel || []).forEach((e, i) => entry(0x210 + i * 24, { ...e, type: e.type ?? R_X86_64_JUMP_SLOT }));
  w32(0x240, 1);
  w32(0x244, 2);
  const sym = (p, name, info, shndx, value) => {
    w32(p, name);
    b[p + 4] = info;
    b[p + 5] = 0;
    w16(p + 6, shndx);
    w64(p + 8, value);
    w64(p + 16, 0n);
  };
  sym(0x260, 0, 0, 0, 0n);
  sym(0x278, 1, 0x11, 0, 0n);
  const dynstr = new TextEncoder().encode('\0ext\0libc.so.6\0');
  b.set(dynstr, 0x290);
  const tags = [
    [4n, BASE + 0x240n],
    [5n, BASE + 0x290n],
    [10n, BigInt(dynstr.length)],
    [6n, BASE + 0x260n],
    [11n, 24n],
  ];
  if (rela) tags.push([7n, BASE + 0x210n], [8n, BigInt(rela.length) * 24n], [9n, 24n]);
  if (jmprel) tags.push([23n, BASE + 0x210n], [2n, BigInt(jmprel.length) * 24n], [20n, 7n]);
  tags.forEach(([tag, val], i) => dyn(i, tag, val));
  dyn(tags.length, 0n, 0n);
  return b;
}

export function makeSectionedElf64({ exec = false, memsz = 0x300n, rela = [] } = {}) {
  const b = new Uint8Array(0x600);
  const v = new DataView(b.buffer);
  const w16 = (o, x) => v.setUint16(o, x, true);
  const w32 = (o, x) => v.setUint32(o, x, true);
  const w64 = (o, x) => v.setBigUint64(o, BigInt(x), true);
  const wi64 = (o, x) => v.setBigInt64(o, BigInt(x), true);
  b.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0);
  w16(16, exec ? 2 : 3);
  w16(18, 62);
  w32(20, 1);
  w64(24, 0n);
  w64(32, 0x40n);
  w64(40, 0x400n);
  w32(48, 0);
  w16(52, 64);
  w16(54, 56);
  w16(56, 1);
  w16(58, 64);
  w16(60, 5);
  w16(62, 4);
  w32(0x40, 1);
  w32(0x44, 6);
  w64(0x48, 0n);
  w64(0x50, BASE);
  w64(0x58, BASE);
  w64(0x60, 0x300n);
  w64(0x68, memsz);
  w64(0x70, 0x1000n);
  const dynstr = new TextEncoder().encode('\0ext\0');
  b.set(dynstr, 0x100);
  const sym = (p, name, info, shndx, value) => {
    w32(p, name);
    b[p + 4] = info;
    b[p + 5] = 0;
    w16(p + 6, shndx);
    w64(p + 8, value);
    w64(p + 16, 0n);
  };
  sym(0x110, 0, 0, 0, 0n);
  sym(0x128, 1, 0x11, 0, 0n);
  rela.forEach((e, i) => {
    const p = 0x140 + i * 24;
    w64(p, e.off);
    w64(p + 8, (BigInt(e.sym ?? 0) << 32n) | BigInt(e.type ?? R_X86_64_RELATIVE));
    wi64(p + 16, e.addend ?? 0n);
  });
  const shstr = new TextEncoder().encode('\0.dynstr\0.dynsym\0.rela.dyn\0.shstrtab\0');
  b.set(shstr, 0x380);
  const no = { dynstr: 1, dynsym: 9, rela: 17, shstr: 27 };
  const sh = (i, name, type, off, size, link, info, entsize) => {
    const p = 0x400 + i * 64;
    w32(p, name);
    w32(p + 4, type);
    w64(p + 16, 0n);
    w64(p + 24, off);
    w64(p + 32, size);
    w32(p + 40, link);
    w32(p + 44, info);
    w64(p + 56, entsize);
  };
  sh(0, 0, 0, 0, 0, 0, 0, 0);
  sh(1, no.dynstr, 3, 0x100, dynstr.length, 0, 0, 0);
  sh(2, no.dynsym, 11, 0x110, 48, 1, 1, 24);
  sh(3, no.rela, 4, 0x140, rela.length * 24, 2, 1, 24);
  sh(4, no.shstr, 3, 0x380, shstr.length, 0, 0, 0);
  return b;
}

function assertNoCanonicalSite(image, address) {
  const published = image.relocations.filter((r) => r.address === address);
  assert.equal(published.length, 0, `unmapped target ${address} must not be published as a canonical relocation`);
  for (const imp of image.imports) {
    const sites = (imp.sites || []).filter((s) => s.address === address);
    assert.equal(sites.length, 0, `unmapped target ${address} must not appear as an import site of ${imp.name}`);
  }
}

function assertNoDynamicPartial(image) {
  assert.equal(image.metadata.programDynamicPartial, undefined);
  assert.equal(image.metadata.programDynamicDiagnostics, undefined);
}

function hasLoadedMemoryWarning(image) {
  return image.warnings.some((w) => /outside every loaded PT_LOAD memory span/.test(w));
}

{
  const image = parseELF(makeSectionlessElf64({
    rela: [{ off: BASE + 0x40n, sym: 0, type: R_X86_64_RELATIVE, addend: 0x1234n }],
  }));
  assert.equal(image.metadata.type, 3);
  const rel = image.relocations.find((r) => r.source === 'PT_DYNAMIC-RELA');
  assert.ok(rel, 'in-domain mapped RELATIVE target must stay canonical');
  assert.equal(rel.address, BASE + 0x40n);
  assert.equal(rel.fileOffset, 0x40n);
  assert.equal(rel.addend, 0x1234n);
  assertNoDynamicPartial(image);
  assert.equal(image.metadata.elfMetadata.complete, true);
}

{
  const image = parseELF(makeSectionlessElf64({
    memsz: 0x600n,
    rela: [{ off: BASE + 0x500n, sym: 0, type: R_X86_64_RELATIVE }],
  }));
  const rel = image.relocations.find((r) => r.source === 'PT_DYNAMIC-RELA');
  assert.ok(rel, 'zero-fill/BSS target inside p_memsz beyond p_filesz must stay canonical');
  assert.equal(rel.address, BASE + 0x500n);
  assert.equal(rel.fileOffset, null);
  assertNoDynamicPartial(image);
}

{
  const image = parseELF(makeSectionlessElf64({
    rela: [{ off: UNMAPPED_NEXT_PAGE, sym: 0, type: R_X86_64_RELATIVE }],
  }));
  assertNoCanonicalSite(image, UNMAPPED_NEXT_PAGE);
  assert.equal(image.segmentAt(UNMAPPED_NEXT_PAGE), null);
  assert.equal(image.metadata.programDynamicPartial, true);
  assert.ok((image.metadata.programDynamicDiagnostics || []).some((d) => /outside every loaded PT_LOAD memory span/.test(d)));
  assert.ok(hasLoadedMemoryWarning(image));
}

{
  const image = parseELF(makeSectionlessElf64({
    rela: [{ off: UNMAPPED_FAR, sym: 0, type: R_X86_64_RELATIVE }],
  }));
  assertNoCanonicalSite(image, UNMAPPED_FAR);
  assert.equal(image.metadata.programDynamicPartial, true);
  assert.ok(hasLoadedMemoryWarning(image));
}

{
  const image = parseELF(makeSectionlessElf64({
    rela: [{ off: BASE + 0x2fcn, sym: 0, type: R_X86_64_RELATIVE }],
  }));
  assertNoCanonicalSite(image, BASE + 0x2fcn);
  assert.equal(image.metadata.programDynamicPartial, true);
  assert.ok(image.warnings.some((w) => /target field crosses the end of its loaded PT_LOAD memory span/.test(w)));
}

{
  const image = parseELF(makeSectionlessElf64({
    rela: [{ off: BASE + 0x2fcn, sym: 0, type: R_X86_64_32 }],
  }));
  const rel = image.relocations.find((r) => r.source === 'PT_DYNAMIC-RELA');
  assert.ok(rel, '4-byte target field that fits loaded memory must stay canonical');
  assert.equal(rel.address, BASE + 0x2fcn);
  assertNoDynamicPartial(image);
}

{
  const image = parseELF(makeSectionlessElf64({
    jmprel: [{ off: BASE + 0x40n, sym: 1, type: R_X86_64_JUMP_SLOT }],
  }));
  const rel = image.relocations.find((r) => r.source === 'PT_DYNAMIC-JMPREL-RELA');
  assert.ok(rel, 'mapped PLT relocation must stay canonical');
  assert.equal(rel.address, BASE + 0x40n);
  const imp = image.imports.find((x) => x.name === 'ext');
  assert.ok(imp);
  assert.equal(imp.sites[0]?.address, BASE + 0x40n);
  assertNoDynamicPartial(image);
}

{
  const image = parseELF(makeSectionlessElf64({
    jmprel: [{ off: UNMAPPED_NEXT_PAGE, sym: 1, type: R_X86_64_JUMP_SLOT }],
  }));
  assertNoCanonicalSite(image, UNMAPPED_NEXT_PAGE);
  const imp = image.imports.find((x) => x.name === 'ext');
  assert.ok(imp, 'undefined symbol import identity must still exist');
  assert.equal((imp.sites || []).length, 0, 'rejected PLT relocation must not create an import site');
  assert.equal(image.metadata.programDynamicPartial, true);
  assert.ok(hasLoadedMemoryWarning(image));
}

{
  const image = parseELF(makeSectionlessElf64({
    exec: true,
    rela: [{ off: UNMAPPED_NEXT_PAGE, sym: 0, type: R_X86_64_RELATIVE }],
  }));
  assert.equal(image.metadata.type, 2);
  assertNoCanonicalSite(image, UNMAPPED_NEXT_PAGE);
  assert.equal(image.metadata.programDynamicPartial, true);
}

{
  const image = parseELF(makeSectionedElf64({
    rela: [{ off: BASE + 0x40n, sym: 0, type: R_X86_64_RELATIVE, addend: 0x1234n }],
  }));
  const rel = image.relocations.find((r) => r.source === 'RELA');
  assert.ok(rel, 'section-backed mapped target must stay canonical');
  assert.equal(rel.address, BASE + 0x40n);
  assert.equal(rel.fileOffset, 0x40n);
  assert.equal(rel.section, '.rela.dyn');
  assert.equal(image.metadata.elfMetadata.complete, true);
}

{
  const image = parseELF(makeSectionedElf64({
    memsz: 0x600n,
    rela: [{ off: BASE + 0x500n, sym: 0, type: R_X86_64_RELATIVE }],
  }));
  const rel = image.relocations.find((r) => r.source === 'RELA');
  assert.ok(rel, 'section-backed BSS target inside p_memsz must stay canonical');
  assert.equal(rel.address, BASE + 0x500n);
  assert.equal(rel.fileOffset, null);
  assert.equal(image.metadata.elfMetadata.complete, true);
}

{
  const image = parseELF(makeSectionedElf64({
    rela: [{ off: UNMAPPED_NEXT_PAGE, sym: 0, type: R_X86_64_RELATIVE }],
  }));
  assertNoCanonicalSite(image, UNMAPPED_NEXT_PAGE);
  assert.equal(image.metadata.elfMetadata.complete, false);
  assert.ok(image.metadata.elfMetadata.reasons.some((r) => /relocations:3:unmapped-target/.test(r)));
  assert.ok(hasLoadedMemoryWarning(image));
}

{
  const image = parseELF(makeSectionedElf64({
    rela: [{ off: UNMAPPED_FAR, sym: 0, type: R_X86_64_RELATIVE }],
  }));
  assertNoCanonicalSite(image, UNMAPPED_FAR);
  assert.equal(image.metadata.elfMetadata.complete, false);
  assert.ok(hasLoadedMemoryWarning(image));
}

{
  const image = parseELF(makeSectionedElf64({
    rela: [{ off: BASE + 0x2fcn, sym: 0, type: R_X86_64_RELATIVE }],
  }));
  assertNoCanonicalSite(image, BASE + 0x2fcn);
  assert.equal(image.metadata.elfMetadata.complete, false);
  assert.ok(image.metadata.elfMetadata.reasons.some((r) => /relocations:3:target-span/.test(r)));
}

{
  const image = parseELF(makeSectionedElf64({
    rela: [{ off: BASE + 0x2fcn, sym: 0, type: R_X86_64_32 }],
  }));
  const rel = image.relocations.find((r) => r.source === 'RELA');
  assert.ok(rel, 'section-backed 4-byte field that fits loaded memory must stay canonical');
  assert.equal(rel.address, BASE + 0x2fcn);
  assert.equal(image.metadata.elfMetadata.complete, true);
}

{
  const image = parseELF(makeSectionedElf64({
    rela: [{ off: UNMAPPED_NEXT_PAGE, sym: 1, type: R_X86_64_JUMP_SLOT }],
  }));
  assertNoCanonicalSite(image, UNMAPPED_NEXT_PAGE);
  const imp = image.imports.find((x) => x.name === 'ext');
  assert.ok(imp);
  assert.equal((imp.sites || []).length, 0, 'rejected section-backed relocation must not create an import site');
  assert.equal(image.metadata.elfMetadata.complete, false);
}

{
  const image = parseELF(makeSectionedElf64({
    exec: true,
    rela: [{ off: UNMAPPED_FAR, sym: 0, type: R_X86_64_RELATIVE }],
  }));
  assert.equal(image.metadata.type, 2);
  assertNoCanonicalSite(image, UNMAPPED_FAR);
  assert.equal(image.metadata.elfMetadata.complete, false);
}

console.log('issue #8096 ELF unmapped relocation target fail-closed regressions: PASS');
