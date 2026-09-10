/**
 * #3968 — SHT_DYNAMIC.sh_link is referential-integrity metadata, not an
 * optional hint.  A missing/non-STRTAB link must make ELF metadata partial,
 * while the dynamic entries remain available for non-string evidence and an
 * independent PT_DYNAMIC path may still recover string metadata.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { parseELF } from '../../../js/binary/elf.js';

const SHT_NULL = 0;
const SHT_PROGBITS = 1;
const SHT_STRTAB = 3;
const SHT_DYNAMIC = 6;
const PT_LOAD = 1;
const PT_DYNAMIC = 2;
const DT_NULL = 0n;
const DT_NEEDED = 1n;
const DT_STRTAB = 5n;
const DT_STRSZ = 10n;
const DT_RISCV_VARIANT_CC = 0x70000001n;
const BASE = 0x400000n;
const REASON = 'dynamic-section:2:string-table-link';

function writeElfHeader(view, { phoff = 0, phnum = 0, shoff, shnum = 3, machine = 62 }) {
  const bytes = new Uint8Array(view.buffer);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0); // ELF64 LE
  view.setUint16(16, 3, true); // ET_DYN
  view.setUint16(18, machine, true);
  view.setUint32(20, 1, true);
  view.setBigUint64(32, BigInt(phoff), true);
  view.setBigUint64(40, BigInt(shoff), true);
  view.setUint16(52, 64, true);
  view.setUint16(54, 56, true);
  view.setUint16(56, phnum, true);
  view.setUint16(58, 64, true);
  view.setUint16(60, shnum, true);
  view.setUint16(62, 0, true); // no section-name table
}

function writeSection64(view, shoff, index, { type = SHT_NULL, offset = 0, size = 0, link = 0, entsize = 0 } = {}) {
  const p = shoff + index * 64;
  view.setUint32(p + 4, type, true);
  view.setBigUint64(p + 24, BigInt(offset), true);
  view.setBigUint64(p + 32, BigInt(size), true);
  view.setUint32(p + 40, link, true);
  view.setBigUint64(p + 56, BigInt(entsize), true);
}

function writeDynamic64(view, offset, entries) {
  entries.forEach(([tag, value], i) => {
    const p = offset + i * 16;
    view.setBigInt64(p, BigInt(tag), true);
    view.setBigUint64(p + 8, BigInt(value), true);
  });
  return entries.length * 16;
}

function buildSectionOnly({ link = 1, linkedType = SHT_STRTAB, machine = 62, entries = null } = {}) {
  const dynamicOff = 0x80;
  const strOff = 0xc0;
  const shoff = 0x100;
  const bytes = new Uint8Array(shoff + 3 * 64);
  const view = new DataView(bytes.buffer);
  writeElfHeader(view, { shoff, machine });
  const str = new TextEncoder().encode('\0libx.so\0');
  bytes.set(str, strOff);
  const dynamicSize = writeDynamic64(view, dynamicOff, entries ?? [
    [DT_NEEDED, 1n],
    [DT_NULL, 0n],
  ]);
  writeSection64(view, shoff, 0);
  writeSection64(view, shoff, 1, { type: linkedType, offset: strOff, size: str.length });
  writeSection64(view, shoff, 2, { type: SHT_DYNAMIC, offset: dynamicOff, size: dynamicSize, link, entsize: 16 });
  return bytes;
}

function buildWithProgramDynamicFallback({ link = 99 } = {}) {
  const phoff = 0x40;
  const strOff = 0x100;
  const programDynamicOff = 0x140;
  const sectionDynamicOff = 0x1c0;
  const shoff = 0x240;
  const total = shoff + 3 * 64;
  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  writeElfHeader(view, { phoff, phnum: 2, shoff });

  const str = new TextEncoder().encode('\0fallback.so\0');
  bytes.set(str, strOff);
  const programDynamicSize = writeDynamic64(view, programDynamicOff, [
    [DT_NEEDED, 1n],
    [DT_STRTAB, BASE + BigInt(strOff)],
    [DT_STRSZ, BigInt(str.length)],
    [DT_NULL, 0n],
  ]);
  const sectionDynamicSize = writeDynamic64(view, sectionDynamicOff, [
    [DT_NEEDED, 1n],
    [DT_NULL, 0n],
  ]);

  const writePhdr = (index, type, offset, vaddr, filesz, memsz = filesz) => {
    const p = phoff + index * 56;
    view.setUint32(p, type, true);
    view.setUint32(p + 4, 4, true); // PF_R
    view.setBigUint64(p + 8, BigInt(offset), true);
    view.setBigUint64(p + 16, BigInt(vaddr), true);
    view.setBigUint64(p + 24, BigInt(vaddr), true);
    view.setBigUint64(p + 32, BigInt(filesz), true);
    view.setBigUint64(p + 40, BigInt(memsz), true);
    view.setBigUint64(p + 48, 0x1000n, true);
  };
  writePhdr(0, PT_LOAD, 0, BASE, total, total);
  writePhdr(1, PT_DYNAMIC, programDynamicOff, BASE + BigInt(programDynamicOff), programDynamicSize);

  writeSection64(view, shoff, 0);
  writeSection64(view, shoff, 1, { type: SHT_PROGBITS, offset: strOff, size: str.length });
  writeSection64(view, shoff, 2, { type: SHT_DYNAMIC, offset: sectionDynamicOff, size: sectionDynamicSize, link, entsize: 16 });
  return bytes;
}

function assertLinkPartial(image) {
  assert.equal(image.metadata.elfMetadata.complete, false);
  assert.ok(image.metadata.elfMetadata.reasons.includes(REASON), JSON.stringify(image.metadata.elfMetadata));
}

test('#3968: valid SHT_DYNAMIC -> SHT_STRTAB keeps existing dependency decode', () => {
  const image = parseELF(buildSectionOnly());
  assert.deepEqual(image.libraries, ['libx.so']);
  assert.equal(image.metadata.elfMetadata.complete, true);
  assert.ok(!image.metadata.elfMetadata.reasons.includes(REASON));
});

test('#3968: out-of-range SHT_DYNAMIC.sh_link is explicit partial', () => {
  const image = parseELF(buildSectionOnly({ link: 99 }));
  assert.deepEqual(image.libraries, []);
  assertLinkPartial(image);
});

test('#3968: SHT_DYNAMIC.sh_link to a non-STRTAB section is explicit partial', () => {
  const image = parseELF(buildSectionOnly({ link: 1, linkedType: SHT_PROGBITS }));
  assert.deepEqual(image.libraries, []);
  assertLinkPartial(image);
});

test('#3968: a valid DT_NULL cannot launder an invalid string-table link', () => {
  const image = parseELF(buildSectionOnly({ link: 0 }));
  assertLinkPartial(image);
});


test('#3968: malformed sh_link does not suppress non-string processor-specific dynamic tags', () => {
  const image = parseELF(buildSectionOnly({
    link: 99,
    machine: 243, // EM_RISCV
    entries: [[DT_RISCV_VARIANT_CC, 0n], [DT_NULL, 0n]],
  }));
  assert.equal(image.metadata.riscvVariantCcTagPresent, true);
  assertLinkPartial(image);
});

test('#3968: valid PT_DYNAMIC fallback may recover the dependency without erasing section corruption', () => {
  const image = parseELF(buildWithProgramDynamicFallback());
  assert.ok(image.libraries.includes('fallback.so'), JSON.stringify(image.libraries));
  assertLinkPartial(image);
  assert.equal(image.metadata.programDynamicPartial ?? false, false);
});
