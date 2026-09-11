import assert from 'node:assert/strict';
import { parsePE } from '../js/binary/pe.js';

// Issue #5539: windowsImageSectionRawMapping() applied the Windows loader's
// 0x200 sector round-down to every nonconforming PointerToRawData, including
// low-alignment images (SectionAlignment < 0x1000). pefile issue #465's
// resource-only PE (SectionAlignment = FileAlignment = 0x10,
// PointerToRawData = 0x160, VirtualAddress = 0x1a0) proves the loader
// consumes such images at their declared raw offsets; rounding redirected
// the section mapping into the MZ/header bytes.

function makePE({ sectionAlignment, fileAlignment, machine = 0x014c, bits = 32 }) {
  const bytes = new Uint8Array(0x400);
  const view = new DataView(bytes.buffer);
  const pe = 0x80, coff = pe + 4;
  const optionalSize = bits === 64 ? 0xf0 : 0xe0;
  const opt = coff + 20, section = opt + optionalSize;
  const imageBase = bits === 64 ? 0x140000000n : 0x400000n;
  view.setUint16(0, 0x5a4d, true);
  view.setUint32(0x3c, pe, true);
  view.setUint32(pe, 0x00004550, true);
  view.setUint16(coff, machine, true);
  view.setUint16(coff + 2, 1, true);
  view.setUint16(coff + 16, optionalSize, true);
  view.setUint16(coff + 18, 0x0002, true);
  view.setUint16(opt, bits === 64 ? 0x20b : 0x10b, true);
  view.setUint32(opt + 16, 0, true);
  if (bits === 64) view.setBigUint64(opt + 24, imageBase, true);
  else view.setUint32(opt + 28, Number(imageBase), true);
  view.setUint32(opt + 32, sectionAlignment, true);
  view.setUint32(opt + 36, fileAlignment, true);
  view.setUint32(opt + 56, 0x200, true);
  view.setUint32(opt + 60, 0x200, true);
  view.setUint16(opt + 68, 3, true);
  view.setUint32(opt + (bits === 64 ? 108 : 92), 0, true);
  bytes.set(new TextEncoder().encode('.rsrc'), section);
  view.setUint32(section + 8, 0x60, true);
  view.setUint32(section + 12, 0x1a0, true);
  view.setUint32(section + 16, 0x60, true);
  view.setUint32(section + 20, 0x160, true);
  view.setUint32(section + 36, 0x40000040, true);
  // Distinct sentinels: 0x160 holds the section payload, 0x0 the header.
  bytes[0] = 0x4d; bytes[1] = 0x5a;
  bytes[0x160] = 0xab; bytes[0x161] = 0xcd;
  return { bytes, imageBase };
}

function mappingOf(image) {
  return image.metadata.peSectionRawMappings.find((m) => m.name === '.rsrc');
}

// 1. Low-alignment image: declared raw offset is honored, no round-down.
{
  const { bytes, imageBase } = makePE({ sectionAlignment: 0x10, fileAlignment: 0x10 });
  const image = parsePE(bytes);
  const mapping = mappingOf(image);
  assert.equal(mapping.effectiveFileOffset, 0x160, 'low-alignment mapping keeps the declared raw offset');
  assert.equal(mapping.roundedDown, false);
  assert.equal(mapping.policy, 'low-alignment-declared-raw-offset');
  assert.equal(image.sections[0].fileOffset, 0x160n);
  assert.equal(image.addressToOffset(imageBase + 0x1a0n), 0x160n, 'RVA 0x1a0 resolves to file 0x160');
  const data = image.readVirtual(imageBase + 0x1a0n, 2);
  assert.deepEqual([...data], [0xab, 0xcd], 'virtual reads see the section bytes, not the header');
}

// 2. Other low-alignment granularities (0x20, 0x1000 boundary is excluded).
{
  const { bytes, imageBase } = makePE({ sectionAlignment: 0x20, fileAlignment: 0x20 });
  const image = parsePE(bytes);
  assert.equal(mappingOf(image).effectiveFileOffset, 0x160, 'SectionAlignment 0x20 keeps the declared raw offset');
  assert.equal(image.addressToOffset(imageBase + 0x1a0n), 0x160n);
}

// 3. Normal alignment: #2476's loader-compatible round-down is preserved.
{
  const { bytes, imageBase } = makePE({ sectionAlignment: 0x1000, fileAlignment: 0x200 });
  const image = parsePE(bytes);
  const mapping = mappingOf(image);
  assert.equal(mapping.effectiveFileOffset, 0x0, 'malformed normal-alignment PointerToRawData still rounds down to 0x800-sector semantics');
  assert.equal(mapping.roundedDown, true);
  assert.equal(mapping.policy, 'windows-image-loader-0x200-round-down');
  assert.equal(mapping.declaredFileOffset, 0x160, 'declared provenance is retained');
  assert.ok(image.warnings.some((warning) => warning.includes('nonconforming')), 'the nonconforming warning remains');
}

// 4. Normal alignment with conforming offsets is untouched.
{
  const bytes = makePE({ sectionAlignment: 0x1000, fileAlignment: 0x200 }).bytes;
  const view = new DataView(bytes.buffer);
  view.setUint32(0x80 + 4 + 20 + 0xe0 + 20, 0x200, true); // PointerToRawData = 0x200 (0x200-aligned)
  const image = parsePE(bytes);
  const mapping = mappingOf(image);
  assert.equal(mapping.effectiveFileOffset, 0x200);
  assert.equal(mapping.roundedDown, false);
}

// 5. PointerToRawData = 0 keeps its uninitialized semantics.
{
  const bytes = makePE({ sectionAlignment: 0x10, fileAlignment: 0x10 }).bytes;
  const view = new DataView(bytes.buffer);
  view.setUint32(0x80 + 4 + 20 + 0xe0 + 20, 0, true);
  const image = parsePE(bytes);
  const mapping = mappingOf(image);
  assert.equal(mapping.fileBacked, false, 'zero raw pointer stays not-file-backed');
  assert.equal(mapping.effectiveFileOffset, 0);
  assert.equal(mapping.roundedDown, false);
}

// 6. PE32+ low-alignment images share the policy.
{
  const { bytes, imageBase } = makePE({ sectionAlignment: 0x10, fileAlignment: 0x10, bits: 64, machine: 0x8664 });
  const image = parsePE(bytes);
  assert.equal(mappingOf(image).effectiveFileOffset, 0x160, 'PE32+ low-alignment keeps the declared raw offset');
  assert.equal(image.addressToOffset(imageBase + 0x1a0n), 0x160n);
}

console.log('issue #5539 low-alignment PE raw mapping regression: PASS');
