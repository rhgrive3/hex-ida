import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DBI_HEADER_SIZE,
  PdbDebugInfoProvider,
  parseDbiHeader,
  parseMsf,
  parseSectionHeaders,
} from '../../../js/analysis/debug/pdb.js';
import {
  loadPdbFixtures,
  pdbImage,
} from '../../../tools/validation/phase7/lanes/debug.mjs';

function sectionBytes(length) {
  const bytes = new Uint8Array(length);
  if (length >= 40) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    view.setUint32(12, 0x1000, true);
    view.setUint32(16, 0x200, true);
  }
  return bytes;
}

for (const [length, expectedHeaders] of [
  [0, 0],
  [1, 0],
  [39, 0],
  [40, 1],
  [41, 1],
  [79, 1],
  [80, 2],
]) {
  test(`#4709 parseSectionHeaders preserves the complete prefix at ${length} bytes`, () => {
    assert.equal(parseSectionHeaders(sectionBytes(length)).length, expectedHeaders);
  });
}

function optionalSectionHeaderStreamIndex(pdbBytes) {
  const msf = parseMsf(pdbBytes);
  assert.equal(msf.complete, true, 'fixture MSF must be structurally complete');
  const dbiBytes = msf.streams[3].read();
  const dbi = parseDbiHeader(dbiBytes);
  assert.ok(dbi, 'fixture DBI must parse');

  const optionalHeaderOffset = DBI_HEADER_SIZE
    + dbi.moduleSubstreamSize
    + dbi.sectionContributionSize
    + dbi.sectionMapSize
    + dbi.sourceInfoSize
    + dbi.typeServerMapSize
    + dbi.ecSubstreamSize;
  assert.ok(dbi.optionalDbgHeaderSize >= 12, 'fixture must expose optional SectionHdr index 5');
  const view = new DataView(dbiBytes.buffer, dbiBytes.byteOffset, dbiBytes.byteLength);
  return view.getUint16(optionalHeaderOffset + (5 * 2), true);
}

function rewriteStreamSize(image, streamIndex, newSize) {
  const bytes = new Uint8Array(image);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const blockSize = view.getUint32(32, true);
  const numDirectoryBytes = view.getUint32(44, true);
  const blockMapAddr = view.getUint32(52, true);
  const directoryBlockCount = Math.ceil(numDirectoryBytes / blockSize);
  const directoryBlocks = [];
  const mapOffset = blockMapAddr * blockSize;
  for (let i = 0; i < directoryBlockCount; i += 1) {
    directoryBlocks.push(view.getUint32(mapOffset + (i * 4), true));
  }

  const logicalOffset = 4 + (streamIndex * 4);
  const directoryBlock = directoryBlocks[Math.floor(logicalOffset / blockSize)];
  const physicalOffset = (directoryBlock * blockSize) + (logicalOffset % blockSize);
  view.setUint32(physicalOffset, newSize, true);
  return bytes;
}

test('#4709 provider reports a truncated section-header stream without discarding its safe prefix', () => {
  const variant = loadPdbFixtures().variants[0];
  const original = new Uint8Array(Buffer.from(variant.pdb, 'base64'));
  const streamIndex = optionalSectionHeaderStreamIndex(original);
  const msf = parseMsf(original);
  assert.equal(msf.streams[streamIndex].size, 160, 'fixture must carry four complete 40-byte headers');

  const baseline = new PdbDebugInfoProvider().probe({ ...pdbImage(variant), pdbBytes: original });
  assert.equal(baseline.parsed.sectionHeaders.length, 4);
  assert.equal(baseline.diagnostics.some((detail) => detail.includes('section header stream is truncated')), false,
    'an exact 40-byte multiple must not acquire a truncation diagnostic');

  for (const size of [161, 199]) {
    const candidate = rewriteStreamSize(original, streamIndex, size);
    const result = new PdbDebugInfoProvider().probe({ ...pdbImage(variant), pdbBytes: candidate });

    assert.equal(result.parsed.sectionHeaders.length, 4,
      `${size} bytes must preserve the four complete section headers`);
    assert.ok(result.diagnostics.some((detail) => detail.includes('section header stream is truncated')),
      `${size} bytes must surface the trailing ${size % 40}-byte truncation`);
    assert.equal(result.status.completeness, 'partial');
  }
});
