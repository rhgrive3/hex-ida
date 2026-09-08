import assert from 'node:assert/strict';
import { ByteView } from '../../../js/binary/reader.js';
import { parseExportTrie } from '../../../js/binary/macho-dyld.js';

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
  const imageBase = 0x100000000n;
  const image = {
    imageBase,
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

{
  const { image, status } = run([0x00, 0x20]);
  assert.equal(status.complete, true);
  assert.equal(image.exports.length, 1);
  assert.equal(image.exports[0].kind, 'export');
  assert.equal(image.exports[0].address, 0x100000020n);
  assert.equal(image.functions.length, 1);
}

{
  const { image, status } = run([0x01, 0x20]);
  assert.equal(status.complete, true);
  assert.equal(image.exports.length, 1);
  assert.equal(image.exports[0].kind, 'thread-local');
  assert.equal(image.exports[0].address, 0x20n);
}

{
  const { image, status } = run([0x02, 0x20]);
  assert.equal(status.complete, true);
  assert.equal(image.exports.length, 1);
  assert.equal(image.exports[0].kind, 'absolute');
  assert.equal(image.exports[0].address, 0x20n);
}

{
  const { image, status } = run([0x03, 0x20], 'bad');
  assert.equal(status.complete, false);
  assert.equal(image.exports.length, 0);
  assert.equal(image.functions.length, 0);
  assert.ok(image.warnings.some((warning) => warning.includes('unsupported export kind 3')));
}

// A reserved-kind terminal marks the trie partial but must not hide a valid
// child terminal reached through the same node.
{
  // root -a-> A(term [0x03,0x20], reserved) -b-> B(term [0x00,0x20], valid).
  const bytes = Uint8Array.from([
    0x00, 0x01, 0x61, 0x00, 0x05,
    0x02, 0x03, 0x20, 0x01, 0x62, 0x00, 0x0c,
    0x02, 0x00, 0x20, 0x00,
  ]);
  const imageBase = 0x100000000n;
  const image = {
    imageBase,
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
  assert.equal(status.complete, false);
  assert.equal(image.exports.length, 1);
  assert.equal(image.exports[0].name, 'ab');
  assert.equal(image.exports[0].kind, 'export');
  assert.equal(image.exports[0].address, 0x100000020n);
  assert.equal(image.functions.length, 1);
  assert.ok(image.warnings.some((warning) => warning.includes('unsupported export kind 3')));
}

{
  const { image, status } = run([0x08, 0x01, 0x00], 're');
  assert.equal(status.complete, true);
  assert.equal(image.exports.length, 1);
  assert.equal(image.exports[0].kind, 'reexport');
  assert.equal(image.exports[0].ordinal, 1);
  assert.equal(image.exports[0].imported, null);
}

{
  const { image, status } = run([0x10, 0x20, 0x30], 'stub');
  assert.equal(status.complete, true);
  assert.equal(image.exports.length, 1);
  assert.equal(image.exports[0].kind, 'export');
  assert.equal(image.exports[0].address, 0x100000020n);
  assert.equal(image.exports[0].resolver, 0x100000030n);
}

console.log('issue-3772-macho-export-trie-reserved-kind: PASS');
