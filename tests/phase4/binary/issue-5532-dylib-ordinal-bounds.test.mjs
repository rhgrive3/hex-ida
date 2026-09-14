import assert from 'node:assert/strict';
import { BinaryImage } from '../../../js/binary/model.js';
import { ByteView } from '../../../js/binary/reader.js';
import { parseExportTrie, parseChainedImports } from '../../../js/binary/macho-dyld.js';

// Issue #5532: positive library ordinals beyond the dependent-dylib count
// were silently published as canonical metadata — reexport trie terminals
// had no bounds check at all, and the chained-fixups import path mapped the
// failed dylibForOrdinal() lookup to a null-library canonical import. Apple
// dyld treats such ordinals as malformed bindings.

function mkImage(trie) {
  const image = new BinaryImage(trie, { format: 'macho', bits: 64, imageBase: 0x100000000n });
  image.addSegment({ name: '__TEXT', address: 0x100000000n, size: 0x1000n, fileOffset: 0n, fileSize: 0x1000n, perms: { read: true, execute: true } });
  image.libraries = ['libA.dylib'];
  return image;
}

// Exports-trie reexport: out-of-range ordinal rejected, trie partial.
{
  const raw = Uint8Array.from([0x00, 0x01, 0x5f, 0x78, 0x00, 0x06, 0x04, 0x08, 0x05, 0x79, 0x00, 0x00]);
  const image = mkImage(raw);
  const status = parseExportTrie(new ByteView(raw, { littleEndian: true }), { offset: 0, size: raw.length }, image);
  assert.equal(status.complete, false);
  assert.equal(image.exports.length, 0, 'an out-of-range reexport ordinal must not become export metadata');
  assert.ok(image.warnings.some((w) => w.includes('reexport ordinal 5 exceeds dependency count 1')));
}

// In-range reexport ordinals keep working (control).
{
  const raw = Uint8Array.from([0x00, 0x01, 0x5f, 0x78, 0x00, 0x06, 0x04, 0x08, 0x01, 0x79, 0x00, 0x00]);
  const image = mkImage(raw);
  const status = parseExportTrie(new ByteView(raw, { littleEndian: true }), { offset: 0, size: raw.length }, image);
  assert.equal(status.complete, true);
  assert.equal(image.exports.length, 1);
  assert.equal(image.exports[0].ordinal, 1);
  assert.equal(image.exports[0].imported, 'y');
}

// Chained-fixups imports: out-of-range ordinal rejected, imports partial.
{
  const bytes = new Uint8Array(0x100);
  const dv = new DataView(bytes.buffer);
  dv.setUint32(0, 0, true);
  dv.setUint32(4, 0, true);
  dv.setUint32(8, 28, true);  // imports_offset
  dv.setUint32(12, 36, true); // symbols_offset
  dv.setUint32(16, 1, true);  // imports_count
  dv.setUint32(20, 2, true);  // imports_format 2 (dyld_chained_import_addend)
  dv.setUint32(24, 0, true);  // symbols_format 0
  dv.setUint32(28, (8 << 9) | 5, true); // name offset 8, lib ordinal 5 (> 1)
  dv.setInt32(32, 0, true);
  bytes.set([0x78, 0x00], 44);
  const image = mkImage(bytes);
  parseChainedImports(new ByteView(bytes, { littleEndian: true }), { offset: 0, size: 64 }, image);
  assert.equal(image.imports.length, 0, 'an out-of-range chained ordinal must not become import metadata');
  const meta = image.metadata.chainedFixups;
  assert.equal(meta.complete, false);
  assert.equal(meta.importsComplete, false);
  assert.equal(meta.importsPartialReason, 'dylib-ordinal-out-of-range');
  assert.ok(image.warnings.some((w) => w.includes('import ordinal 5 exceeds dependency count 1')));
}

// In-range chained ordinals keep working (control).
{
  const bytes = new Uint8Array(0x100);
  const dv = new DataView(bytes.buffer);
  dv.setUint32(0, 0, true);
  dv.setUint32(4, 0, true);
  dv.setUint32(8, 28, true);
  dv.setUint32(12, 36, true);
  dv.setUint32(16, 1, true);
  dv.setUint32(20, 2, true);
  dv.setUint32(24, 0, true);
  dv.setUint32(28, (8 << 9) | 1, true); // lib ordinal 1 (in range)
  dv.setInt32(32, 0, true);
  bytes.set([0x78, 0x00], 44);
  const image = mkImage(bytes);
  parseChainedImports(new ByteView(bytes, { littleEndian: true }), { offset: 0, size: 64 }, image);
  assert.equal(image.imports.length, 1);
  assert.equal(image.imports[0].library, 'libA.dylib');
  assert.equal(image.metadata.chainedFixups.complete, true);
}

console.log('issue #5532 positive dylib ordinal bounds regression: PASS');
