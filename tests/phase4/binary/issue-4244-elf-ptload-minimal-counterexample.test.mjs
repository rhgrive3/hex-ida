/**
 * #4244 — ELF PT_LOAD `p_vaddr + p_memsz` must stay inside the ELF class
 * address domain.  The issue's minimal counterexample: an otherwise-valid
 * ELF64 with one zero-fill PT_LOAD at 0xfffffffffffff800 with p_memsz 0x1000
 * (exclusive end 0x1_0000_0000_0000_0800 > 2^64).  The mapping must be
 * rejected with a diagnostic and must never become canonical segment truth;
 * the exact-2^64 boundary stays valid.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { parseELF } from '../../../js/binary/elf.js';

const LIMIT64 = 1n << 64n;
const LIMIT32 = 1n << 32n;

function elf64WithLoad(vaddr, memsz) {
  const bytes = new Uint8Array(0x100);
  const view = new DataView(bytes.buffer);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0);
  view.setUint16(16, 2, true); // ET_EXEC
  view.setUint16(18, 62, true);
  view.setUint32(20, 1, true);
  view.setBigUint64(32, 64n, true); // e_phoff
  view.setUint16(52, 64, true);
  view.setUint16(54, 56, true);
  view.setUint16(56, 1, true);
  view.setUint16(58, 64, true);
  view.setUint16(60, 0, true);
  view.setUint16(62, 0, true);
  const p = 64;
  view.setUint32(p, 1, true); // PT_LOAD
  view.setUint32(p + 4, 4, true); // PF_R
  view.setBigUint64(p + 8, 0n, true); // p_offset
  view.setBigUint64(p + 16, vaddr, true);
  view.setBigUint64(p + 24, vaddr, true); // p_paddr
  view.setBigUint64(p + 32, 0n, true); // p_filesz (zero-fill)
  view.setBigUint64(p + 40, memsz, true);
  view.setBigUint64(p + 48, 1n, true);
  return bytes;
}

test('#4244 minimal counterexample: overflowing zero-fill PT_LOAD is rejected with a diagnostic', () => {
  const image = parseELF(elf64WithLoad(0xfffffffffffff800n, 0x1000n));
  assert.equal(image.segments.length, 0);
  assert.ok(image.warnings.some((w) => w.includes('virtual range exceeds ELF64 address space')), JSON.stringify(image.warnings));
  assert.equal(image.segmentAt(0xfffffffffffff800n), null);
  assert.equal(image.segmentAt(LIMIT64 + 0x10n), null, 'no mapping outside the 64-bit address domain');
});

test('#4244 exact-2^64 half-open boundary stays accepted', () => {
  const image = parseELF(elf64WithLoad(0xfffffffffffff000n, 0x1000n));
  assert.equal(image.segments.length, 1);
  assert.equal(image.segmentAt(LIMIT64 - 1n)?.name, 'LOAD0');
  assert.equal(image.segmentAt(LIMIT64), null);
});

test('#4244 ELF32 overflowing mapping is rejected at 2^32', () => {
  const bytes = new Uint8Array(0x100);
  const view = new DataView(bytes.buffer);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1, 0], 0);
  view.setUint16(16, 2, true);
  view.setUint16(18, 3, true);
  view.setUint32(20, 1, true);
  view.setUint32(28, 52, true); // e_phoff
  view.setUint16(40, 52, true);
  view.setUint16(42, 32, true);
  view.setUint16(44, 1, true);
  view.setUint16(46, 40, true);
  view.setUint16(48, 0, true);
  const p = 52;
  view.setUint32(p, 1, true); // p_type
  view.setUint32(p + 4, 0, true); // p_offset
  view.setUint32(p + 8, 0xfffffff0, true); // p_vaddr
  view.setUint32(p + 12, 0xfffffff0, true); // p_paddr
  view.setUint32(p + 16, 0, true); // p_filesz
  view.setUint32(p + 20, 0x20, true); // p_memsz crosses 2^32
  view.setUint32(p + 24, 4, true); // p_flags
  view.setUint32(p + 28, 1, true); // p_align
  const image = parseELF(bytes);
  assert.equal(image.segments.length, 0);
  assert.ok(image.warnings.some((w) => w.includes('virtual range exceeds ELF32 address space')), JSON.stringify(image.warnings));
  assert.equal(image.segmentAt(LIMIT32 + 0x10n), null);
});
