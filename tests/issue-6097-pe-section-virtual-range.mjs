/**
 * #6097 regression: a PE section whose VirtualAddress + VirtualSize (or the
 * SizeOfRawData fallback) extends past the 32-bit RVA domain or past
 * SizeOfImage must not be promoted to a canonical BinaryImage mapping. The
 * malformed section is recorded with an explicit partial reason instead.
 */
import assert from 'node:assert/strict';
import { parsePE } from '../js/binary/pe.js';

const PE64_DIRECTORY_OFFSET = 112;

function dosAndPeHeader() {
  return [
    0x4d, 0x5a, ...Array(0x3a).fill(0), 0x40, 0, 0, 0,
    0x50, 0x45, 0, 0,
    0x64, 0x86, // Machine = AMD64
    0, 0,       // NumberOfSections (patched)
    0, 0, 0, 0, // TimeDateStamp
    0, 0, 0, 0, // PointerToSymbolTable
    0, 0, 0, 0, // NumberOfSymbols
    0, 0,       // SizeOfOptionalHeader (patched)
    0x22, 0x00, // Characteristics
  ];
}

function optionalHeader({ sizeOptional, sizeOfImage }) {
  const header = new Array(sizeOptional).fill(0);
  const put16 = (offset, value) => { header[offset] = value & 0xff; header[offset + 1] = (value >>> 8) & 0xff; };
  const put32 = (offset, value) => { put16(offset, value & 0xffff); put16(offset + 2, (value >>> 16) & 0xffff); };
  put16(0, 0x20b);     // Magic PE32+
  put32(16, 0x1000);   // AddressOfEntryPoint
  put32(24 + 0, 0);    // (image base low, set via u64 below)
  put32(32, 0x1000);   // SectionAlignment
  put32(36, 0x200);    // FileAlignment
  put32(56, sizeOfImage);
  put32(60, 0x200);    // SizeOfHeaders
  put16(68, 3);        // Subsystem
  put32(108, 16);      // NumberOfRvaAndSizes matches physical space
  const available = Math.max(0, Math.floor((sizeOptional - PE64_DIRECTORY_OFFSET) / 8));
  for (let i = 0; i < Math.min(16, available); i++) {
    put32(PE64_DIRECTORY_OFFSET + i * 8, 0);
    put32(PE64_DIRECTORY_OFFSET + i * 8 + 4, 0);
  }
  return header;
}

function sectionEntry({ name, virtualAddress, virtualSize, sizeRaw = 0, ptrRaw = 0, flags = 0x40000040 }) {
  const entry = [...Buffer.from(name.padEnd(8, '\0').slice(0, 8), 'latin1')];
  const put32 = (offset, value) => {
    entry[offset] = value & 0xff; entry[offset + 1] = (value >>> 8) & 0xff;
    entry[offset + 2] = (value >>> 16) & 0xff; entry[offset + 3] = (value >>> 24) & 0xff;
  };
  put32(8, virtualSize);
  put32(12, virtualAddress);
  put32(16, sizeRaw);
  put32(20, ptrRaw);
  put32(36, flags);
  return entry;
}

function buildPE({ sections, sizeOfImage }) {
  const sizeOptional = 112 + 16 * 8;
  const bytes = [
    ...dosAndPeHeader(),
    ...optionalHeader({ sizeOptional, sizeOfImage }),
  ];
  bytes[70] = sections.length & 0xff;
  bytes[71] = (sections.length >>> 8) & 0xff;
  bytes[84] = sizeOptional & 0xff;
  bytes[85] = (sizeOptional >>> 8) & 0xff;
  // ImageBase = 0x140000000 at optional-header offset 24 (file offset opt+24 = 88+24).
  const base = 0x140000000n;
  for (let i = 0; i < 8; i++) bytes[88 + 24 + i] = Number((base >> BigInt(8 * i)) & 0xffn);
  for (const section of sections) bytes.push(...sectionEntry(section));
  bytes.push(...Buffer.alloc(0x400, 0xcc));
  return new Uint8Array(bytes);
}

// 1. In-range section maps as before: RVA=0x1000, VirtualSize=0x1000, SizeOfImage>=0x2000.
{
  const image = parsePE(buildPE({
    sizeOfImage: 0x2000,
    sections: [{ name: '.text', virtualAddress: 0x1000, virtualSize: 0x1000 }],
  }));
  assert.equal(image.sections.length, 1);
  assert.equal(image.sections[0].address, 0x140001000n);
  assert.equal(image.sections[0].size, 0x1000n);
  assert.equal(image.metadata.peMetadata?.complete, true);
}

// 2. RVA=0xfffff000, VirtualSize=0x2000: end 0x100001000 exceeds 2^32 -> no canonical mapping.
{
  const image = parsePE(buildPE({
    sizeOfImage: 0xfffff000,
    sections: [{ name: '.ovf', virtualAddress: 0xfffff000, virtualSize: 0x2000 }],
  }));
  assert.equal(image.sections.length, 0, 'RVA-domain overflow must not become a canonical section');
  assert.equal(image.segments.filter((s) => s.source === 'PE-section').length, 0);
  assert.equal(image.metadata.peMetadata.complete, false);
  assert.ok(image.metadata.peMetadata.reasons.includes('pe:section-virtual-range-rva-overflow'));
  assert.equal(image.metadata.peSectionsWithInvalidVirtualRange.length, 1);
  assert.equal(image.metadata.peSectionsWithInvalidVirtualRange[0].beyondRvaDomain, true);
  assert.ok(image.warnings.some((w) => /32-bit RVA domain/.test(w)));
}

// 3. End exactly at 2^32: within the RVA domain under the exclusive-boundary
//    policy (no RVA-overflow reason), but past any 32-bit SizeOfImage, so it
//    is still excluded from canonical mapping by the SizeOfImage rule.
{
  const image = parsePE(buildPE({
    sizeOfImage: 0xfffff000,
    sections: [{ name: '.edge', virtualAddress: 0xfffff000, virtualSize: 0x1000 }],
  }));
  assert.equal(image.sections.length, 0);
  assert.ok(image.metadata.peMetadata.reasons.includes('pe:section-virtual-range-exceeds-size-of-image'));
  assert.ok(!image.metadata.peMetadata.reasons.includes('pe:section-virtual-range-rva-overflow'), 'end == 2^32 is not an RVA overflow');
}

// 4. Within the RVA domain but past SizeOfImage: excluded from canonical mapping.
{
  const image = parsePE(buildPE({
    sizeOfImage: 0x5000,
    sections: [{ name: '.big', virtualAddress: 0x4000, virtualSize: 0x3000 }],
  }));
  assert.equal(image.sections.length, 0, 'section past SizeOfImage must not become canonical');
  assert.ok(image.metadata.peMetadata.reasons.includes('pe:section-virtual-range-exceeds-size-of-image'));
  assert.ok(image.warnings.some((w) => /SizeOfImage/.test(w)));
}

// 5. VirtualSize=0 falls back to SizeOfRawData and gets the same validation.
{
  const image = parsePE(buildPE({
    sizeOfImage: 0x5000,
    sections: [{ name: '.raw', virtualAddress: 0x4000, virtualSize: 0, sizeRaw: 0x3000 }],
  }));
  assert.equal(image.sections.length, 0);
  assert.ok(image.metadata.peMetadata.reasons.includes('pe:section-virtual-range-exceeds-size-of-image'));
}

// 6. Zero-fill section (SizeOfRawData=0) with a valid range still maps.
{
  const image = parsePE(buildPE({
    sizeOfImage: 0x5000,
    sections: [{ name: '.bss', virtualAddress: 0x4000, virtualSize: 0x1000, sizeRaw: 0 }],
  }));
  assert.equal(image.sections.length, 1);
  assert.equal(image.metadata.peMetadata?.complete, true);
}

console.log('issue #6097 PE section virtual range validation: PASS');
