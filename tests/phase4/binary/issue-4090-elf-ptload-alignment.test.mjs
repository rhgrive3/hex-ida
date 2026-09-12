import test from 'node:test';
import assert from 'node:assert/strict';
import { parseELF } from '../../../js/binary/elf-core.js';
import { parseELFSource } from '../../../js/binary/source-loaders.js';

function elfWithLoad({ bits = 64, offset = 0x100n, vaddr = 0x400100n, filesz = 0x10n, memsz = filesz, align = 1n } = {}) {
  const bytes = new Uint8Array(0x400);
  const view = new DataView(bytes.buffer);
  bytes.set([0x7f, 0x45, 0x4c, 0x46], 0);
  view.setUint8(4, bits === 64 ? 2 : 1); // ELFCLASS64 / ELFCLASS32
  view.setUint8(5, 1); // ELFDATA2LSB
  view.setUint8(6, 1); // EV_CURRENT
  view.setUint16(16, 2, true); // ET_EXEC
  view.setUint16(18, bits === 64 ? 62 : 3, true); // x86-64 / i386
  view.setUint32(20, 1, true); // EV_CURRENT

  const phoff = bits === 64 ? 64 : 52;
  const phentsize = bits === 64 ? 56 : 32;
  if (bits === 64) {
    view.setBigUint64(32, BigInt(phoff), true);
    view.setUint16(52, 64, true);
    view.setUint16(54, phentsize, true);
    view.setUint16(56, 1, true);
    view.setUint16(58, 64, true);

    view.setUint32(phoff, 1, true); // PT_LOAD
    view.setUint32(phoff + 4, 4, true); // PF_R
    view.setBigUint64(phoff + 8, offset, true);
    view.setBigUint64(phoff + 16, vaddr, true);
    view.setBigUint64(phoff + 24, vaddr, true);
    view.setBigUint64(phoff + 32, filesz, true);
    view.setBigUint64(phoff + 40, memsz, true);
    view.setBigUint64(phoff + 48, align, true);
  } else {
    view.setUint32(28, phoff, true);
    view.setUint16(40, 52, true);
    view.setUint16(42, phentsize, true);
    view.setUint16(44, 1, true);
    view.setUint16(46, 40, true);

    view.setUint32(phoff, 1, true); // PT_LOAD
    view.setUint32(phoff + 4, Number(offset), true);
    view.setUint32(phoff + 8, Number(vaddr), true);
    view.setUint32(phoff + 12, Number(vaddr), true);
    view.setUint32(phoff + 16, Number(filesz), true);
    view.setUint32(phoff + 20, Number(memsz), true);
    view.setUint32(phoff + 24, 4, true); // PF_R
    view.setUint32(phoff + 28, Number(align), true);
  }
  return bytes;
}

function loadSegments(options) {
  return parseELF(elfWithLoad(options)).segments.filter((segment) => segment.source === 'PT_LOAD');
}

for (const bits of [32, 64]) {
  test(`#4090 ELF${bits} accepts p_align=0 and p_align=1`, () => {
    assert.equal(loadSegments({ bits, align: 0n }).length, 1);
    assert.equal(loadSegments({ bits, align: 1n }).length, 1);
  });

  test(`#4090 ELF${bits} accepts power-of-two p_align when p_vaddr/p_offset are congruent`, () => {
    assert.equal(loadSegments({ bits, offset: 0x100n, vaddr: 0x400100n, align: 0x1000n }).length, 1);
  });

  test(`#4090 ELF${bits} rejects non-power-of-two p_align`, () => {
    const image = parseELF(elfWithLoad({ bits, align: 3n }));
    assert.equal(image.segments.some((segment) => segment.source === 'PT_LOAD'), false);
    assert.ok(image.warnings.some((warning) => /p_align/.test(warning)));
  });

  test(`#4090 ELF${bits} rejects p_vaddr/p_offset incongruence for aligned PT_LOAD`, () => {
    const image = parseELF(elfWithLoad({ bits, offset: 0x100n, vaddr: 0x400200n, align: 0x1000n }));
    assert.equal(image.segments.some((segment) => segment.source === 'PT_LOAD'), false);
    assert.ok(image.warnings.some((warning) => /p_align|congruent/.test(warning)));
  });
}

test('#4090 source-backed ELF parsing applies the same PT_LOAD alignment contract', async () => {
  for (const bits of [32, 64]) {
    const image = await parseELFSource(elfWithLoad({ bits, offset: 0x100n, vaddr: 0x400200n, align: 0x1000n }));
    assert.equal(image.segments.some((segment) => segment.source === 'PT_LOAD'), false);
    assert.ok(image.warnings.some((warning) => /not congruent modulo p_align/.test(warning)));
  }
});

test('#4090 existing p_filesz > p_memsz and out-of-file guards remain fail-closed', () => {
  const oversized = parseELF(elfWithLoad({ filesz: 0x20n, memsz: 0x10n }));
  assert.equal(oversized.segments.some((segment) => segment.source === 'PT_LOAD'), false);
  assert.ok(oversized.warnings.some((warning) => /p_filesz > p_memsz/.test(warning)));

  const outOfFile = parseELF(elfWithLoad({ offset: 0x3f8n, vaddr: 0x4003f8n, filesz: 0x10n, align: 1n }));
  assert.equal(outOfFile.segments.some((segment) => segment.source === 'PT_LOAD'), false);
  assert.ok(outOfFile.warnings.some((warning) => /file range exceeds input/.test(warning)));
});
