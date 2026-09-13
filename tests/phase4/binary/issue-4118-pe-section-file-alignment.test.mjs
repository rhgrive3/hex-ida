// #4118: parsePE() must reject Optional Header alignment contracts that
// violate SectionAlignment >= FileAlignment (and page-size equality) before
// promoting any canonical section/entrypoint/function evidence.
import assert from 'node:assert/strict';
import test from 'node:test';

import { parsePE } from '../../../js/binary/pe.js';

function buildPE({
  sectionAlignment = 0x1000,
  fileAlignment = 0x200,
  sizeOfImage = 0x2000,
  entryRva = 0,
} = {}) {
  const bytes = new Uint8Array(0x400);
  const view = new DataView(bytes.buffer);
  const u16 = (o, x) => view.setUint16(o, x, true);
  const u32 = (o, x) => view.setUint32(o, x >>> 0, true);
  const u64 = (o, x) => view.setBigUint64(o, BigInt(x), true);

  u16(0, 0x5a4d);
  u32(0x3c, 0x80);
  u32(0x80, 0x00004550);
  const coff = 0x84;
  u16(coff + 0, 0x8664);
  u16(coff + 2, 1);
  u16(coff + 16, 112);
  u16(coff + 18, 0x0022);

  const opt = coff + 20;
  u16(opt + 0, 0x20b);
  u32(opt + 16, entryRva);
  u64(opt + 24, 0x140000000n);
  u32(opt + 32, sectionAlignment);
  u32(opt + 36, fileAlignment);
  u32(opt + 56, sizeOfImage);
  u32(opt + 60, 0x200);
  u16(opt + 68, 3);
  u32(opt + 108, 0);

  const sectionVirtualAddress = sectionAlignment < 0x1000 ? 0x200 : 0x1000;
  const sec = opt + 112;
  bytes.set(new TextEncoder().encode('.text'), sec);
  u32(sec + 8, 0x10);
  u32(sec + 12, sectionVirtualAddress);
  u32(sec + 16, 0x200);
  u32(sec + 20, 0x200);
  u32(sec + 36, 0x60000020);
  return bytes;
}

test('#4118 SectionAlignment 0x1000 / FileAlignment 0x200 stays a valid image mapping', () => {
  const image = parsePE(buildPE({ entryRva: 0x1000 }));
  assert.equal(image.sections.length, 1);
  assert.equal(image.metadata.peSectionRawSizes[0].alignmentValid, true);
  assert.equal(image.metadata.entrypointValid, true);
  assert.equal(image.functions.some((f) => f.source === 'entrypoint'), true);
});

test('#4118 low-alignment SectionAlignment == FileAlignment stays valid', () => {
  const image = parsePE(buildPE({ sectionAlignment: 0x200, fileAlignment: 0x200, entryRva: 0x200 }));
  assert.equal(image.sections.length, 1);
  assert.equal(image.metadata.peSectionRawSizes[0].alignmentValid, true);
  assert.equal(image.metadata.entrypointValid, true);
});

test('#4118 SectionAlignment 0 with FileAlignment 0x200 must not become canonical', () => {
  assert.throws(
    () => parsePE(buildPE({ sectionAlignment: 0, fileAlignment: 0x200 })),
    /SectionAlignment/,
    'issue minimal repro: SectionAlignment=0, FileAlignment=0x200',
  );
});

test('#4118 SectionAlignment below FileAlignment is rejected before section mapping', () => {
  assert.throws(
    () => parsePE(buildPE({ sectionAlignment: 0x100, fileAlignment: 0x200 })),
    /SectionAlignment 0x100 is smaller than FileAlignment 0x200/,
  );
});

test('#4118 sub-page SectionAlignment differing from FileAlignment is rejected', () => {
  assert.throws(
    () => parsePE(buildPE({ sectionAlignment: 0x800, fileAlignment: 0x200 })),
    /FileAlignment must equal SectionAlignment/,
  );
});

test('#4118 non-power-of-two FileAlignment remains a per-section raw-size fallback, not an image rejection', () => {
  const image = parsePE(buildPE({ sectionAlignment: 0x1000, fileAlignment: 0x180 }));
  assert.equal(image.sections.length, 1);
  assert.equal(image.metadata.peSectionRawSizes[0].alignmentValid, false);
  assert.ok(image.warnings.some((w) => /invalid FileAlignment 0x180/.test(w)));
});
