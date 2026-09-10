/**
 * #4090 — PT_LOAD p_align loader invariants.
 *
 * ELF permits p_align 0/1 as "no alignment". Any larger value must be a
 * power of two, and loadable p_vaddr/p_offset must be congruent modulo that
 * alignment. A malformed PT_LOAD must not become canonical mapping authority.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { parseELF } from '../../../js/binary/elf.js';
import { openBinarySource } from '../../../js/binary/source-loaders.js';

function buildELF({
  bits = 64,
  littleEndian = true,
  align = 0x1000n,
  offset = 0x100n,
  vaddr = 0x400100n,
  filesz = 0x10n,
  memsz = 0x10n,
} = {}) {
  const is64 = bits === 64;
  const ehsize = is64 ? 64 : 52;
  const phentsize = is64 ? 56 : 32;
  const bytes = new Uint8Array(0x400);
  const view = new DataView(bytes.buffer);
  const u16 = (o, v) => view.setUint16(o, v, littleEndian);
  const u32 = (o, v) => view.setUint32(o, Number(v), littleEndian);
  const u64 = (o, v) => view.setBigUint64(o, BigInt(v), littleEndian);

  bytes.set([0x7f, 0x45, 0x4c, 0x46, is64 ? 2 : 1, littleEndian ? 1 : 2, 1, 0], 0);
  u16(16, 2); // ET_EXEC
  u16(18, is64 ? 62 : 3); // EM_X86_64 / EM_386
  u32(20, 1); // EV_CURRENT
  if (is64) {
    u64(32, BigInt(ehsize));
    u64(40, 0n);
    u16(52, ehsize);
    u16(54, phentsize);
    u16(56, 1);
    u16(58, 0);
    u16(60, 0);
    u16(62, 0);
  } else {
    u32(28, ehsize);
    u32(32, 0);
    u16(40, ehsize);
    u16(42, phentsize);
    u16(44, 1);
    u16(46, 0);
    u16(48, 0);
    u16(50, 0);
  }

  const p = ehsize;
  u32(p, 1); // PT_LOAD
  if (is64) {
    u32(p + 4, 4); // PF_R
    u64(p + 8, offset);
    u64(p + 16, vaddr);
    u64(p + 24, vaddr);
    u64(p + 32, filesz);
    u64(p + 40, memsz);
    u64(p + 48, align);
  } else {
    u32(p + 4, offset);
    u32(p + 8, vaddr);
    u32(p + 12, vaddr);
    u32(p + 16, filesz);
    u32(p + 20, memsz);
    u32(p + 24, 4); // PF_R
    u32(p + 28, align);
  }
  return bytes;
}

function parse(options) {
  const image = parseELF(buildELF(options));
  return {
    segments: image.segments,
    warnings: image.warnings,
  };
}

for (const bits of [32, 64]) {
  for (const littleEndian of [true, false]) {
    const label = `${bits}-bit ${littleEndian ? 'LE' : 'BE'}`;

    test(`#4090: ${label} accepts p_align=0`, () => {
      const result = parse({ bits, littleEndian, align: 0n });
      assert.equal(result.segments.length, 1);
    });

    test(`#4090: ${label} accepts p_align=1`, () => {
      const result = parse({ bits, littleEndian, align: 1n });
      assert.equal(result.segments.length, 1);
    });

    test(`#4090: ${label} accepts power-of-two congruent PT_LOAD`, () => {
      const result = parse({ bits, littleEndian, align: 0x1000n, offset: 0x100n, vaddr: 0x400100n });
      assert.equal(result.segments.length, 1);
    });

    test(`#4090: ${label} rejects non-power-of-two p_align`, () => {
      const result = parse({ bits, littleEndian, align: 3n });
      assert.equal(result.segments.length, 0);
      assert.ok(result.warnings.some((warning) => warning.includes('p_align 3 is not 0, 1, or a power of two')));
    });

    test(`#4090: ${label} rejects incongruent p_vaddr/p_offset`, () => {
      const result = parse({ bits, littleEndian, align: 0x1000n, offset: 0x100n, vaddr: 0x400200n });
      assert.equal(result.segments.length, 0);
      assert.ok(result.warnings.some((warning) => warning.includes('p_vaddr and p_offset are not congruent modulo p_align 4096')));
    });
  }
}

test('#4090: existing p_filesz > p_memsz rejection remains fail-closed', () => {
  const result = parse({ filesz: 0x20n, memsz: 0x10n });
  assert.equal(result.segments.length, 0);
  assert.ok(result.warnings.some((warning) => warning.includes('p_filesz > p_memsz')));
});

test('#4090: existing out-of-file PT_LOAD rejection remains fail-closed', () => {
  const result = parse({ offset: 0x3f8n, vaddr: 0x4003f8n, filesz: 0x10n, memsz: 0x10n, align: 8n });
  assert.equal(result.segments.length, 0);
  assert.ok(result.warnings.some((warning) => warning.includes('file range exceeds input')));
});

test('#4090: source-backed ELF loader preserves the same PT_LOAD alignment gate', async () => {
  const invalid = await openBinarySource(buildELF({ align: 0x1000n, offset: 0x100n, vaddr: 0x400200n }));
  assert.equal(invalid.segments.length, 0);
  assert.ok(invalid.warnings.some((warning) => warning.includes('not congruent modulo p_align 4096')));

  const valid = await openBinarySource(buildELF({ bits: 32, littleEndian: false, align: 0x1000n }));
  assert.equal(valid.segments.length, 1);
});
