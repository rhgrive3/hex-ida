import assert from 'node:assert/strict';
import test from 'node:test';
import { parseELF } from '../js/binary/elf.js';

const PT_LOAD = 1;
const PF_R = 4;

function elf(bits, { offset = 0x100, vaddr = 0x400100, filesz = 0x20, memsz = 0x20, align = 0x1000 } = {}) {
  const is64 = bits === 64;
  const ehsize = is64 ? 64 : 52;
  const phentsize = is64 ? 56 : 32;
  const phoff = ehsize;
  const fileSize = 0x5000;
  const bytes = new Uint8Array(fileSize);
  const view = new DataView(bytes.buffer);

  bytes.set([0x7f, 0x45, 0x4c, 0x46], 0);
  view.setUint8(4, is64 ? 2 : 1); // ELFCLASS
  view.setUint8(5, 1); // ELFDATA2LSB
  view.setUint8(6, 1); // EV_CURRENT
  view.setUint16(16, 2, true); // ET_EXEC
  view.setUint16(18, is64 ? 62 : 3, true); // EM_X86_64 / EM_386
  view.setUint32(20, 1, true);

  if (is64) {
    view.setBigUint64(24, BigInt(vaddr), true);
    view.setBigUint64(32, BigInt(phoff), true);
    view.setBigUint64(40, 0n, true);
    view.setUint16(52, ehsize, true);
    view.setUint16(54, phentsize, true);
    view.setUint16(56, 1, true);
    view.setUint16(58, 64, true);

    const p = phoff;
    view.setUint32(p + 0, PT_LOAD, true);
    view.setUint32(p + 4, PF_R, true);
    view.setBigUint64(p + 8, BigInt(offset), true);
    view.setBigUint64(p + 16, BigInt(vaddr), true);
    view.setBigUint64(p + 24, BigInt(vaddr), true);
    view.setBigUint64(p + 32, BigInt(filesz), true);
    view.setBigUint64(p + 40, BigInt(memsz), true);
    view.setBigUint64(p + 48, BigInt(align), true);
  } else {
    view.setUint32(24, vaddr >>> 0, true);
    view.setUint32(28, phoff, true);
    view.setUint32(32, 0, true);
    view.setUint16(40, ehsize, true);
    view.setUint16(42, phentsize, true);
    view.setUint16(44, 1, true);
    view.setUint16(46, 40, true);

    const p = phoff;
    view.setUint32(p + 0, PT_LOAD, true);
    view.setUint32(p + 4, offset >>> 0, true);
    view.setUint32(p + 8, vaddr >>> 0, true);
    view.setUint32(p + 12, vaddr >>> 0, true);
    view.setUint32(p + 16, filesz >>> 0, true);
    view.setUint32(p + 20, memsz >>> 0, true);
    view.setUint32(p + 24, PF_R, true);
    view.setUint32(p + 28, align >>> 0, true);
  }

  return bytes;
}

function loads(image) {
  return image.segments.filter((segment) => segment.source === 'PT_LOAD');
}

for (const bits of [32, 64]) {
  test(`#4090 ELF${bits} accepts p_align=0 and p_align=1`, () => {
    for (const align of [0, 1]) {
      const image = parseELF(elf(bits, { align, offset: 0x100, vaddr: 0x400203 }));
      assert.equal(loads(image).length, 1, `p_align=${align} must impose no congruence requirement`);
    }
  });

  test(`#4090 ELF${bits} accepts power-of-two p_align with congruent p_vaddr/p_offset`, () => {
    const image = parseELF(elf(bits, { align: 0x1000, offset: 0x100, vaddr: 0x400100 }));
    assert.equal(loads(image).length, 1);
    assert.equal(image.addressToOffset(0x400100n), 0x100n);
  });

  test(`#4090 ELF${bits} rejects non-power-of-two p_align`, () => {
    const image = parseELF(elf(bits, { align: 3, offset: 0x100, vaddr: 0x400100 }));
    assert.equal(loads(image).length, 0, 'malformed p_align must not become canonical mapping authority');
    assert.ok(image.warnings.some((warning) => /PT_LOAD 0.*p_align.*power of two/.test(warning)), image.warnings.join('\n'));
  });

  test(`#4090 ELF${bits} rejects incongruent p_vaddr/p_offset`, () => {
    const image = parseELF(elf(bits, { align: 0x1000, offset: 0x100, vaddr: 0x400200 }));
    assert.equal(loads(image).length, 0, 'incongruent PT_LOAD must not become canonical mapping authority');
    assert.ok(image.warnings.some((warning) => /PT_LOAD 0.*not congruent/.test(warning)), image.warnings.join('\n'));
  });

  test(`#4090 ELF${bits} keeps existing p_filesz/p_memsz and file-range rejection`, () => {
    const oversized = parseELF(elf(bits, { filesz: 0x30, memsz: 0x20 }));
    assert.equal(loads(oversized).length, 0);
    assert.ok(oversized.warnings.some((warning) => /p_filesz > p_memsz/.test(warning)));

    const outOfFile = parseELF(elf(bits, { offset: 0x4ff0, vaddr: 0x404ff0, filesz: 0x20, memsz: 0x20 }));
    assert.equal(loads(outOfFile).length, 0);
    assert.ok(outOfFile.warnings.some((warning) => /file range exceeds input/.test(warning)));
  });
}
