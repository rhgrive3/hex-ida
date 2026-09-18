import assert from 'node:assert/strict';
import { parseCil, probeCil } from '../../../js/managed/cil/parser.js';
import { overlayCilMetadata } from '../../../js/managed/cil/parser-overlay.js';
import { parseCil as parseCilBase } from '../../../js/managed/cil/parser-base.js';
import { buildCil } from '../fixtures/medium-cil.mjs';

// #7677 — the Assembly (0x20) row is the manifest assembly's identity
// authority (ECMA-335 II.22.2, at most one row). Two binaries differing only
// in the Assembly row must no longer collapse to identical canonical state,
// and unknown flag/key encodings keep their raw values (no fabrication).

function assemblyRow({ nameIndex, publicKeyIndex = 0, majorVersion = 1 } = {}) {
  const row = new Uint8Array(22); // 16 + b(2) + s(2) * 2 at heapSizes 0
  const v = new DataView(row.buffer);
  v.setUint32(0, 0x00008004, true); // HashAlgId: SHA1
  v.setUint16(4, majorVersion, true);
  v.setUint16(6, 0, true); // Minor
  v.setUint16(8, 0, true); // Build
  v.setUint16(10, 0, true); // Revision
  v.setUint32(12, 0, true); // Flags
  v.setUint16(16, publicKeyIndex, true);
  v.setUint16(18, nameIndex, true);
  v.setUint16(20, 0, true); // Culture
  return row;
}

function fixture(row, blobBytes) {
  return buildCil({
    extraRows: new Map([[0x20, { count: 1, bytes: row }]]),
    blobBytes,
  }).bytes;
}

const withName1 = fixture(assemblyRow({ nameIndex: 1 })); // "Run"
const withName2 = fixture(assemblyRow({ nameIndex: 5 })); // "Widget"

assert.equal(probeCil(withName1).supported, true);
assert.equal(probeCil(withName2).supported, true);

const a = parseCil(withName1, { binaryId: 'same' });
const b = parseCil(withName2, { binaryId: 'same' });

// Distinct assembly identities must not collapse to one canonical image.
assert.notDeepEqual(a.assembly, b.assembly);
assert.equal(a.assembly.name, 'Run');
assert.equal(b.assembly.name, 'Widget');
// Lossless authority: every row field is preserved.
assert.deepEqual(a.assembly, {
  rid: 1, token: '0x20000001',
  hashAlgId: 0x00008004, majorVersion: 1, minorVersion: 0,
  buildNumber: 0, revisionNumber: 0, flags: 0,
  publicKeyBlobIndex: 0, publicKey: null,
  name: 'Run', culture: null,
});
// Version-only difference stays visible as well.
const withMajor2 = parseCil(fixture(assemblyRow({ nameIndex: 1, majorVersion: 2 })), { binaryId: 'same' });
assert.equal(withMajor2.assembly.majorVersion, 2);
assert.notDeepEqual(a.assembly, withMajor2.assembly);

// PublicKey: raw blob bytes are kept as authority (no key decoding).
// (#Blob stream sizes are 4-byte aligned per II.24.2.2.)
const publicKeyFixture = fixture(
  assemblyRow({ nameIndex: 1, publicKeyIndex: 1 }),
  Uint8Array.of(0, 0x04, 0xde, 0xad, 0xbe, 0xef, 0, 0),
);
const withKey = parseCil(publicKeyFixture, { binaryId: 'same' });
assert.equal(withKey.assembly.publicKeyBlobIndex, 1);
assert.deepEqual([...withKey.assembly.publicKey], [0xde, 0xad, 0xbe, 0xef]);

// ECMA-335 II.22.2: at most one Assembly row — fail closed. The overlay
// raises the precise code; parseCil surfaces it as an unsupported binary.
function overlayError(bytes) {
  try {
    overlayCilMetadata(bytes, parseCilBase(bytes, { binaryId: 'bad' }));
    return null;
  } catch (error) {
    return error.message;
  }
}
const twoRows = new Uint8Array(44);
twoRows.set(assemblyRow({ nameIndex: 1 }), 0);
twoRows.set(assemblyRow({ nameIndex: 5 }), 22);
assert.equal(overlayError(
  buildCil({ extraRows: new Map([[0x20, { count: 2, bytes: twoRows }]]) }).bytes,
), 'cil-assembly-table-multi-row');
// Name index beyond the #Strings heap fails closed.
assert.equal(overlayError(fixture(assemblyRow({ nameIndex: 999 }))), 'cil-definition-string-index-invalid');
// A PublicKey blob index with no #Blob heap fails closed.
const blobless = buildCil({
  extraRows: new Map([[0x20, { count: 1, bytes: assemblyRow({ nameIndex: 1, publicKeyIndex: 1 }) }]]),
  blobBytes: new Uint8Array(0),
}).bytes;
assert.equal(overlayError(blobless), 'cil-assembly-public-key-blob-missing');

console.log('cil assembly identity #7677: PASS');
