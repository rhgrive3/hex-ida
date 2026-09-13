import assert from 'node:assert/strict';
import { BinaryImage } from '../../../js/binary/model.js';
import { ByteView } from '../../../js/binary/reader.js';
import { parseExportTrie } from '../../../js/binary/macho-dyld.js';

// Issue #8072: a REGULAR exports-trie terminal was promoted to an exact
// `source:export` function seed from executable VM membership alone. Mach-O
// executable mappings can end in loader zero-fill, so export metadata may be
// valid at such an address without there being any static instruction byte.

function uleb(value) {
  let v = BigInt(value);
  const out = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return out;
}

function terminalTrie(name, flags, value) {
  const edge = [...new TextEncoder().encode(name), 0];
  const payload = [...uleb(flags), ...uleb(value)];
  const childOffset = 2 + edge.length + 1;
  return Uint8Array.from([
    0x00, 0x01,
    ...edge,
    childOffset,
    payload.length,
    ...payload,
    0x00,
  ]);
}

function run({
  name = '_f',
  flags = 0n,
  implementationOffset,
  sectionAddress,
  sectionSize = 0x100n,
  sectionFileOffset,
  sectionFileSize,
  execute = true,
}) {
  const imageBase = 0x100000000n;
  const trie = terminalTrie(name, flags, implementationOffset);
  const bytes = new Uint8Array(0x800);
  bytes.set(trie, 0);
  const image = new BinaryImage(bytes, {
    format: 'macho',
    arch: 'x86_64',
    bits: 64,
    imageBase,
  });
  image.addSegment({
    name: '__TEXT',
    address: imageBase,
    size: 0x1000n,
    fileOffset: 0n,
    fileSize: 0x600n,
    perms: { read: true, execute: true },
    source: 'LC_SEGMENT_64',
  });
  image.addSection({
    name: '__text',
    segment: '__TEXT',
    address: sectionAddress,
    size: sectionSize,
    fileOffset: sectionFileOffset,
    fileSize: sectionFileSize,
    perms: { read: true, execute },
    source: 'Mach-O-section',
  });
  const status = parseExportTrie(
    new ByteView(bytes, { littleEndian: true }),
    { offset: 0, size: trie.length },
    image,
  );
  return { image, status };
}

const imageBase = 0x100000000n;

// File-backed executable REGULAR export remains exact function-start evidence.
{
  const target = imageBase + 0x100n;
  const { image, status } = run({
    implementationOffset: 0x100n,
    sectionAddress: target,
    sectionFileOffset: 0x100n,
    sectionFileSize: 0x80n,
  });
  assert.equal(status.complete, true);
  assert.equal(image.addressToOffset(target), 0x100n);
  assert.equal(image.exports.length, 1);
  assert.equal(image.functions.length, 1);
  assert.equal(image.functions[0].source, 'export');
  assert.equal(image.functions[0].address, target);
  assert.equal(image.functions[0].exactFunctionStartConfidence, 0.9);
}

// The first byte after a section's file-backed extent is zero-fill. Preserve
// the export itself, but never turn it into authoritative static code evidence.
{
  const target = imageBase + 0x180n;
  const { image, status } = run({
    implementationOffset: 0x180n,
    sectionAddress: imageBase + 0x100n,
    sectionSize: 0x180n,
    sectionFileOffset: 0x100n,
    sectionFileSize: 0x80n,
  });
  assert.equal(status.complete, true, 'zero-fill does not make a valid export trie partial');
  assert.equal(image.addressToOffset(target), null);
  assert.equal(image.resolveVirtualMapping(target)?.kind, 'zero');
  assert.equal(image.exports.length, 1, 'the valid export record is retained');
  assert.equal(image.exports[0].address, target);
  assert.deepEqual(image.functions.filter((f) => f.source === 'export'), [],
    'a zero-fill export must not mint exact function-start evidence');
  assert.deepEqual(image.warnings, [], 'seed suppression alone is not malformed export metadata');
}

// An entirely zero-fill executable section has the same no-static-bytes rule.
{
  const target = imageBase + 0x400n;
  const { image, status } = run({
    implementationOffset: 0x400n,
    sectionAddress: target,
    sectionFileOffset: 0x400n,
    sectionFileSize: 0n,
  });
  assert.equal(status.complete, true);
  assert.equal(image.addressToOffset(target), null);
  assert.equal(image.exports.length, 1);
  assert.equal(image.functions.length, 0);
}

// Existing executable-section gate is preserved for file-backed data.
{
  const target = imageBase + 0x300n;
  const { image } = run({
    implementationOffset: 0x300n,
    sectionAddress: target,
    sectionFileOffset: 0x300n,
    sectionFileSize: 0x80n,
    execute: false,
  });
  assert.equal(image.addressToOffset(target), 0x300n);
  assert.equal(image.exports.length, 1);
  assert.equal(image.functions.length, 0);
}

// Non-REGULAR terminal kinds never become `source:export` function seeds even
// when their value lands in executable, file-backed bytes.
for (const [flags, kind] of [[1n, 'thread-local'], [2n, 'absolute']]) {
  const target = imageBase + 0x200n;
  const value = flags === 2n ? target : 0x200n;
  const { image, status } = run({
    flags,
    implementationOffset: value,
    sectionAddress: target,
    sectionFileOffset: 0x200n,
    sectionFileSize: 0x80n,
  });
  assert.equal(status.complete, true);
  assert.equal(image.exports[0].kind, kind);
  assert.equal(image.functions.length, 0);
}

console.log('issue-8072 export-trie function seeds require file-backed bytes: ok');
