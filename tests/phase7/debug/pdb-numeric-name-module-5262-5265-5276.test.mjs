import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DBI_HEADER_SIZE,
  PdbDebugInfoProvider,
  parseDbiHeader,
  parseModuleInfo,
  parseMsf,
  parseTpiStream,
} from '../../../js/analysis/debug/pdb.js';
import {
  loadPdbFixtures,
  pdbImage,
} from '../../../tools/validation/phase7/lanes/debug.mjs';

function tpi(recordBytes) {
  const bytes = new Uint8Array(56 + recordBytes.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, 56, true);
  view.setUint32(8, 0x1000, true);
  bytes.set(recordBytes, 56);
  return bytes;
}

function structureRecord(body) {
  const len = 2 + body.length;
  return Uint8Array.from([len & 0xff, (len >> 8) & 0xff, 0x05, 0x15, ...body]);
}

// count/properties/fieldList/derivation/vshape = 16 zero bytes, then a size
// numeric leaf, then the name bytes.
const AGG_PREFIX = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

test('#5262 numeric leaves past 0x8004 consume their payloads', () => {
  // size = LF_REAL32(0x8005) 1.0f, name "Foo".
  const parsed = parseTpiStream(tpi(structureRecord([
    ...AGG_PREFIX, 0x05, 0x80, 0x00, 0x00, 0x80, 0x3f, 0x46, 0x6f, 0x6f, 0x00,
  ])));
  const type = parsed.types.get(0x1000);
  assert.equal(type?.sizeBytes, 1);
  assert.equal(type?.name, 'Foo');
  assert.equal(parsed.complete, true);
  // size = LF_QUADWORD(0x8009) 48, name "Bar".
  const quad = parseTpiStream(tpi(structureRecord([
    ...AGG_PREFIX, 0x09, 0x80, 0x30, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x42, 0x61, 0x72, 0x00,
  ])));
  assert.equal(quad.types.get(0x1000)?.sizeBytes, 48);
  assert.equal(quad.types.get(0x1000)?.name, 'Bar');
  // A leaf with no known shape (LF_COMPLEX32 0x800c) fails closed instead of
  // desyncing the record into its payload.
  const complex = parseTpiStream(tpi(structureRecord([
    ...AGG_PREFIX, 0x0c, 0x80, 0x00, 0x00, 0x80, 0x3f, 0x00, 0x00, 0x80, 0x3f,
    0x46, 0x6f, 0x6f, 0x00,
  ])));
  assert.equal(complex.types.has(0x1000), false);
  assert.equal(complex.complete, false);
});

test('#5265 unterminated aggregate names fail closed', () => {
  const parsed = parseTpiStream(tpi(structureRecord([...AGG_PREFIX, 0x04, 0x00, 0x46, 0x6f, 0x6f])));
  assert.equal(parsed.types.has(0x1000), false, 'a record ending without NUL is truncated, not a type');
  assert.equal(parsed.complete, false);
  const good = parseTpiStream(tpi(structureRecord([...AGG_PREFIX, 0x04, 0x00, 0x46, 0x6f, 0x6f, 0x00])));
  assert.equal(good.types.get(0x1000)?.name, 'Foo');
  assert.equal(good.complete, true);
});

// Locate the ModInfo entry file offset for a module so SymByteSize can be
// rewritten without disturbing the surrounding names.
function modInfoEntryOffset(dbiBytes, dbi, streamIndex, symbolByteSize) {
  const view = new DataView(dbiBytes.buffer, dbiBytes.byteOffset, dbiBytes.byteLength);
  const end = Math.min(DBI_HEADER_SIZE + dbi.moduleSubstreamSize, dbiBytes.length);
  let offset = DBI_HEADER_SIZE;
  while (offset + 64 <= end) {
    if (view.getInt16(offset + 34, true) === streamIndex
      && view.getUint32(offset + 36, true) === symbolByteSize) return offset;
    // Skip the fixed part plus both NUL-terminated names, 4-aligned.
    let cursor = offset + 64;
    for (let skip = 0; skip < 2; skip++) {
      while (cursor < end && dbiBytes[cursor] !== 0) cursor++;
      cursor++;
    }
    cursor = (cursor + 3) & ~3;
    if (cursor <= offset) break;
    offset = cursor;
  }
  return -1;
}

test('#5276 SymByteSize 4 keeps line info out of symbol records', () => {
  const variant = loadPdbFixtures().variants[0];
  const original = new Uint8Array(Buffer.from(variant.pdb, 'base64'));
  const msf = parseMsf(original);
  assert.equal(msf.complete, true);
  const dbiBytes = msf.streams[3].read();
  const dbi = parseDbiHeader(dbiBytes);
  const module = parseModuleInfo(dbiBytes, dbi).find((entry) => (
    entry.streamIndex >= 0
    && entry.symbolByteSize > 8
    && msf.streams[entry.streamIndex]?.size > 64
  ));
  assert.ok(module, 'fixture must contain a module symbol stream');

  // Physical file range of the module stream's symbol area.
  const view = new DataView(original.buffer, original.byteOffset, original.byteLength);
  const blockSize = view.getUint32(32, true);
  const blockMapAddr = view.getUint32(52, true);
  const directoryBytes = view.getUint32(44, true);
  const directoryBlockCount = Math.ceil(directoryBytes / blockSize);
  const directory = new Uint8Array(directoryBytes);
  let written = 0;
  for (let index = 0; index < directoryBlockCount; index++) {
    const blockIndex = view.getUint32(blockMapAddr * blockSize + index * 4, true);
    const take = Math.min(blockSize, directoryBytes - written);
    directory.set(original.subarray(blockIndex * blockSize, blockIndex * blockSize + take), written);
    written += take;
  }
  const directoryView = new DataView(directory.buffer);
  const streamCount = directoryView.getUint32(0, true);
  // Skip the block lists of streams before the target to find its first block.
  const firstBlockOf = (streamIndex) => {
    let at = 4 + streamCount * 4;
    for (let index = 0; index < streamIndex; index++) {
      const size = directoryView.getUint32(4 + index * 4, true);
      at += Math.ceil((size === 0xffffffff ? 0 : size) / blockSize) * 4;
    }
    return directoryView.getUint32(at, true);
  };
  const streamBase = firstBlockOf(module.streamIndex) * blockSize;

  const patched = original.slice();
  const patchedView = new DataView(patched.buffer, patched.byteOffset, patched.byteLength);
  // Forged S_LPROC32 record right where line info would start: length 44 so
  // the NUL-terminated name "Evil" fits at record offset 39. It must never
  // surface when the symbol range is the empty [4, 4).
  const forged = new Uint8Array(46);
  const forgedView = new DataView(forged.buffer);
  forgedView.setUint16(0, 44, true); // length
  forgedView.setUint16(2, 0x110f, true); // S_LPROC32
  forged.set([0x45, 0x76, 0x69, 0x6c, 0x00], 39); // "Evil\0"
  patched.set(forged, streamBase + 4);
  const entryOffset = modInfoEntryOffset(dbiBytes, dbi, module.streamIndex, module.symbolByteSize);
  assert.notEqual(entryOffset, -1, 'the module entry must be locatable');
  // Rewrite SymByteSize inside the DBI stream bytes (entry offsets are
  // stream-relative; the stream starts at its first physical block).
  const dbiBase = firstBlockOf(3) * blockSize;
  patchedView.setUint32(dbiBase + entryOffset + 36, 4, true);

  const provider = new PdbDebugInfoProvider();
  const result = provider.probe({ ...pdbImage(variant), pdbBytes: patched });
  const evil = (result.parsed?.symbols?.symbols ?? []).filter((symbol) => symbol.name === 'Evil');
  assert.equal(evil.length, 0, 'line-info bytes must not parse as symbol records at SymByteSize 4');
});
