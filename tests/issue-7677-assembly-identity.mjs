import assert from 'node:assert/strict';
import { parseCil, probeCil } from '../js/managed/cil/parser.js';
import { overlayCilMetadata } from '../js/managed/cil/parser-overlay.js';
import { parseCil as parseCilBase } from '../js/managed/cil/parser-base.js';
import { buildCil } from './phase11/fixtures/medium-cil.mjs';

// #7677 — the manifest Assembly (0x20) row is the defining assembly's identity
// authority (ECMA-335 II.22.2). Name / version / culture / flags / HashAlgId /
// PublicKey must survive losslessly into the canonical image, two binaries
// differing only in the Assembly row must not collapse to one identity, and
// invalid rows fail closed.

const utf8 = s => new TextEncoder().encode(s);

// Resolve a string's #Strings index by scanning the built fixture heap, so
// indexes stay correct regardless of which leading strings were reserved.
function stringIndex(data, name) {
  const stream = data.layout.streams.find(s => s.name === '#Strings');
  const heap = data.bytes.subarray(stream.offset, stream.offset + stream.size);
  const needle = utf8(name);
  outer: for (let i = 1; i < heap.length - needle.length; i++) {
    if (heap[i - 1] !== 0) continue; // a string starts after a NUL
    for (let j = 0; j < needle.length; j++) {
      if (heap[i + j] !== needle[j]) continue outer;
    }
    if (heap[i + needle.length] === 0) return i;
  }
  throw new Error(`string ${JSON.stringify(name)} not found in #Strings heap`);
}

function assemblyRow({ nameIndex, cultureIndex = 0, publicKeyIndex = 0, majorVersion = 1, flags = 0 } = {}) {
  const row = new Uint8Array(22); // 4 (HashAlgId) + 2*4 (versions) + 4 (Flags) + b + s*2 at heapSizes 0
  const v = new DataView(row.buffer);
  v.setUint32(0, 0x00008004, true); // HashAlgId: SHA1
  v.setUint16(4, majorVersion, true);
  v.setUint16(6, 0, true); // Minor
  v.setUint16(8, 0, true); // Build
  v.setUint16(10, 0, true); // Revision
  v.setUint32(12, flags, true);
  v.setUint16(16, publicKeyIndex, true);
  v.setUint16(18, nameIndex, true);
  v.setUint16(20, cultureIndex, true);
  return row;
}

function fixtureData(options = {}) {
  const data = buildCil({
    leadingStrings: options.leadingStrings ?? [],
    extraRows: new Map([[0x20, { count: 1, bytes: assemblyRow(options) }]]),
    ...(options.blobBytes ? { blobBytes: options.blobBytes } : {}),
  });
  return { ...data, index: name => stringIndex(data, name) };
}
const fixture = options => fixtureData(options).bytes;

// 1. Two fixtures differing only in Assembly.Name must not collapse.
const dataA = fixtureData({ nameIndex: fixtureData().index('Run') });
const dataB = fixtureData({ nameIndex: fixtureData().index('Widget') });
assert.equal(probeCil(dataA.bytes).supported, true);
assert.equal(probeCil(dataB.bytes).supported, true);
const a = parseCil(dataA.bytes, { binaryId: 'same' });
const b = parseCil(dataB.bytes, { binaryId: 'same' });
assert.notDeepEqual(a.assembly, b.assembly);
assert.equal(a.assembly.name, 'Run');
assert.equal(b.assembly.name, 'Widget');

// 2. Lossless authority: every row field is preserved on the image.
const keyData = fixtureData({ nameIndex: dataA.index('Run'), publicKeyIndex: 1, flags: 0x1,
  blobBytes: Uint8Array.of(0, 0x04, 0xde, 0xad, 0xbe, 0xef, 0, 0) });
const withKey = parseCil(keyData.bytes, { binaryId: 'same' });
assert.deepEqual(withKey.assembly, {
  rid: 1, token: '0x20000001',
  hashAlgId: 0x00008004, majorVersion: 1, minorVersion: 0,
  buildNumber: 0, revisionNumber: 0, flags: 0x1,
  publicKeyBlobIndex: 1, publicKey: Uint8Array.of(0xde, 0xad, 0xbe, 0xef),
  name: 'Run', culture: null,
});

// 3. Version / culture / key differences each stay visible as identity.
const enUSData = fixtureData({ leadingStrings: ['en-US', 'fr-FR'] });
const enUS = enUSData.index('en-US');
const frFR = enUSData.index('fr-FR');
assert.equal(parseCil(fixture({ nameIndex: dataA.index('Run'), majorVersion: 2 }), { binaryId: 'same' }).assembly.majorVersion, 2);
assert.equal(parseCil(fixture({ nameIndex: dataA.index('Run'), cultureIndex: enUS, leadingStrings: ['en-US'] }), { binaryId: 'same' }).assembly.culture, 'en-US');
const cultureA = parseCil(fixture({ nameIndex: dataA.index('Run'), cultureIndex: enUS, leadingStrings: ['en-US'] }), { binaryId: 'same' });
const cultureB = parseCil(fixture({ nameIndex: dataA.index('Run'), cultureIndex: frFR, leadingStrings: ['en-US', 'fr-FR'] }), { binaryId: 'same' });
assert.notDeepEqual(cultureA.assembly, cultureB.assembly);
const keyB = parseCil(fixture({ nameIndex: dataA.index('Run'), publicKeyIndex: 1,
  blobBytes: Uint8Array.of(0, 0x04, 0xca, 0xfe, 0xba, 0xbe, 0, 0) }), { binaryId: 'same' });
assert.deepEqual([...keyB.assembly.publicKey], [0xca, 0xfe, 0xba, 0xbe]);
assert.notDeepEqual(withKey.assembly, keyB.assembly);

// 4. Invalid rows fail closed: bad name/culture string index, bad PublicKey
// blob index, and a second Assembly row (II.22.2: at most one).
function overlayError(bytes) {
  try {
    overlayCilMetadata(bytes, parseCilBase(bytes, { binaryId: 'bad' }));
    return null;
  } catch (error) {
    return error.message;
  }
}
assert.equal(overlayError(fixture({ nameIndex: 999 })), 'cil-definition-string-index-invalid');
assert.equal(overlayError(fixture({ nameIndex: dataA.index('Run'), cultureIndex: 999 })), 'cil-definition-string-index-invalid');
assert.equal(overlayError(fixture({ nameIndex: dataA.index('Run'), publicKeyIndex: 9 })), 'cil-assembly-public-key-blob-invalid');
const twoRows = new Uint8Array(44);
twoRows.set(assemblyRow({ nameIndex: dataA.index('Run') }), 0);
twoRows.set(assemblyRow({ nameIndex: dataA.index('Widget') }), 22);
assert.equal(overlayError(buildCil({
  extraRows: new Map([[0x20, { count: 2, bytes: twoRows }]]),
}).bytes), 'cil-assembly-table-multi-row');
assert.throws(() => parseCil(fixture({ nameIndex: 999 }), { binaryId: 'bad' }),
  error => error instanceof TypeError && error.message === 'cil-unsupported-binary');

console.log('issue-7677 assembly identity regression: PASS');
