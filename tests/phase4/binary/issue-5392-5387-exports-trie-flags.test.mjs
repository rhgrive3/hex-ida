import assert from 'node:assert/strict';
import { BinaryImage } from '../../../js/binary/model.js';
import { ByteView } from '../../../js/binary/reader.js';
import { parseExportTrie } from '../../../js/binary/macho-dyld.js';

// Issues #5392 + #5387: the exports-trie terminal grammar accepted undefined
// high flag bits and silently downgraded FUNCTION_VARIANT terminals to
// regular exports. Apple dyld's ExportsTrie.cpp rejects (flags >> 6) != 0 and
// decodes 0x20 as a function-variant payload carrying a variant table index.

function run(trie) {
  const image = new BinaryImage(trie, { format: 'macho', bits: 64, imageBase: 0x100000000n });
  image.addSegment({ name: '__TEXT', address: 0x100000000n, size: 0x1000n, fileOffset: 0n, fileSize: 0x1000n, perms: { read: true, execute: true } });
  // #5532: positive reexport ordinals are bounded by the dependency count,
  // so declare enough dylibs for the fixtures that use them.
  image.libraries = ['libA.dylib', 'libB.dylib', 'libC.dylib', 'libD.dylib', 'libE.dylib'];
  const r = new ByteView(trie, { littleEndian: true });
  const status = parseExportTrie(r, { offset: 0, size: trie.length }, image);
  return { status, exports: image.exports, functions: image.functions, warnings: image.warnings };
}

// --- #5392: unknown high flag bits fail closed ---------------------------
for (const flags of [0x40, 0x80, 0xc0, 0xff]) {
  const { status, exports, warnings } = run(Uint8Array.from([0x00, 0x01, 0x5f, 0x78, 0x00, 0x06, 0x02, flags, 0x10, 0x00]));
  assert.equal(status.complete, false, `flags 0x${flags.toString(16)} must mark the trie partial`);
  assert.equal(exports.length, 0, `flags 0x${flags.toString(16)} must not mint an export`);
  assert.ok(warnings.some((warning) => warning.includes('unknown exports flag bits')), `flags 0x${flags.toString(16)} records the dyld-compatible diagnostic`);
}

// Known flag domains keep parsing.
{
  const regular = run(Uint8Array.from([0x00, 0x01, 0x5f, 0x78, 0x00, 0x06, 0x02, 0x00, 0x10, 0x00]));
  assert.equal(regular.status.complete, true);
  assert.deepEqual(regular.exports.map((e) => ({ kind: e.kind, flags: e.flags })), [{ kind: 'export', flags: 0 }]);
  assert.equal(regular.functions.length, 1, 'executable regular exports still seed functions');

  const weak = run(Uint8Array.from([0x00, 0x01, 0x5f, 0x78, 0x00, 0x06, 0x03, 0x10, 0x10, 0x20, 0x00]));
  assert.equal(weak.status.complete, true, 'stub/resolver flag (0x10) stays valid');
  assert.equal(weak.exports[0].flags, 0x10);

  const tlv = run(Uint8Array.from([0x00, 0x01, 0x5f, 0x78, 0x00, 0x06, 0x02, 0x01, 0x10, 0x00]));
  assert.equal(tlv.status.complete, true);
  assert.equal(tlv.exports[0].kind, 'thread-local');

  const absolute = run(Uint8Array.from([0x00, 0x01, 0x5f, 0x78, 0x00, 0x06, 0x02, 0x02, 0x10, 0x00]));
  assert.equal(absolute.status.complete, true);
  assert.equal(absolute.exports[0].kind, 'absolute');

  const reexport = run(Uint8Array.from([0x00, 0x01, 0x5f, 0x78, 0x00, 0x06, 0x04, 0x08, 0x05, 0x79, 0x00, 0x00]));
  assert.equal(reexport.status.complete, true);
  assert.equal(reexport.exports[0].kind, 'reexport');
  assert.equal(reexport.exports[0].ordinal, 5);
  assert.equal(reexport.exports[0].imported, 'y');
}

// --- #5387: FUNCTION_VARIANT terminals carry typed provenance ------------
{
  const { status, exports, warnings } = run(Uint8Array.from([0x00, 0x01, 0x5f, 0x76, 0x00, 0x06, 0x03, 0x20, 0x10, 0x02, 0x00]));
  assert.equal(exports.length, 1);
  const variant = exports[0];
  assert.equal(variant.kind, 'function-variant', 'the terminal is not downgraded to a regular export');
  assert.equal(variant.flags, 0x20);
  assert.equal(variant.address, null, 'no exact address is claimed for an unresolved variant');
  assert.equal(variant.defaultImplementationOffset, 0x10n, 'the default implementation offset is preserved');
  assert.equal(variant.variantTableIndex, 2, 'the variant table index is decoded');
  assert.equal(status.complete, false, 'the trie stays partial until variant tables are modeled');
  assert.ok(warnings.some((warning) => warning.includes('function-variant')));
}

// Truncated variant table index fails closed.
{
  const { status, exports } = run(Uint8Array.from([0x00, 0x01, 0x5f, 0x76, 0x00, 0x06, 0x02, 0x20, 0x10]));
  assert.equal(status.complete, false, 'missing table index keeps the trie partial');
  assert.equal(exports.length, 0);
}

// A function-variant terminal never mints a function seed.
{
  const { functions } = run(Uint8Array.from([0x00, 0x01, 0x5f, 0x76, 0x00, 0x06, 0x03, 0x20, 0x10, 0x02, 0x00]));
  assert.equal(functions.length, 0, 'no executable-seed fabrication from variant offsets');
}

console.log('issues #5392 + #5387 exports-trie terminal grammar regression: PASS');
