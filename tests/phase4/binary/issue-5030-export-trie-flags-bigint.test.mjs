import assert from 'node:assert/strict';
import { BinaryImage } from '../../../js/binary/model.js';
import { ByteView } from '../../../js/binary/reader.js';
import { parseExportTrie } from '../../../js/binary/macho-dyld.js';

// Issue #5030: the exports-trie terminal flags ULEB128 was converted with
// Number() before any bit test. A value >= 2^53 rounds away the low
// REEXPORT (0x08) / STUB_AND_RESOLVER (0x10) bits and — worse — the high-bit
// guard (flags >>> 6) also lost the bits modulo 2^32, so a hostile terminal
// was mis-decoded as a regular export with complete:true and no warning.
// Flag bits must be tested on the exact BigInt before any Number conversion.

function uleb(v) {
  v = BigInt(v);
  const out = [];
  do { let b = Number(v & 0x7fn); v >>= 7n; if (v) b |= 0x80; out.push(b); } while (v);
  return out;
}

function run(trie) {
  const image = new BinaryImage(trie, { format: 'macho', bits: 64, imageBase: 0x1000n });
  image.addSegment({ name: '__TEXT', address: 0x1000n, size: 0x1000n, fileOffset: 0n, fileSize: 0x1000n, perms: { read: true, execute: true } });
  const r = new ByteView(trie, { littleEndian: true });
  const status = parseExportTrie(r, { offset: 0, size: trie.length }, image);
  return { status, exports: image.exports, functions: image.functions, warnings: image.warnings };
}

// (1n << 60n) | 0x08n: REEXPORT layout by exact bits, but Number() rounds the
// 0x08 bit away and the old guard never fires.
{
  const flags = (1n << 60n) | 0x08n;
  const terminal = [...uleb(flags), ...uleb(1n), ...new TextEncoder().encode('foo\0')];
  const trie = Uint8Array.from([...uleb(BigInt(terminal.length)), ...terminal, 0]);
  const { status, exports, warnings } = run(trie);
  assert.equal(status.complete, false, 'rounded high flag bits must fail closed');
  assert.equal(exports.length, 0, 'the ordinal must not be mis-decoded as a regular export address');
  assert.ok(warnings.some((w) => w.includes('unknown exports flag bits 0x1000000000000008')), 'the diagnostic carries the exact BigInt flag value');
}

// (1n << 60n) | 0x10n: STUB_AND_RESOLVER bit must survive the guard too.
{
  const flags = (1n << 60n) | 0x10n;
  const terminal = [...uleb(flags), ...uleb(0x2000n), ...uleb(7n)];
  const trie = Uint8Array.from([...uleb(BigInt(terminal.length)), ...terminal, 0]);
  const { status, exports } = run(trie);
  assert.equal(status.complete, false, 'stub-and-resolver bit above 2^53 must fail closed');
  assert.equal(exports.length, 0, 'no export may be minted from a reserved-flag terminal');
}

// Legal in-range flags keep decoding exactly (REEXPORT control).
{
  const terminal = [...uleb(0x08n), ...uleb(1n), ...new TextEncoder().encode('foo\0')];
  const trie = Uint8Array.from([...uleb(BigInt(terminal.length)), ...terminal, 0]);
  const image = new BinaryImage(trie, { format: 'macho', bits: 64, imageBase: 0x1000n });
  image.libraries = ['libA.dylib'];
  const r = new ByteView(trie, { littleEndian: true });
  const status = parseExportTrie(r, { offset: 0, size: trie.length }, image);
  assert.equal(status.complete, true);
  assert.equal(image.exports.length, 1);
  assert.equal(image.exports[0].kind, 'reexport');
  assert.equal(image.exports[0].imported, 'foo');
}

console.log('issue-5030 exports-trie flags exact BigInt contract: ok');
