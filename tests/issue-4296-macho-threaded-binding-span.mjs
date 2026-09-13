// Issue #4296 regression: BIND_OPCODE_THREADED APPLY must prove the entire
// encoded 64-bit pointer word is file-backed by one canonical VM mapping.
import assert from 'node:assert/strict';
import { BinaryImage } from '../js/binary/model.js';
import { ByteView } from '../js/binary/reader.js';
import { parseClassicBindings } from '../js/binary/macho-dyld.js';

const VM = 0x1000n;
const FILE = 0x100n;

function threadedStream(offset = 0) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 0x7f) throw new Error('test offset must fit one ULEB byte');
  return Uint8Array.from([
    0x11,                               // SET_DYLIB_ORDINAL_IMM 1
    0x40, 0x5f, 0x66, 0x6f, 0x6f, 0, // SET_SYMBOL "_foo"
    0xd0, 0x01,                         // THREADED SET_BIND_ORDINAL_TABLE_SIZE_ULEB 1
    0x90,                               // DO_BIND -> ordinal-table template 0
    0x70, offset,                       // SET_SEGMENT_AND_OFFSET_ULEB seg 0
    0xd1,                               // THREADED APPLY
    0x00,                               // DONE
  ]);
}

function putU64(bytes, offset, value) {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setBigUint64(offset, BigInt(value), true);
}

function fixture({ fileSize, words, sections = [] }) {
  const bytes = new Uint8Array(0x200);
  const stream = threadedStream();
  bytes.set(stream, 0);
  for (const [offset, word] of words) putU64(bytes, Number(FILE) + offset, word);

  const image = new BinaryImage(bytes, { format: 'macho', arch: 'x86_64', bits: 64 });
  image.libraries.push('libA.dylib');
  image.addSegment({
    name: '__DATA',
    address: VM,
    size: 0x80n,
    fileOffset: FILE,
    fileSize: BigInt(fileSize),
    perms: { read: true, write: true, execute: false },
    source: 'LC_SEGMENT_64',
  });
  for (const section of sections) {
    image.addSection({
      segment: '__DATA',
      perms: { read: true, write: true, execute: false },
      source: 'Mach-O-section',
      ...section,
    });
  }

  const status = parseClassicBindings(
    new ByteView(bytes),
    { offset: 0, size: stream.length },
    image,
    image.segments,
    'bind',
  );
  return { image, status };
}

// Control: all 8 bytes of the encoded pointer are file-backed by the segment.
{
  const { image, status } = fixture({ fileSize: 8, words: [[0, 1n << 62n]] });
  assert.equal(status.complete, true);
  assert.equal(status.threadedApplies, 1);
  assert.equal(image.imports.length, 1);
  assert.equal(image.imports[0].sites[0].address, VM);
  assert.equal(image.imports[0].sites[0].offset, FILE);
  assert.equal(image.imports[0].sites[0].kind, 'threaded-bind');
}

// Minimal counterexample: only the first 4 bytes belong to the segment. The
// next 4 raw file bytes encode the bind bit but are VM zero-fill, so they must
// never be concatenated into a threaded pointer word.
{
  const { image, status } = fixture({ fileSize: 4, words: [[0, 1n << 62n]] });
  assert.equal(status.complete, false, 'partial file backing must make threaded binding partial');
  assert.equal(status.threadedApplies, 0);
  assert.equal(image.imports.length, 0, 'unproven pointer bytes must not mint a bind/import');
  assert.ok(image.warnings.some((x) => x.includes('threaded binding chain leaves mapped file data')));
}

// The full-span proof is required after every delta too. The first word is
// valid and advances by one 8-byte stride; the second has only 4 backed bytes.
{
  const { image, status } = fixture({
    fileSize: 12,
    words: [
      [0, 1n << 51n], // delta = 1, not a bind
      [8, 1n << 62n], // bind bit lives in the unbacked upper half
    ],
  });
  assert.equal(status.complete, false);
  assert.equal(image.imports.length, 0, 'delta-followed partial word must not publish a bind');
}

// A narrower canonical section owns the address. Even though the parent
// segment has 8 backed bytes, only 4 bytes are file-backed by the winning
// mapping, so raw bytes beyond that section cannot complete the word.
{
  const { image, status } = fixture({
    fileSize: 0x40,
    words: [[0, 1n << 62n]],
    sections: [{
      name: '__slot', address: VM, size: 0x10n,
      fileOffset: FILE, fileSize: 4n,
    }],
  });
  assert.equal(status.complete, false);
  assert.equal(image.imports.length, 0, 'a zero-fill tail in the canonical section must reject the word');
}

// A narrower mapping can interrupt only the middle of a word while both
// endpoints still resolve through the parent segment. The full span, not just
// its endpoints, must remain file-backed by one canonical owner.
{
  const { image, status } = fixture({
    fileSize: 0x40,
    words: [[0, 1n << 62n]],
    sections: [{
      name: '__hole', address: VM + 3n, size: 1n,
      fileOffset: FILE + 3n, fileSize: 0n,
    }],
  });
  assert.equal(status.complete, false);
  assert.equal(image.imports.length, 0, 'an interior zero-fill mapping must reject the entire word');
}

// File-contiguous bytes owned by two distinct canonical mappings are not one
// encoded loader word. Do not join adjacent sections merely because offsets
// happen to be contiguous in the file.
{
  const { image, status } = fixture({
    fileSize: 0x40,
    words: [[0, 1n << 62n]],
    sections: [
      { name: '__left', address: VM, size: 4n, fileOffset: FILE, fileSize: 4n },
      { name: '__right', address: VM + 4n, size: 4n, fileOffset: FILE + 4n, fileSize: 4n },
    ],
  });
  assert.equal(status.complete, false);
  assert.equal(image.imports.length, 0, 'adjacent mappings must not be concatenated into a pointer word');
}

console.log('issue #4296 Mach-O threaded binding full-span regressions: PASS');
