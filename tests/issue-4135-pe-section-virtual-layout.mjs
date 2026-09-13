import assert from 'node:assert/strict';
import { parsePE } from '../js/binary/pe.js';

// Issue #4135: parsePE() registered each PE section's VirtualAddress/VirtualSize
// directly as a canonical BinaryImage virtual mapping without validating the PE
// image section-layout contract (SectionAlignment alignment of every RVA, an
// ascending source section table, and non-overlapping virtual extents). A
// misaligned / overlapping / out-of-order section set therefore produced a
// canonical RVA->file mapping that no Windows image loader would ever build,
// and finalize()'s address sort hid the source-order violation.
//
// Expected after the fix: a violated section is excluded from canonical mapping
// and the image is marked PE-metadata incomplete, so exact downstream evidence
// (entrypoint/functions/imports/exception) is not promoted from it.

const IMAGE_BASE_64 = 0x140000000n;
const IMAGE_BASE_32 = 0x400000n;

function buildPE({
  bits = 64,
  machine = 0x8664,
  sectionAlignment = 0x1000,
  fileAlignment = 0x200,
  sizeOfHeaders = 0x200,
  entryRva = 0,
  sections = [],
}) {
  const imageBase = bits === 64 ? IMAGE_BASE_64 : IMAGE_BASE_32;
  let capacity = sizeOfHeaders + 0x1000;
  for (const s of sections) capacity = Math.max(capacity, (s.ptr || 0) + (s.rawSize || 0));
  const bytes = new Uint8Array(capacity);
  const dv = new DataView(bytes.buffer);
  const pe = 0x80, coff = pe + 4;
  const optionalSize = bits === 64 ? 0xf0 : 0xe0;
  const opt = coff + 20;
  const secBase = opt + optionalSize;

  dv.setUint16(0, 0x5a4d, true);
  dv.setUint32(0x3c, pe, true);
  dv.setUint32(pe, 0x00004550, true);
  dv.setUint16(coff, machine, true);
  dv.setUint16(coff + 2, sections.length, true);
  dv.setUint16(coff + 16, optionalSize, true);
  dv.setUint16(coff + 18, 0x0002, true);
  dv.setUint16(opt, bits === 64 ? 0x20b : 0x10b, true);
  dv.setUint32(opt + 16, entryRva, true);
  if (bits === 64) dv.setBigUint64(opt + 24, imageBase, true);
  else dv.setUint32(opt + 28, Number(imageBase), true);
  dv.setUint32(opt + 32, sectionAlignment, true);
  dv.setUint32(opt + 36, fileAlignment, true);

  // SizeOfImage is a SectionAlignment-rounded loader extent that must contain
  // every declared virtual section range so only the intended invariant trips.
  let virtualHigh = sizeOfHeaders;
  for (const s of sections) virtualHigh = Math.max(virtualHigh, s.rva + (s.vsize || s.rawSize || 0));
  const sizeOfImage = Math.ceil(virtualHigh / sectionAlignment) * sectionAlignment;
  dv.setUint32(opt + 56, sizeOfImage, true);
  dv.setUint32(opt + 60, sizeOfHeaders, true);
  dv.setUint16(opt + 68, 3, true);
  dv.setUint32(opt + (bits === 64 ? 108 : 92), 0, true);

  sections.forEach((s, i) => {
    const p = secBase + i * 40;
    bytes.set(new TextEncoder().encode(s.name), p);
    dv.setUint32(p + 8, s.vsize || 0, true);
    dv.setUint32(p + 12, s.rva, true);
    dv.setUint32(p + 16, s.rawSize || 0, true);
    dv.setUint32(p + 20, s.ptr || 0, true);
    dv.setUint32(p + 36, s.flags ?? 0x60000020, true);
  });
  return bytes;
}

const canonical = (image, rva) =>
  image.sections.filter((s) => s.source === 'PE-section' && s.address === image.imageBase + BigInt(rva));
const incomplete = (image) => image.metadata.peMetadata && image.metadata.peMetadata.complete === false;
const hasReason = (image, fragment) =>
  (image.metadata.peMetadata?.reasons || []).some((r) => r.includes(fragment));

// 1. A properly aligned, single section is promoted to canonical mapping.
{
  const image = parsePE(buildPE({ sections: [{ name: '.text', rva: 0x1000, vsize: 0x100, rawSize: 0x200, ptr: 0x200 }] }));
  assert.equal(canonical(image, 0x1000).length, 1, 'aligned section is canonical');
  assert.equal(image.metadata.peMetadata.complete, true, 'valid layout stays complete');
}

// 2. A misaligned VirtualAddress is not promoted to canonical mapping.
{
  const image = parsePE(buildPE({ sections: [{ name: '.evil', rva: 0x1800, vsize: 0x100, rawSize: 0x200, ptr: 0x200 }] }));
  assert.equal(incomplete(image), true, 'misaligned RVA marks the image partial');
  assert.equal(canonical(image, 0x1800).length, 0, 'misaligned section is excluded from canonical mapping');
  assert.equal(image.addressToOffset(image.imageBase + 0x1800n), null, 'no canonical RVA->file mapping for the misaligned section');
  assert.ok(hasReason(image, 'align'), 'a section-alignment reason is recorded');
}

// 3. Multiple ascending, non-overlapping sections are all preserved.
{
  const image = parsePE(buildPE({ sections: [
    { name: '.text', rva: 0x1000, vsize: 0x400, rawSize: 0x400, ptr: 0x200 },
    { name: '.data', rva: 0x2000, vsize: 0x400, rawSize: 0x400, ptr: 0x600 },
    { name: '.rsrc', rva: 0x3000, vsize: 0x400, rawSize: 0x400, ptr: 0xa00 },
  ] }));
  assert.equal(image.metadata.peMetadata.complete, true, 'ascending/non-overlapping layout stays complete');
  assert.equal(canonical(image, 0x1000).length + canonical(image, 0x2000).length + canonical(image, 0x3000).length, 3);
}

// 4. Overlapping virtual extents are rejected as a canonical mapping.
{
  const image = parsePE(buildPE({ sections: [
    { name: '.a', rva: 0x1000, vsize: 0x1800, rawSize: 0x400, ptr: 0x200 },
    { name: '.b', rva: 0x2000, vsize: 0x1000, rawSize: 0x400, ptr: 0x600 },
  ] }));
  assert.equal(incomplete(image), true, 'overlapping extents mark the image partial');
  assert.equal(canonical(image, 0x2000).length, 0, 'the overlapping section is not promoted');
  assert.ok(hasReason(image, 'overlap'), 'an overlap reason is recorded');
}

// 5. A source section table that is not RVA-ascending is rejected.
{
  const image = parsePE(buildPE({ sections: [
    { name: '.hi', rva: 0x3000, vsize: 0x400, rawSize: 0x400, ptr: 0x200 },
    { name: '.lo', rva: 0x1000, vsize: 0x400, rawSize: 0x400, ptr: 0x600 },
  ] }));
  assert.equal(incomplete(image), true, 'out-of-order section table marks the image partial');
  assert.equal(canonical(image, 0x1000).length, 0, 'the out-of-order section is not promoted');
  assert.ok(hasReason(image, 'ascend') || hasReason(image, 'order'), 'an ordering reason is recorded');
}

// 6. A low-alignment image whose sections match its declared SectionAlignment
// coexists with #4131/#5539 (the alignment check uses the actual granularity).
{
  const image = parsePE(buildPE({
    bits: 32, machine: 0x014c, sectionAlignment: 0x10, fileAlignment: 0x10, sizeOfHeaders: 0x100,
    sections: [
      { name: '.a', rva: 0x100, vsize: 0x30, rawSize: 0x30, ptr: 0x100 },
      { name: '.b', rva: 0x140, vsize: 0x30, rawSize: 0x30, ptr: 0x140 },
    ],
  }));
  assert.equal(image.metadata.peMetadata.complete, true, 'low-alignment aligned/ascending layout stays complete');
  assert.equal(canonical(image, 0x100).length + canonical(image, 0x140).length, 2);
}

// 7. Exact entrypoint evidence is never promoted from an invalid virtual layout.
{
  const image = parsePE(buildPE({
    entryRva: 0x1800,
    sections: [{ name: '.evil', rva: 0x1800, vsize: 0x100, rawSize: 0x200, ptr: 0x200, flags: 0x60000020 }],
  }));
  assert.equal(image.functions.some((f) => f.source === 'entrypoint'), false, 'entrypoint is not seeded from the rejected section');
  assert.equal(image.metadata.entrypointValid, false, 'entrypoint validity is fail-closed');
}

console.log('issue #4135 PE section virtual-layout validation regression: PASS');
