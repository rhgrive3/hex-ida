import assert from 'node:assert/strict';
import test from 'node:test';
import { parseELF } from '../../../js/binary/elf.js';

const SHT_NULL = 0;
const SHT_STRTAB = 3;
const SHT_DYNAMIC = 6;
const DT_NULL = 0n;
const DT_NEEDED = 1n;

function writeElfHeader(view, { shoff, shnum = 3, machine = 62 }) {
  const bytes = new Uint8Array(view.buffer);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0); // ELF64 LE
  view.setUint16(16, 3, true); // ET_DYN
  view.setUint16(18, machine, true);
  view.setUint32(20, 1, true);
  view.setBigUint64(32, 0n, true);
  view.setBigUint64(40, BigInt(shoff), true);
  view.setUint16(52, 64, true);
  view.setUint16(54, 56, true);
  view.setUint16(56, 0, true);
  view.setUint16(58, 64, true);
  view.setUint16(60, shnum, true);
  view.setUint16(62, 0, true);
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

test('issue #3952: SHT_DYNAMIC with DT_NULL terminator is complete', () => {
  const bytes = new Uint8Array(0x400);
  const view = new DataView(bytes.buffer);
  const shoff = 0x200;
  writeElfHeader(view, { shoff, shnum: 3 });

  // Section 1: STRTAB
  const strtabOff = 0x80;
  const str = new TextEncoder().encode('\0libtest.so\0');
  bytes.set(str, strtabOff);
  writeSection64(view, shoff, 1, { type: SHT_STRTAB, offset: strtabOff, size: str.length });

  // Section 2: SHT_DYNAMIC with DT_NEEDED and DT_NULL
  const dynOff = 0x100;
  const dynSize = writeDynamic64(view, dynOff, [
    [DT_NEEDED, 1n],
    [DT_NULL, 0n],
  ]);
  writeSection64(view, shoff, 2, { type: SHT_DYNAMIC, offset: dynOff, size: dynSize, link: 1, entsize: 16 });

  const image = parseELF(bytes);
  assert.equal(image.libraries.length, 1);
  assert.equal(image.libraries[0], 'libtest.so');
  assert.equal(image.metadata.elfMetadata.complete, true);
  assert.equal(image.metadata.elfMetadata.reasons.some((r) => r.includes('unterminated')), false);
});

test('issue #3952: SHT_DYNAMIC without DT_NULL terminator triggers unterminated partial reason', () => {
  const bytes = new Uint8Array(0x400);
  const view = new DataView(bytes.buffer);
  const shoff = 0x200;
  writeElfHeader(view, { shoff, shnum: 3 });

  // Section 1: STRTAB
  const strtabOff = 0x80;
  const str = new TextEncoder().encode('\0libtest.so\0');
  bytes.set(str, strtabOff);
  writeSection64(view, shoff, 1, { type: SHT_STRTAB, offset: strtabOff, size: str.length });

  // Section 2: SHT_DYNAMIC with DT_NEEDED ONLY (no DT_NULL!)
  const dynOff = 0x100;
  const dynSize = writeDynamic64(view, dynOff, [
    [DT_NEEDED, 1n],
  ]);
  writeSection64(view, shoff, 2, { type: SHT_DYNAMIC, offset: dynOff, size: dynSize, link: 1, entsize: 16 });

  const image = parseELF(bytes);
  assert.equal(image.libraries.length, 1, 'libraries decoded best-effort');
  assert.equal(image.libraries[0], 'libtest.so');
  assert.equal(image.metadata.elfMetadata.complete, false);
  assert.ok(image.metadata.elfMetadata.reasons.includes('dynamic-section:2:unterminated'));
});
