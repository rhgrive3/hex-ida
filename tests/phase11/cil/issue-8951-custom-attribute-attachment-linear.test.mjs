import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCil } from '../../../js/managed/cil/parser.js';
import { overlayCilMetadata } from '../../../js/managed/cil/parser-overlay.js';
import { parseCil as parseCilBase } from '../../../js/managed/cil/parser-base.js';
import { buildCil } from '../fixtures/medium-cil.mjs';
import { createCilMetadataAdmission } from '../../../js/managed/cil/metadata-budget.js';

// #8951: CustomAttribute attachment rebuilt the owner array with a per-row
// spread (`owner.attributes = [...old, attribute]`), so concentrating N rows
// on one owner copied N(N-1)/2 references, and every row sharing a Value
// #Blob alias re-ran the whole validation decode. The binding phase must be
// linear in rows with exact semantic fidelity (row order, per-row identity,
// fail-closed malformed payloads).

const parseStrict = bytes => overlayCilMetadata(bytes, parseCilBase(bytes));

const FIELD_NAMES = Array.from({ length: 16 }, (_, i) => `F${i}`);
const STRINGS = ['Holder', 'Fixture', 'Run', 'mscorlib', 'System',
  'ThreadStaticAttribute', '.ctor', ...FIELD_NAMES];
function stringIndexes(values) {
  let cursor = 1;
  const out = {};
  for (const value of values) { out[value] = cursor; cursor += Buffer.byteLength(value) + 1; }
  return out;
}
const STR = stringIndexes(STRINGS);

const rows = (size, decoders) => {
  const bytes = new Uint8Array(size * decoders.length);
  const view = new DataView(bytes.buffer);
  decoders.forEach((decode, index) => decode(view, index * size));
  return bytes;
};
const u16 = (view, offset, value) => view.setUint16(offset, value, true);
const u32 = (view, offset, value) => view.setUint32(offset, value, true);

const HAS_CUSTOM_ATTRIBUTE_FIELD = rid => (rid << 5) | 1;
const CUSTOM_ATTRIBUTE_TYPE_MEMBERREF = rid => (rid << 3) | 3;
const MEMBER_REF_PARENT_TYPEREF = rid => (rid << 3) | 1;
const SCOPE_ASSEMBLYREF = rid => (rid << 2) | 2;

const BLOB_BASE_BYTES = 8;

function assemblyRefRows() {
  return rows(20, [(view, p) => { u16(view, p, 4); u16(view, p + 2, 0); u16(view, p + 4, 0); u16(view, p + 6, 0); u32(view, p + 8, 0); u16(view, p + 12, 0); u16(view, p + 14, STR.mscorlib); u16(view, p + 16, 0); u16(view, p + 18, 0); }]);
}
function typeRefRows() {
  return rows(6, [(view, p) => { u16(view, p, SCOPE_ASSEMBLYREF(1)); u16(view, p + 2, STR.ThreadStaticAttribute); u16(view, p + 4, STR.System); }]);
}
function memberRefRows(signatureBlobIndex) {
  return rows(6, [(view, p) => { u16(view, p, MEMBER_REF_PARENT_TYPEREF(1)); u16(view, p + 2, STR['.ctor']); u16(view, p + 4, signatureBlobIndex); }]);
}
function customAttributeRows(parents, valueIndex) {
  return rows(6, parents.map(rid => (view, p) => {
    u16(view, p, HAS_CUSTOM_ATTRIBUTE_FIELD(rid));
    u16(view, p + 2, CUSTOM_ATTRIBUTE_TYPE_MEMBERREF(1));
    u16(view, p + 4, valueIndex);
  }));
}

function namedI4ValueBlob(k) {
  // Constructor signature [0x20,0x00,0x01] is DEFAULT with no fixed
  // arguments: the value blob is prolog + numNamed=k + k FIELD/I4 records
  // (SerString name "b", 4-byte little-endian value).
  const bytes = [0x01, 0x00, k & 0xff, (k >> 8) & 0xff];
  for (let i = 0; i < k; i++) bytes.push(0x53, 0x08, 0x01, 0x62, 0x01, 0x02, 0x03, 0x04);
  return bytes;
}

// The fixture builder writes single-byte #Blob lengths, so every blob stays
// under 128 bytes.
function fixture({ parents, valueBytes, ctorSignature, fieldNames }) {
  const valueLen = valueBytes.length;
  const valueIndex = BLOB_BASE_BYTES;
  const sigIndex = BLOB_BASE_BYTES + 1 + valueLen;
  const fieldSigIndex = sigIndex + ctorSignature.length;
  // methods: [] keeps the image body-free: the builder pins method bodies at
  // a fixed RVA window that a multi-KB #~ stream would otherwise overlap,
  // and CustomAttribute authority needs no method bodies.
  const metadataSize = 0x1400 + parents.length * 6 + valueLen * 2 + 0x1000;
  const built = buildCil({
    imageSize: 0x2000 + metadataSize,
    metadataSize,
    methods: [],
    types: [{ name: 'Holder', namespace: 'Fixture', methodList: 1, fieldList: 1 }],
    fields: fieldNames.map(name => ({ name, flags: 0x0606, signature: [0x06, 0x0e] })),
    leadingStrings: STRINGS,
    blobs: [valueBytes, ctorSignature, [0x06, 0x0e]],
    extraRows: [
      [0x23, { count: 1, bytes: assemblyRefRows() }],
      [0x01, { count: 1, bytes: typeRefRows() }],
      [0x0a, { count: 1, bytes: memberRefRows(sigIndex) }],
      [0x0c, { count: parents.length, bytes: customAttributeRows(parents, valueIndex) }],
    ],
  });
  return built.bytes;
}

const SMALL_VALUE = [0x01, 0x00, 0x00, 0x00];
const NO_ARG_CTOR = [0x20, 0x00, 0x01];
const NAMED_ONLY_CTOR = [0x20, 0x00, 0x01]; /* DEFAULT, zero fixed args, void return: named arguments only */
const simple = (parents, fieldNames = ['F0']) => fixture({ parents, valueBytes: SMALL_VALUE, ctorSignature: NO_ARG_CTOR, fieldNames });
const runParse = bytes => parseCil(bytes, {
  metadataAdmission: createCilMetadataAdmission({
    maxRows: 200_000, maxObjects: 4_000_000, maxStringBytes: 32 * 1024 * 1024,
    maxOperations: 100_000_000, maxElapsedMs: 600_000,
  }),
});
const oneOwner = n => Array.from({ length: n }, () => 1);
const spreadOwners = n => Array.from({ length: n }, (_, i) => (i % 16) + 1);

test('#8951 attachment keeps exact row order, identity and per-owner isolation', () => {
  const image = runParse(simple([1, 2, 1, 2], ['F0', 'F1']));
  const ownerA = image.fields[0].attributes;
  const ownerB = image.fields[1].attributes;
  assert.equal(ownerA.length, 2);
  assert.equal(ownerB.length, 2);
  assert.deepEqual(image.customAttributes.map(a => a.parentToken),
    ['0x04000001', '0x04000002', '0x04000001', '0x04000002']);
  assert.equal(ownerA[0], image.customAttributes[0], 'owner slots keep the canonical row object');
  assert.equal(ownerB[1], image.customAttributes[3]);
  assert.equal(ownerA[0].constructorToken, '0x0a000001');
  assert.equal(ownerA[0].attributeTypeName, 'System.ThreadStaticAttribute::.ctor');
  assert.deepEqual([...ownerA[0].rawValue], SMALL_VALUE);
  assert.equal(ownerA[0].prolog, 0x0001);
  assert.equal(ownerA[0].numNamed, 0);
});

test('#8951 owner attribute lists are final canonical (immutable) containers', () => {
  const image = runParse(simple(oneOwner(2)));
  const attrs = image.fields[0].attributes;
  assert.ok(Object.isFrozen(attrs), 'attachment must publish a frozen list, not a live builder');
  assert.throws(() => { attrs.push({}); }, TypeError);
  assert.equal(attrs.length, 2);
});

test('#8951 20k attributes on one owner stay linear (no prefix-rebuild curve)', () => {
  const t = (n) => {
    const started = process.hrtime.bigint();
    const image = runParse(simple(oneOwner(n)));
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.equal(image.fields[0].attributes.length, n);
    assert.equal(image.customAttributes.length, n);
    // Row order stays metadata order even at scale.
    assert.equal(image.fields[0].attributes[0], image.customAttributes[0]);
    assert.equal(image.fields[0].attributes[n - 1], image.customAttributes[n - 1]);
    return ms;
  };
  const small = t(5000);
  const large = t(20000);
  // Quadratic attachment shows >=14x for a 4x size increase; linear work
  // stays near 4x. The bound is generous for machine noise.
  assert.ok(large < small * 8 + 250, `attachment scaled quadratically: 5k=${small.toFixed(0)}ms 20k=${large.toFixed(0)}ms`);
});

test('#8951 shared Value blob alias decodes the validation pass once, not per row', () => {
  // 40k rows share one named-argument Value #Blob and one constructor
  // signature, spread across 16 owners (<=2500 rows each) so the per-owner
  // arrays stay small and the curve isolates binding work. The base build
  // measures 500 -> 40k at a 24x time ratio (20x the 8x linear bound) from
  // the per-row validation re-runs; the cached path stays near-linear.
  // (500 -> 80x: quadratic attachment alone would be >=6400x.)
  const valueBytes = namedI4ValueBlob(12);
  const run = (n) => {
    const started = process.hrtime.bigint();
    const image = runParse(fixture({ parents: spreadOwners(n), valueBytes, ctorSignature: NAMED_ONLY_CTOR, fieldNames: FIELD_NAMES }));
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.equal(image.customAttributes.length, n);
    assert.equal(image.fields[0].attributes.length, Math.ceil(n / 16));
    for (const attribute of image.customAttributes) {
      assert.equal(attribute.prolog, 0x0001);
      assert.equal(attribute.numNamed, 12);
    }
    return ms;
  };
  const small = run(500);
  const large = run(40_000);
  assert.ok(large < small * 10 + 500, `shared-blob binding scaled super-linearly: 500=${small.toFixed(0)}ms 40k=${large.toFixed(0)}ms`);
});

test('#8951 aliased rows keep exact per-parent attribute authority under one shared decode', () => {
  const valueBytes = namedI4ValueBlob(12);
  const image = runParse(fixture({ parents: spreadOwners(96), valueBytes, ctorSignature: NAMED_ONLY_CTOR, fieldNames: FIELD_NAMES }));
  assert.equal(image.customAttributes.length, 96);
  for (const [i, attribute] of image.customAttributes.entries()) {
    assert.equal(attribute.parentToken, `0x04${((i % 16) + 1).toString(16).padStart(6, '0')}`);
    assert.equal(attribute.prolog, 0x0001);
    assert.equal(attribute.numNamed, 12);
    assert.deepEqual([...attribute.rawValue], valueBytes);
    assert.equal(image.fields[i % 16].attributes[Math.floor(i / 16)], attribute);
  }
});

test('#8951 malformed shared Value payloads still fail closed for every alias row', () => {
  // numNamed claims two records; the blob carries one complete record plus a truncated second: the first row must
  // throw and the cached failure must reproduce the same code for a later
  // row with the identical alias (no silent success from cache).
  const bad = [0x01, 0x00, 0x02, 0x00, 0x53, 0x08, 0x01, 0x62, 0x01, 0x02, 0x03, 0x04, 0x53, 0x08, 0x01, 0x62, 0x01];
  const bytes = fixture({ parents: oneOwner(3), valueBytes: bad, ctorSignature: NAMED_ONLY_CTOR, fieldNames: ['F0'] });
  assert.throws(() => parseStrict(bytes), /cil-customattribute-value-invalid/);
});

