import assert from 'node:assert/strict';
import test from 'node:test';

import { parseELF } from '../../../js/binary/elf.js';

const SHF_ALLOC = 0x2n;
const SHT_NOBITS = 8;
const LIMIT32 = 1n << 32n;
const LIMIT64 = 1n << 64n;

function buildELF({ bits = 64, load = null, section = null }) {
  const is64 = bits === 64;
  const ehsize = is64 ? 64 : 52;
  const phentsize = is64 ? 56 : 32;
  const shentsize = is64 ? 64 : 40;
  const phoff = load ? ehsize : 0;
  const shoff = section ? 0x100 : 0;
  const shnum = section ? 2 : 0;
  const bytes = new Uint8Array(0x200);
  const view = new DataView(bytes.buffer);

  bytes.set([0x7f, 0x45, 0x4c, 0x46, is64 ? 2 : 1, 1, 1, 0], 0);
  view.setUint16(16, 2, true); // ET_EXEC
  view.setUint16(18, is64 ? 62 : 3, true); // x86_64 / x86
  view.setUint32(20, 1, true);
  if (is64) {
    view.setBigUint64(24, 0n, true);
    view.setBigUint64(32, BigInt(phoff), true);
    view.setBigUint64(40, BigInt(shoff), true);
    view.setUint32(48, 0, true);
    view.setUint16(52, ehsize, true);
    view.setUint16(54, phentsize, true);
    view.setUint16(56, load ? 1 : 0, true);
    view.setUint16(58, shentsize, true);
    view.setUint16(60, shnum, true);
    view.setUint16(62, 0, true);
  } else {
    view.setUint32(24, 0, true);
    view.setUint32(28, phoff, true);
    view.setUint32(32, shoff, true);
    view.setUint32(36, 0, true);
    view.setUint16(40, ehsize, true);
    view.setUint16(42, phentsize, true);
    view.setUint16(44, load ? 1 : 0, true);
    view.setUint16(46, shentsize, true);
    view.setUint16(48, shnum, true);
    view.setUint16(50, 0, true);
  }

  if (load) {
    const p = phoff;
    if (is64) {
      view.setUint32(p, 1, true); // PT_LOAD
      view.setUint32(p + 4, load.flags ?? 4, true);
      view.setBigUint64(p + 8, BigInt(load.offset ?? 0n), true);
      view.setBigUint64(p + 16, BigInt(load.vaddr), true);
      view.setBigUint64(p + 24, BigInt(load.vaddr), true);
      view.setBigUint64(p + 32, BigInt(load.filesz ?? 0n), true);
      view.setBigUint64(p + 40, BigInt(load.memsz), true);
      view.setBigUint64(p + 48, BigInt(load.align ?? 1n), true);
    } else {
      view.setUint32(p, 1, true);
      view.setUint32(p + 4, Number(load.offset ?? 0n), true);
      view.setUint32(p + 8, Number(load.vaddr), true);
      view.setUint32(p + 12, Number(load.vaddr), true);
      view.setUint32(p + 16, Number(load.filesz ?? 0n), true);
      view.setUint32(p + 20, Number(load.memsz), true);
      view.setUint32(p + 24, load.flags ?? 4, true);
      view.setUint32(p + 28, Number(load.align ?? 1n), true);
    }
  }

  if (section) {
    const p = shoff + shentsize; // section zero stays all-zero
    if (is64) {
      view.setUint32(p, 0, true);
      view.setUint32(p + 4, section.type ?? SHT_NOBITS, true);
      view.setBigUint64(p + 8, BigInt(section.flags ?? SHF_ALLOC), true);
      view.setBigUint64(p + 16, BigInt(section.addr), true);
      view.setBigUint64(p + 24, BigInt(section.offset ?? 0n), true);
      view.setBigUint64(p + 32, BigInt(section.size), true);
      view.setBigUint64(p + 48, 1n, true);
    } else {
      view.setUint32(p, 0, true);
      view.setUint32(p + 4, section.type ?? SHT_NOBITS, true);
      view.setUint32(p + 8, Number(section.flags ?? SHF_ALLOC), true);
      view.setUint32(p + 12, Number(section.addr), true);
      view.setUint32(p + 16, Number(section.offset ?? 0n), true);
      view.setUint32(p + 20, Number(section.size), true);
      view.setUint32(p + 32, 1, true);
    }
  }

  return bytes;
}

function warnings(image) {
  return image.warnings.join('\n');
}

test('#4244 ELF64 PT_LOAD ending exactly at 2^64 remains accepted', () => {
  const image = parseELF(buildELF({
    load: { vaddr: LIMIT64 - 0x1000n, memsz: 0x1000n },
  }));
  assert.equal(image.segments.length, 1);
  assert.equal(image.segmentAt(LIMIT64 - 1n)?.name, 'LOAD0');
  assert.equal(image.segmentAt(LIMIT64), null);
});

test('#4244 ELF64 overflowing zero-fill PT_LOAD is rejected before mapping publication', () => {
  const image = parseELF(buildELF({
    load: { vaddr: LIMIT64 - 0x800n, memsz: 0x1000n, filesz: 0n },
  }));
  assert.equal(image.segments.length, 0);
  assert.equal(image.segmentAt(LIMIT64 + 0x10n), null);
  assert.match(warnings(image), /PT_LOAD 0.*virtual range exceeds ELF64 address space/);
});

test('#4244 ELF32 PT_LOAD overflowing 2^32 is rejected', () => {
  const image = parseELF(buildELF({
    bits: 32,
    load: { vaddr: LIMIT32 - 0x800n, memsz: 0x1000n, filesz: 0n },
  }));
  assert.equal(image.segments.length, 0);
  assert.equal(image.segmentAt(LIMIT32 + 0x10n), null);
  assert.match(warnings(image), /PT_LOAD 0.*virtual range exceeds ELF32 address space/);
});

test('#4244 ELF64 SHF_ALLOC section ending exactly at 2^64 remains canonical', () => {
  const image = parseELF(buildELF({
    section: { addr: LIMIT64 - 0x1000n, size: 0x1000n },
  }));
  assert.equal(image.sections.some((section) => section.index === 1), true);
  assert.equal(image.sectionAt(LIMIT64 - 1n)?.index, 1);
  assert.equal(image.sectionAt(LIMIT64), null);
});

test('#4244 ELF64 overflowing SHF_ALLOC section is excluded from canonical sections', () => {
  const image = parseELF(buildELF({
    section: { addr: LIMIT64 - 0x800n, size: 0x1000n },
  }));
  assert.equal(image.sections.some((section) => section.index === 1), false);
  assert.equal(image.sectionAt(LIMIT64 + 0x10n), null);
  assert.match(warnings(image), /ELF section 1.*virtual range exceeds ELF64 address space/);
});

test('#4244 ELF32 overflowing SHF_ALLOC section is excluded from canonical sections', () => {
  const image = parseELF(buildELF({
    bits: 32,
    section: { addr: LIMIT32 - 0x800n, size: 0x1000n },
  }));
  assert.equal(image.sections.some((item) => item.index === 1), false);
  assert.equal(image.sectionAt(LIMIT32 + 0x10n), null);
  assert.match(warnings(image), /ELF section 1.*virtual range exceeds ELF32 address space/);
});

test('#4244 non-ALLOC sections and ET_REL synthetic layout are outside the runtime-address guard', () => {
  const nonAlloc = parseELF(buildELF({
    section: { addr: LIMIT64 - 0x800n, size: 0x1000n, flags: 0n },
  }));
  assert.equal(nonAlloc.sections.some((section) => section.index === 1), true);
  assert.doesNotMatch(warnings(nonAlloc), /virtual range exceeds ELF64 address space/);

  const relocatable = buildELF({
    section: { addr: LIMIT64 - 0x800n, size: 0x1000n },
  });
  new DataView(relocatable.buffer).setUint16(16, 1, true); // ET_REL
  const rel = parseELF(relocatable);
  assert.equal(rel.sections.some((section) => section.index === 1), true);
  assert.doesNotMatch(warnings(rel), /virtual range exceeds ELF64 address space/);
});

test('#4244 adversarial PT_LOAD boundary matrix preserves the half-open address domain', () => {
  for (const bits of [32, 64]) {
    const limit = 1n << BigInt(bits);
    const max = limit - 1n;
    const cases = [
      { name: 'empty-at-zero', vaddr: 0n, memsz: 0n, valid: true },
      { name: 'empty-at-max', vaddr: max, memsz: 0n, valid: true },
      { name: 'one-byte-at-max', vaddr: max, memsz: 1n, valid: true },
      { name: 'page-to-exact-end', vaddr: limit - 0x1000n, memsz: 0x1000n, valid: true },
      { name: 'max-plus-two', vaddr: max, memsz: 2n, valid: false },
      { name: 'three-over-last-two', vaddr: limit - 2n, memsz: 3n, valid: false },
      { name: 'page-over-midpoint', vaddr: limit - 0x800n, memsz: 0x1000n, valid: false },
    ];
    for (const item of cases) {
      const image = parseELF(buildELF({ bits, load: { vaddr: item.vaddr, memsz: item.memsz } }));
      assert.equal(image.segments.length === 1, item.valid, `ELF${bits} ${item.name}`);
      assert.equal(warnings(image).includes(`virtual range exceeds ELF${bits} address space`), !item.valid, `ELF${bits} ${item.name} diagnostic`);
    }
  }
});

test('#4244 adversarial SHF_ALLOC boundary matrix rejects only overflowing runtime sections', () => {
  for (const bits of [32, 64]) {
    const limit = 1n << BigInt(bits);
    const max = limit - 1n;
    const cases = [
      { name: 'empty-at-max', addr: max, size: 0n, valid: true },
      { name: 'one-byte-at-max', addr: max, size: 1n, valid: true },
      { name: 'exact-page-end', addr: limit - 0x1000n, size: 0x1000n, valid: true },
      { name: 'two-bytes-at-max', addr: max, size: 2n, valid: false },
      { name: 'cross-end-by-one', addr: limit - 2n, size: 3n, valid: false },
    ];
    for (const item of cases) {
      const image = parseELF(buildELF({ bits, section: { addr: item.addr, size: item.size } }));
      assert.equal(image.sections.some((section) => section.index === 1), item.valid, `ELF${bits} ${item.name}`);
      assert.equal(warnings(image).includes(`virtual range exceeds ELF${bits} address space`), !item.valid, `ELF${bits} ${item.name} diagnostic`);
    }
  }
});
