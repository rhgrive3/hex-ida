/**
 * #6118 regression: when NumberOfRvaAndSizes declares more Data Directory
 * entries than the physical SizeOfOptionalHeader can hold, parsePE() must
 * record the truncation explicitly (warning + metadata) instead of silently
 * treating the missing directories as absent.
 */
import assert from 'node:assert/strict';
import { parsePE } from '../js/binary/pe.js';

const PE64_DIRECTORY_OFFSET = 112; // PE32+ data directories start at optional-header offset 112
const PE32_DIRECTORY_OFFSET = 96;  // PE32 data directories start at optional-header offset 96
const DIRECTORY_TRUNCATION_REASON = 'optional-header:data-directories-truncated';

function assertDirectoryMetadataPartial(image) {
  assert.equal(image.metadata.peMetadata.complete, false);
  assert.ok(image.metadata.peMetadata.reasons.includes(DIRECTORY_TRUNCATION_REASON), JSON.stringify(image.metadata.peMetadata));
}

function assertDirectoryMetadataComplete(image) {
  assert.equal(image.metadata.peMetadata.complete, true, JSON.stringify(image.metadata.peMetadata));
  assert.ok(!image.metadata.peMetadata.reasons.includes(DIRECTORY_TRUNCATION_REASON), JSON.stringify(image.metadata.peMetadata));
}

function dosAndPeHeader() {
  // 'MZ', e_lfanew=0x40, PE\0\0
  return [
    0x4d, 0x5a, ...Array(0x3a).fill(0), 0x40, 0, 0, 0,
    0x50, 0x45, 0, 0,
    0x64, 0x86, // Machine = AMD64 (overridden for PE32)
    1, 0,       // NumberOfSections
    0, 0, 0, 0, // TimeDateStamp
    0, 0, 0, 0, // PointerToSymbolTable
    0, 0, 0, 0, // NumberOfSymbols
    0, 0,       // SizeOfOptionalHeader (patched)
    0x22, 0x00, // Characteristics
  ];
}

function optionalHeader({ bits = 64, sizeOptional, numberOfRvaAndSizes, directoryEntries = 0 }) {
  const is64 = bits === 64;
  const directoryOffset = is64 ? PE64_DIRECTORY_OFFSET : PE32_DIRECTORY_OFFSET;
  const header = new Array(sizeOptional).fill(0);
  const put16 = (offset, value) => { header[offset] = value & 0xff; header[offset + 1] = (value >>> 8) & 0xff; };
  const put32 = (offset, value) => { put16(offset, value & 0xffff); put16(offset + 2, (value >>> 16) & 0xffff); };
  put16(0, is64 ? 0x20b : 0x10b); // Magic
  put32(16, 0x1000);              // AddressOfEntryPoint
  put32(32, 0x1000);              // SectionAlignment
  put32(36, 0x200);               // FileAlignment
  put32(56, 0x2000);              // SizeOfImage
  put32(60, 0x200);               // SizeOfHeaders
  put16(68, 3);                   // Subsystem = console
  put32(is64 ? 108 : 92, numberOfRvaAndSizes);
  // Physical directory entries actually present inside the header.
  const availableEntries = Math.max(0, Math.floor((sizeOptional - directoryOffset) / 8));
  for (let i = 0; i < Math.min(directoryEntries, availableEntries); i++) {
    put32(directoryOffset + i * 8, 0x2000 + i * 0x10); // rva
    put32(directoryOffset + i * 8 + 4, 0x10);          // size
  }
  return header;
}

function sectionTable(sections) {
  const out = [];
  for (const section of sections) {
    out.push(...Buffer.alloc(40, 0));
  }
  return out;
}

function sectionEntry({ name, virtualAddress, virtualSize, sizeRaw, ptrRaw, flags = 0x60000020 }) {
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

function buildPE({ bits = 64, sizeOptional, numberOfRvaAndSizes, directoryEntries = 0, sections = [] }) {
  const bytes = [
    ...dosAndPeHeader(),
    ...optionalHeader({ bits, sizeOptional, numberOfRvaAndSizes, directoryEntries }),
    ...sectionTable(sections),
  ];
  // COFF header: sizeOfOptionalHeader lives at file offset 84 (coff+16);
  // NumberOfSections lives at file offset 70 (coff+2).
  bytes[84] = sizeOptional & 0xff;
  bytes[85] = (sizeOptional >>> 8) & 0xff;
  bytes[70] = sections.length & 0xff;
  bytes[71] = (sections.length >>> 8) & 0xff;
  for (const section of sections) bytes.push(...sectionEntry(section));
  // Pad with a little file body so sections have something to map.
  bytes.push(...Buffer.alloc(0x400, 0xcc));
  return new Uint8Array(bytes);
}

function parse(bytes) {
  return parsePE(bytes);
}

// 1. SizeOfOptionalHeader=112 (PE32+), NumberOfRvaAndSizes=0: valid, no directories.
{
  const image = parse(buildPE({ sizeOptional: 112, numberOfRvaAndSizes: 0 }));
  assert.equal(image.metadata.directories.length, 0);
  assert.ok(!image.warnings.some((w) => /Data Director/i.test(w)), 'no truncation warning expected');
  assert.equal(image.metadata.peDataDirectoriesTruncated, undefined);
  assertDirectoryMetadataComplete(image);
}

// 2. PE32+ SizeOfOptionalHeader=112, NumberOfRvaAndSizes=16: declares 16 entries
//    but the physical header holds zero -> malformed/partial, not silently absent.
{
  const image = parse(buildPE({ sizeOptional: 112, numberOfRvaAndSizes: 16 }));
  assert.equal(image.metadata.directories.length, 0);
  assert.equal(image.metadata.peDataDirectoriesTruncated, true);
  assert.ok(image.warnings.some((w) => /declares 16 data directories/.test(w) && /only holds 0/.test(w)), JSON.stringify(image.warnings));
  assertDirectoryMetadataPartial(image);
}

// 3. PE32 SizeOfOptionalHeader=96, NumberOfRvaAndSizes=16: same shape.
{
  const image = parse(buildPE({
    bits: 32, sizeOptional: 96, numberOfRvaAndSizes: 16,
    sections: [{ name: '.text', virtualAddress: 0x1000, virtualSize: 0x10, sizeRaw: 0x200, ptrRaw: 0x400 }],
  }));
  assert.equal(image.metadata.peDataDirectoriesTruncated, true);
  assert.ok(image.warnings.some((w) => /data director/i.test(w)));
  assertDirectoryMetadataPartial(image);
}

// 4. Declared N entries with exactly N*8 bytes present: valid.
{
  const sizeOptional = 112 + 2 * 8; // two physical entries
  const image = parse(buildPE({ sizeOptional, numberOfRvaAndSizes: 2, directoryEntries: 2 }));
  assert.equal(image.metadata.directories.length, 2);
  assert.equal(image.metadata.directories[0].rva, 0x2000);
  assert.equal(image.metadata.peDataDirectoriesTruncated, undefined);
  assert.ok(!image.warnings.some((w) => /Data Director/i.test(w)));
}

// 4a. Exact-fit directory capacity alone remains canonical-complete.
{
  const sizeOptional = 112 + 2 * 8;
  const image = parse(buildPE({ sizeOptional, numberOfRvaAndSizes: 2 }));
  assert.equal(image.metadata.directories.length, 2);
  assert.equal(image.metadata.peDataDirectoriesTruncated, undefined);
  assertDirectoryMetadataComplete(image);
}

// 5. NumberOfRvaAndSizes < available entries: only the declared count is used.
{
  const sizeOptional = 112 + 4 * 8;
  const image = parse(buildPE({ sizeOptional, numberOfRvaAndSizes: 2, directoryEntries: 4 }));
  assert.equal(image.metadata.directories.length, 2);
  assert.equal(image.metadata.peDataDirectoriesTruncated, undefined);
}

// 6. Declared more than 16 while the first 16 physically exist: known policy
//    (use the first 16) is maintained with no truncation warning.
{
  const sizeOptional = 112 + 16 * 8;
  const image = parse(buildPE({ sizeOptional, numberOfRvaAndSizes: 24, directoryEntries: 16 }));
  assert.equal(image.metadata.directories.length, 16);
  assert.equal(image.metadata.peDataDirectoriesTruncated, undefined);
  assert.ok(!image.warnings.some((w) => /Data Director/i.test(w)));
}

// 6a. More than 16 declared with all 16 known slots physically present is not
// truncation; zero-valued directory records keep the control otherwise valid.
{
  const sizeOptional = 112 + 16 * 8;
  const image = parse(buildPE({ sizeOptional, numberOfRvaAndSizes: 24 }));
  assert.equal(image.metadata.directories.length, 16);
  assert.equal(image.metadata.peDataDirectoriesTruncated, undefined);
  assertDirectoryMetadataComplete(image);
}

// 7. Truncated directory declaration must not invent completeness downstream.
{
  const image = parse(buildPE({
    sizeOptional: 112 + 8, // one physical entry
    numberOfRvaAndSizes: 16,
    directoryEntries: 1,
  }));
  assert.equal(image.metadata.directories.length, 1);
  assert.equal(image.metadata.peDataDirectoriesTruncated, true);
  assert.ok(image.warnings.some((w) => /declares 16 data directories/.test(w) && /only holds 1/.test(w)));
  assertDirectoryMetadataPartial(image);
}

// 8. The declared-but-missing directory is not laundered into "absent": import
//    parsing sees no import directory because the data is not there, but the
//    image records the reason.
{
  const image = parse(buildPE({ sizeOptional: 112, numberOfRvaAndSizes: 16 }));
  assert.equal(image.imports.length, 0);
  assert.equal(image.metadata.peDataDirectoriesTruncated, true);
  assert.ok(image.metadata.peDataDirectoryShortfall > 0);
  assertDirectoryMetadataPartial(image);
}

console.log('issue #6118 PE data-directory declaration validation: PASS');
