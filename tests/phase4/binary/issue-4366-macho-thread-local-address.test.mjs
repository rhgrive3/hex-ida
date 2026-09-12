import assert from 'node:assert/strict';
import { ByteView } from '../../../js/binary/reader.js';
import { parseExportTrie } from '../../../js/binary/macho-dyld.js';

const imageBase = 0x100000000n;

function singleTerminalTrie(name, payload) {
  const edge = new TextEncoder().encode(name);
  const childOffset = 4 + edge.length;
  assert.ok(childOffset < 0x80 && payload.length < 0x80);
  return Uint8Array.from([
    0x00, 0x01,
    ...edge, 0x00,
    childOffset,
    payload.length,
    ...payload,
    0x00,
  ]);
}

function run(payload, name = '_x') {
  const bytes = singleTerminalTrie(name, payload);
  const image = {
    imageBase,
    libraries: ['libA.dylib'],
    exports: [],
    functions: [],
    metadata: {},
    warnings: [],
    sectionAt(address) {
      return address >= imageBase && address < imageBase + 0x1000n
        ? { perms: { execute: true } }
        : null;
    },
  };
  const status = parseExportTrie(
    new ByteView(bytes),
    { offset: 0, size: bytes.length },
    image,
  );
  return { image, status };
}

// A regular export and a thread-local export both encode an implementation
// offset relative to the image. Only ABSOLUTE keeps the raw terminal value.
{
  const { image, status } = run([0x00, 0x20], '_regular');
  assert.equal(status.complete, true);
  assert.equal(image.exports[0].kind, 'export');
  assert.equal(image.exports[0].address, imageBase + 0x20n);
  assert.equal(image.functions.length, 1);
}

{
  const { image, status } = run([0x01, 0x20], '_tls');
  assert.equal(status.complete, true);
  assert.equal(image.exports[0].kind, 'thread-local');
  assert.equal(image.exports[0].address, imageBase + 0x20n);
  assert.equal(image.sectionAt(image.exports[0].address)?.perms.execute, true);
  assert.equal(image.functions.length, 0, 'TLS exports are not regular function seeds');
}

{
  const { image, status } = run([0x02, 0x20], '_absolute');
  assert.equal(status.complete, true);
  assert.equal(image.exports[0].kind, 'absolute');
  assert.equal(image.exports[0].address, 0x20n);
  assert.equal(image.functions.length, 0);
}

// Re-export decoding remains ordinal/import-name based and does not acquire an
// image-base adjustment as a side effect of the local export address fix.
{
  const { image, status } = run([0x08, 0x01, 0x00], '_reexport');
  assert.equal(status.complete, true);
  assert.deepEqual(image.exports[0], {
    name: '_reexport',
    address: 0n,
    kind: 'reexport',
    flags: 0x08,
    ordinal: 1,
    imported: null,
    source: 'exports-trie',
  });
  assert.equal(image.functions.length, 0);
}

console.log('issue-4366 Mach-O THREAD_LOCAL export address regression: PASS');
