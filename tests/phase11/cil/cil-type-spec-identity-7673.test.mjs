import assert from 'node:assert/strict';
import { parseCil, probeCil } from '../../../js/managed/cil/parser.js';
import { overlayCilMetadata } from '../../../js/managed/cil/parser-overlay.js';
import { parseCil as parseCilBase } from '../../../js/managed/cil/parser-base.js';
import { CilFrontend } from '../../../js/managed/cil/frontend.js';
import { buildCil } from '../fixtures/medium-cil.mjs';

// #7673 — TypeSpec (0x1b) rows are the constructed-type authority: the
// Signature blob is decoded to an exact type specification, the raw blob
// bytes stay as authority, and TypeDefOrRef consumers resolve a TypeSpec
// extends token to the canonical row. Two binaries whose TypeSpec signatures
// differ only in a generic argument must no longer collapse to identical
// canonical state.

// #Blob heap: index 5 holds a 5-byte TypeSpec signature
// GENERICINST CLASS TypeDef#2 (N.Base`1) <arg>, where arg is I4 or I8.
function blobHeap(arg) {
  return Uint8Array.of(0, 1, 2, 3, 4, 0x05, 0x15, 0x12, 0x08, 0x01, arg, 0);
}

function fixture(arg) {
  const typeSpecs = new Uint8Array(2); // 1 row: Signature = #Blob index 5
  new DataView(typeSpecs.buffer).setUint16(0, 5, true);
  return buildCil({
    types: [
      { name: 'Object', namespace: 'System', methodList: 1, fieldList: 1, extends: 0 },
      { name: 'Base`1', namespace: 'N', methodList: 1, fieldList: 1, extends: 4 },
      { name: 'Derived', namespace: 'N', methodList: 1, fieldList: 1, extends: 6 }, // TypeDefOrRef: TypeSpec #1
    ],
    extraRows: new Map([[0x1b, { count: 1, bytes: typeSpecs }]]),
    blobBytes: blobHeap(arg),
  }).bytes;
}

const i4 = fixture(0x08); // N.Base<int32>
const i8 = fixture(0x0a); // N.Base<int64>

assert.equal(probeCil(i4).supported, true, JSON.stringify(probeCil(i4)));
assert.equal(probeCil(i8).supported, true, JSON.stringify(probeCil(i8)));

const a = parseCil(i4, { binaryId: 'same' });
const b = parseCil(i8, { binaryId: 'same' });

// The canonical image carries the TypeSpec authority rows.
assert.equal(a.typeSpecs.length, 1);
assert.equal(a.typeSpecs[0].token, '0x1b000001');
assert.equal(a.typeSpecs[0].signatureBlobIndex, 5);
assert.deepEqual([...a.typeSpecs[0].rawSignature], [0x15, 0x12, 0x08, 0x01, 0x08]);
// Exact decoded identity: GENERICINST CLASS base with distinct arguments.
assert.deepEqual(a.typeSpecs[0].signature, {
  stackType: 'object-ref', typeToken: 8,
  genericArgs: [{ stackType: 'int32', bits: 32 }],
});
assert.deepEqual(b.typeSpecs[0].signature, {
  stackType: 'object-ref', typeToken: 8,
  genericArgs: [{ stackType: 'int64', bits: 64 }],
});
// The decoded specifications are distinct as well.
assert.notDeepEqual(a.typeSpecs[0].signature, b.typeSpecs[0].signature);
// Raw bytes differ — the raw authority keeps the two distinct.
assert.notDeepEqual([...a.typeSpecs[0].rawSignature], [...b.typeSpecs[0].rawSignature]);
// The images are no longer identical through the whole type projection.
assert.notDeepEqual(a.types, b.types);
assert.equal(a.types[2].extendsToken, '0x1b000001');

// TypeDefOrRef consumer resolution: extendsToken resolves to the canonical
// TypeSpec row authority on both images.
assert.equal(a.types[2].extendsTypeSpec, a.typeSpecs[0]);
assert.equal(b.types[2].extendsTypeSpec, b.typeSpecs[0]);

// Frontend enumeration surfaces the resolved authority too.
const frontend = new CilFrontend();
const enumerated = [];
for await (const type of frontend.enumerateTypes(a)) enumerated.push(type);
const derived = enumerated.find((type) => type.name === 'Derived');
assert.ok(derived, 'Derived enumerated');
assert.equal(derived.extendsTypeSpec.token, '0x1b000001');
assert.deepEqual(derived.extendsTypeSpec.signature, {
  stackType: 'object-ref', typeToken: 8,
  genericArgs: [{ stackType: 'int32', bits: 32 }],
});

// Fail-closed structural cases. The overlay raises the precise fail-closed
// code; parseCil surfaces it as an unsupported binary through the probe.
function overlayError(bytes) {
  try {
    overlayCilMetadata(bytes, parseCilBase(bytes, { binaryId: 'bad' }));
    return null;
  } catch (error) {
    return error.message;
  }
}
// TypeSpec row referencing a blob index beyond the #Blob heap.
const badIndex = buildCil({
  types: [{ name: 'Derived', methodList: 1, fieldList: 1, extends: 6 }],
  extraRows: new Map([[0x1b, { count: 1, bytes: Uint8Array.of(200, 0) }]]),
  blobBytes: blobHeap(0x08),
}).bytes;
assert.equal(overlayError(badIndex), 'cil-type-spec-blob-index-invalid');
assert.throws(() => parseCil(badIndex, { binaryId: 'bad' }), /cil-unsupported-binary/);
// TypeSpec table with no #Blob heap at all.
const noHeap = buildCil({
  types: [{ name: 'Derived', methodList: 1, fieldList: 1, extends: 6 }],
  extraRows: new Map([[0x1b, { count: 1, bytes: Uint8Array.of(1, 0) }]]),
  blobBytes: new Uint8Array(0),
}).bytes;
assert.equal(overlayError(noHeap), 'cil-type-spec-blob-missing');
// Unrepresentable grammar keeps the raw blob authority (signature null) and
// the rows stay distinct — it does not collapse into one opaque token.
function unrepresentableFixture(payload) {
  const blob = Uint8Array.of(0, 1, 2, 3, 4, payload.length, ...payload, 0);
  const typeSpecs = new Uint8Array(2);
  new DataView(typeSpecs.buffer).setUint16(0, 5, true);
  return buildCil({
    types: [{ name: 'Derived', methodList: 1, fieldList: 1, extends: 6 }],
    extraRows: new Map([[0x1b, { count: 1, bytes: typeSpecs }]]),
    blobBytes: blob,
  }).bytes;
}
const weirdA = parseCil(unrepresentableFixture([0x45]), { binaryId: 'weird' }); // 0x45 is not a Type element
const weirdB = parseCil(unrepresentableFixture([0x46]), { binaryId: 'weird' });
assert.equal(weirdA.typeSpecs[0].signature, null);
assert.equal(weirdB.typeSpecs[0].signature, null);
assert.notDeepEqual([...weirdA.typeSpecs[0].rawSignature], [...weirdB.typeSpecs[0].rawSignature]);
assert.notDeepEqual(weirdA.types, weirdB.types);

// Representative grammar identity (R2): PTR pointee, SZARRAY/ARRAY shape +
// element, FNPTR nested signature, and custom modifiers are all part of the
// decoded exact TypeSpec identity — two TypeSpec rows differing only in one
// of these components must not alias.
function sigFixture(payload) {
  // #Blob heap: 4-byte aligned stream (II.24.2.2) with the signature at
  // index 5: [len byte][payload][zero padding].
  const blobLength = 1 + payload.length;
  const streamSize = Math.ceil((5 + blobLength) / 4) * 4;
  const blob = new Uint8Array(streamSize);
  blob.set([0, 1, 2, 3, 4, payload.length, ...payload]);
  const typeSpecs = new Uint8Array(2);
  new DataView(typeSpecs.buffer).setUint16(0, 5, true);
  return buildCil({
    types: [{ name: 'Derived', methodList: 1, fieldList: 1, extends: 6 }],
    extraRows: new Map([[0x1b, { count: 1, bytes: typeSpecs }]]),
    blobBytes: blob,
  }).bytes;
}
function decodeTypeSpec(payload) {
  return parseCil(sigFixture(payload), { binaryId: 'sig' }).typeSpecs[0].signature;
}
// PTR pointee identity.
assert.deepEqual(decodeTypeSpec([0x0f, 0x08]), {
  stackType: 'native-int', pointee: { stackType: 'int32', bits: 32 },
});
assert.deepEqual(decodeTypeSpec([0x0f, 0x0a]), {
  stackType: 'native-int', pointee: { stackType: 'int64', bits: 64 },
});
// PTR VOID is a distinct pointee state.
assert.deepEqual(decodeTypeSpec([0x0f, 0x01]), {
  stackType: 'native-int', pointee: { stackType: 'void' },
});
// ARRAY rank/size/lower-bound identity.
assert.deepEqual(decodeTypeSpec([0x14, 0x08, 0x02, 0x00, 0x02, 0x01, 0x01]), {
  stackType: 'object-ref',
  arrayShape: { rank: 2, sizes: [], lowerBounds: [1, 1] },
  elementType: { stackType: 'int32', bits: 32 },
});
assert.deepEqual(decodeTypeSpec([0x14, 0x08, 0x03, 0x00, 0x00]), {
  stackType: 'object-ref',
  arrayShape: { rank: 3, sizes: [], lowerBounds: [] },
  elementType: { stackType: 'int32', bits: 32 },
});
// FNPTR nested signature identity.
assert.deepEqual(decodeTypeSpec([0x1b, 0x00, 0x00, 0x08]), {
  stackType: 'native-int',
  signature: {
    callConvention: 0x00, kind: 0x00, hasThis: false, explicitThis: false,
    genericParameterCount: 0, parameters: [], returnValue: { stackType: 'int32', bits: 32 },
  },
});
assert.deepEqual(decodeTypeSpec([0x1b, 0x00, 0x00, 0x01]), {
  stackType: 'native-int',
  signature: {
    callConvention: 0x00, kind: 0x00, hasThis: false, explicitThis: false,
    genericParameterCount: 0, parameters: [], returnValue: null,
  },
});
// Custom modifier identity: modreq token 4 vs 8 on the same SZARRAY element.
assert.deepEqual(decodeTypeSpec([0x1d, 0x1f, 0x04, 0x08]), {
  stackType: 'object-ref',
  arrayShape: { rank: 1, sizes: [], lowerBounds: [] },
  elementType: { stackType: 'int32', bits: 32 },
  customModifiers: [{ kind: 'required', typeToken: 4 }],
});
assert.deepEqual(decodeTypeSpec([0x1d, 0x20, 0x04, 0x08]), {
  stackType: 'object-ref',
  arrayShape: { rank: 1, sizes: [], lowerBounds: [] },
  elementType: { stackType: 'int32', bits: 32 },
  customModifiers: [{ kind: 'optional', typeToken: 4 }],
});
// Differential proof across every component family.
const identities = [
  decodeTypeSpec([0x0f, 0x08]),
  decodeTypeSpec([0x0f, 0x0a]),
  decodeTypeSpec([0x0f, 0x01]),
  decodeTypeSpec([0x14, 0x08, 0x02, 0x00, 0x02, 0x01, 0x01]),
  decodeTypeSpec([0x14, 0x08, 0x03, 0x00, 0x00]),
  decodeTypeSpec([0x1b, 0x00, 0x00, 0x08]),
  decodeTypeSpec([0x1b, 0x00, 0x00, 0x01]),
  decodeTypeSpec([0x1d, 0x1f, 0x04, 0x08]),
  decodeTypeSpec([0x1d, 0x20, 0x04, 0x08]),
  decodeTypeSpec([0x1d, 0x08]),
  decodeTypeSpec([0x1d, 0x0a]),
  decodeTypeSpec([0x15, 0x12, 0x08, 0x01, 0x08]),
];
assert.equal(new Set(identities.map((value) => JSON.stringify(value))).size, identities.length,
  'every representative grammar variant must decode to a distinct identity');

console.log('cil type-spec identity #7673: PASS');
