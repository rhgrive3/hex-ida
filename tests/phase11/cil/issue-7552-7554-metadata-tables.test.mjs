import test from 'node:test';
import assert from 'node:assert/strict';

import { parseCil } from '../../../js/managed/cil/parser.js';
import { parseCil as parseCilBase } from '../../../js/managed/cil/parser-base.js';
import { overlayCilMetadata } from '../../../js/managed/cil/parser-overlay.js';
import { buildCil } from '../fixtures/medium-cil.mjs';

const pad = (b) => { const p = new Uint8Array(Math.ceil(b.length / 4) * 4); p.set(b); return p; };
const stringsHeap = (names) => pad(Uint8Array.from([0, ...names.flatMap((n) => [...new TextEncoder().encode(n), 0])]));
const blobHeap = (values) => {
  // Compressed-length prefix (single byte: every fixture value stays < 0x80).
  const parts = [0];
  const indexes = [];
  for (const value of values) {
    assert.ok(value.length < 0x80);
    indexes.push(parts.length);
    parts.push(value.length, ...value);
  }
  return { bytes: pad(Uint8Array.from(parts)), indexes };
};

// Raw overlay path: surfaces the specific fail-closed codes that the parseCil
// probe facade intentionally collapses to cil-unsupported-binary.
const rawParse = (bytes) => overlayCilMetadata(bytes, parseCilBase(bytes));

// Parse with an explicit #Blob heap so Constant values are addressable.
// Returns the parsed image; `fail` matches the expected failure code.
function parseWithBlob(caseOptions, blobs, fail) {
  const first = buildCil(caseOptions);
  const tablesStream = first.layout.streams.find((s) => s.name === '#~');
  const tablesBytes = first.bytes.slice(tablesStream.offset, tablesStream.offset + tablesStream.size);
  const blob = blobHeap(blobs);
  const names = ['Run', 'Widget', 'Example', ...(caseOptions.fields ?? []).map((f) => f.name)];
  const bytes = buildCil({
    ...caseOptions,
    streams: [
      { name: '#~', bytes: tablesBytes },
      { name: '#Strings', bytes: stringsHeap(names) },
      { name: '#Blob', bytes: blob.bytes },
    ],
  }).bytes;
  if (fail) {
    // Negative cases assert the specific fail-closed code at the raw overlay
    // layer (the parseCil probe facade collapses it to cil-unsupported-binary).
    assert.throws(() => rawParse(bytes), fail);
    return null;
  }
  return { image: parseCil(bytes), blob, bytes };
}

test('#7552 Constant rows bind decoded literal values onto their Field rows', () => {
  // Parent = (fieldRid << 2) | HasConstant(Field tag 0)
  const constantRows = new Uint8Array(12);
  const cv = new DataView(constantRows.buffer);
  cv.setUint8(0, 0x08); cv.setUint16(2, 4, true); cv.setUint16(4, 1, true); // field 1: I4
  cv.setUint8(6, 0x08); cv.setUint16(8, 8, true); cv.setUint16(10, 6, true); // field 2: I4
  const { image } = parseWithBlob(
    { fields: [{ name: 'X', flags: 0x8056 }, { name: 'Y', flags: 0x8056 }], extraRows: [[0x0b, { count: 2, bytes: constantRows }]] },
    [[42, 0, 0, 0], [7, 0, 0, 0]],
  );
  assert.deepEqual(image.fields[0].constant, { type: 'int32', value: 42 });
  assert.deepEqual(image.fields[1].constant, { type: 'int32', value: 7 });
  assert.equal(image.constants.length, 2);
  assert.deepEqual(image.constants[0], { token: '0x0b000001', parent: '0x04000001', type: 'int32', value: 42 });
});

test('#7552 constant value shapes decode exactly', () => {
  const values = [
    [0x08, [42, 0, 0, 0]], // int32
    [0x0a, [120, 105, 0, 0, 0, 0, 0, 0]], // int64 27000n
    [0x0e, [72, 0, 105, 0]], // string 'Hi' (UTF-16LE)
    [0x02, [1]], // boolean true
    [0x0d, [0, 0, 0, 0, 0, 0, 44, 64]], // float64 14
    [0x12, [0, 0, 0, 0]], // class null reference
  ];
  // Replicate the helper's blob layout so the rows can reference real indexes.
  const parts = [0];
  const indexes = [];
  for (const [, payload] of values) {
    indexes.push(parts.length);
    parts.push(payload.length, ...payload);
  }
  const rows = new Uint8Array(values.length * 6);
  const cv = new DataView(rows.buffer);
  values.forEach(([type], i) => {
    cv.setUint8(i * 6, type);
    cv.setUint16(i * 6 + 2, (i + 1) << 2, true);
    cv.setUint16(i * 6 + 4, indexes[i], true);
  });
  const { image, blob } = parseWithBlob(
    { fields: values.map((_, i) => ({ name: `F${i}`, flags: 0x8056 })), extraRows: [[0x0b, { count: values.length, bytes: rows }]] },
    values.map(([, payload]) => payload),
  );
  assert.deepEqual(image.fields[0].constant, { type: 'int32', value: 42 });
  assert.deepEqual(image.fields[1].constant, { type: 'int64', value: 27000n });
  assert.deepEqual(image.fields[2].constant, { type: 'string', value: 'Hi' });
  assert.deepEqual(image.fields[3].constant, { type: 'boolean', value: true });
  assert.equal(image.fields[4].constant.value, 14);
  assert.deepEqual(image.fields[5].constant, { type: 'class', value: null });
  assert.equal(blob.indexes.length, values.length);
});

test('#7552 64-bit Constant high-bit boundaries decode exactly', () => {
  // R0 review: I8/U8 both used the signed limb decoder; the |0 sign-extension
  // plus the double-applied -(1<<64) correction corrupted high-bit-set values.
  const values = [
    [0x0a, [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]], // I8 -1
    [0x0b, [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]], // U8 2^64-1
    [0x0a, [0, 0, 0, 0, 0, 0, 0, 0x80]], // I8 MIN_INT64
    [0x0a, [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f]], // I8 MAX_INT64
  ];
  const expected = [-1n, 18446744073709551615n, -9223372036854775808n, 9223372036854775807n];
  const parts = [0];
  const indexes = [];
  for (const [, payload] of values) {
    indexes.push(parts.length);
    parts.push(payload.length, ...payload);
  }
  const rows = new Uint8Array(values.length * 6);
  const cv = new DataView(rows.buffer);
  values.forEach(([type], i) => {
    cv.setUint8(i * 6, type);
    cv.setUint16(i * 6 + 2, (i + 1) << 2, true);
    cv.setUint16(i * 6 + 4, indexes[i], true);
  });
  const { image } = parseWithBlob(
    { fields: values.map((_, i) => ({ name: `B${i}`, flags: 0x8056 })), extraRows: [[0x0b, { count: values.length, bytes: rows }]] },
    values.map(([, payload]) => payload),
  );
  expected.forEach((value, i) => {
    const type = i === 1 ? 'uint64' : 'int64';
    assert.deepEqual(image.fields[i].constant, { type, value });
  });
});

test('#7552 dropping the Constant table changes the canonical projection', () => {
  const constantRows = Uint8Array.of(0x08, 0, 4, 0, 1, 0);
  const withRow = parseWithBlob(
    { fields: [{ name: 'X', flags: 0x8056 }], extraRows: [[0x0b, { count: 1, bytes: constantRows }]] },
    [[42, 0, 0, 0]],
  );
  assert.deepEqual(withRow.image.fields[0].constant, { type: 'int32', value: 42 });
  const without = parseWithBlob({ fields: [{ name: 'X', flags: 0x8056 }] }, [[42, 0, 0, 0]]);
  assert.equal(without.image.fields[0].constant, undefined);
  assert.notEqual(JSON.stringify(without.image.fields), JSON.stringify(withRow.image.fields));
});

test('#7552 constant contracts fail closed', () => {
  const fields = [{ name: 'X', flags: 0x8056 }, { name: 'Y', flags: 0x8056 }];
  const blobs = [[42, 0, 0, 0]];
  // duplicate parent rows
  parseWithBlob({ fields, extraRows: [[0x0b, { count: 2, bytes: Uint8Array.of(0x08, 0, 4, 0, 1, 0, 0x08, 0, 4, 0, 1, 0) }]] }, blobs, /cil-constant-parent-duplicate/);
  // blob width mismatch for int32 (1-byte payload where 4 are required)
  parseWithBlob({ fields, extraRows: [[0x0b, { count: 1, bytes: Uint8Array.of(0x08, 0, 4, 0, 1, 0) }]] }, [[42]], /cil-constant-blob-length-invalid/);
  // ELEMENT_TYPE code outside the Constant value set
  parseWithBlob({ fields, extraRows: [[0x0b, { count: 1, bytes: Uint8Array.of(0x55, 0, 4, 0, 1, 0) }]] }, blobs, /cil-constant-type-invalid/);
  // parent rid outside its table
  parseWithBlob({ fields, extraRows: [[0x0b, { count: 1, bytes: Uint8Array.of(0x08, 0, 0xfc, 0xff, 1, 0) }]] }, blobs, /cil-constant-parent-invalid/);
  // parent row 0
  parseWithBlob({ fields, extraRows: [[0x0b, { count: 1, bytes: Uint8Array.of(0x08, 0, 0, 0, 1, 0) }]] }, blobs, /cil-constant-parent-required/);
  // a binary whose Constant metadata is malformed is unsupported through the
  // parseCil probe facade
  const dupRows = Uint8Array.of(0x08, 0, 4, 0, 1, 0, 0x08, 0, 4, 0, 1, 0);
  const first = buildCil({ fields, extraRows: [[0x0b, { count: 2, bytes: dupRows }]] });
  const tablesStream = first.layout.streams.find((s) => s.name === '#~');
  const probeBytes = buildCil({
    extraRows: [[0x0b, { count: 2, bytes: dupRows }]],
    streams: [
      { name: '#~', bytes: first.bytes.slice(tablesStream.offset, tablesStream.offset + tablesStream.size) },
      { name: '#Strings', bytes: stringsHeap(['Run', 'Widget', 'Example', 'X', 'Y']) },
      { name: '#Blob', bytes: blobHeap(blobs).bytes },
    ],
  }).bytes;
  assert.throws(() => parseCil(probeBytes), /cil-unsupported-binary/);
});

test('#7552 Constant.Type OBJECT (0x1c) is not a valid null-reference encoding', () => {
  // II.22.9 restricts Constant.Type to the primitive/string set plus CLASS
  // (0x12) for the 4-byte zero null reference; OBJECT (0x1c) is not a valid
  // Constant.Type (#7552 R1 review) and must not publish canonical authority.
  const fields = [{ name: 'X', flags: 0x8056 }];
  const objectRow = Uint8Array.of(0x1c, 0, 4, 0, 1, 0);
  const zeroBlob = [[0, 0, 0, 0]];
  parseWithBlob({ fields, extraRows: [[0x0b, { count: 1, bytes: objectRow }]] }, zeroBlob, /cil-constant-type-invalid/);
  // the same malformed row stays rejected through a reference-typed field
  // (the old field type-agreement exception laundered it)
  parseWithBlob(
    { fields: [{ name: 'X', flags: 0x8056, signature: [0x06, 0x1c] }], extraRows: [[0x0b, { count: 1, bytes: objectRow }]] },
    zeroBlob,
    /cil-constant-type-invalid/,
  );
  // positive control: CLASS (0x12) null reference stays publishable
  const classRow = Uint8Array.of(0x12, 0, 4, 0, 1, 0);
  const ok = parseWithBlob({ fields, extraRows: [[0x0b, { count: 1, bytes: classRow }]] }, zeroBlob);
  assert.deepEqual(ok.image.fields[0].constant, { type: 'class', value: null });
});

test('#7553 ClassLayout and FieldLayout bind size, packing, and explicit offsets', () => {
  const classLayout = new Uint8Array(8);
  const cv = new DataView(classLayout.buffer);
  cv.setUint16(0, 8, true); cv.setUint32(2, 64, true); cv.setUint16(6, 1, true);
  const fieldLayout = new Uint8Array(6);
  const fv = new DataView(fieldLayout.buffer);
  fv.setUint32(0, 16, true); fv.setUint16(4, 1, true);
  const image = parseCil(buildCil({
    types: [{ name: 'Widget', flags: 0x11 }],
    fields: [{ name: 'X' }],
    extraRows: [[0x0f, { count: 1, bytes: classLayout }], [0x10, { count: 1, bytes: fieldLayout }]],
  }).bytes);
  assert.deepEqual(image.types[0].classLayout, { packingSize: 8, classSize: 64 });
  assert.equal(image.fields[0].offset, 16);
});

test('#7553 layout rows distinguish otherwise identical explicit structs', () => {
  const mk = (classSize) => {
    const classLayout = new Uint8Array(8);
    const cv = new DataView(classLayout.buffer);
    cv.setUint16(0, 0, true); cv.setUint32(2, classSize, true); cv.setUint16(6, 1, true);
    return parseCil(buildCil({
      types: [{ name: 'Widget', flags: 0x11 }],
      fields: [{ name: 'X' }],
      extraRows: [[0x0f, { count: 1, bytes: classLayout }]],
    }).bytes);
  };
  assert.equal(mk(64).types[0].classLayout.classSize, 64);
  assert.equal(mk(128).types[0].classLayout.classSize, 128);
  assert.notEqual(JSON.stringify(mk(64).types), JSON.stringify(mk(128).types));
});

test('#7553 layout contracts fail closed', () => {
  const bad = (rows) => rawParse(buildCil({ types: [{ name: 'Widget', flags: 0x11 }], fields: [{ name: 'X' }], extraRows: rows }).bytes);
  // non-power-of-two packing size
  const badPacking = new Uint8Array(8);
  new DataView(badPacking.buffer).setUint16(0, 3, true);
  new DataView(badPacking.buffer).setUint16(6, 1, true);
  assert.throws(() => bad([[0x0f, { count: 1, bytes: badPacking }]]), /cil-class-layout-packing-invalid/);
  // duplicate ClassLayout parent
  const layout = new Uint8Array(8);
  new DataView(layout.buffer).setUint16(6, 1, true);
  assert.throws(() => bad([[0x0f, { count: 2, bytes: Uint8Array.of(...layout, ...layout) }]]), /cil-class-layout-parent-duplicate/);
  // duplicate FieldLayout field
  const fieldRow = Uint8Array.of(16, 0, 0, 0, 1, 0);
  assert.throws(() => bad([[0x10, { count: 2, bytes: Uint8Array.of(...fieldRow, ...fieldRow) }]]), /cil-field-layout-field-duplicate/);
  // FieldLayout referencing an unknown Field rid
  const orphan = Uint8Array.of(16, 0, 0, 0, 9, 0);
  assert.throws(() => bad([[0x10, { count: 1, bytes: orphan }]]), /cil-field-layout-field-invalid/);
});

test('#7554 NestedClass rows bind the enclosing-type relation', () => {
  const nested = Uint8Array.of(3, 0, 1, 0);
  const image = parseCil(buildCil({
    types: [
      { name: 'A', flags: 1 },
      { name: 'B', flags: 1 },
      { name: 'N', flags: 2 },
    ],
    extraRows: [[0x29, { count: 1, bytes: nested }]],
  }).bytes);
  assert.equal(image.types[2].enclosingTypeToken, '0x02000001');
  assert.equal(image.types[0].enclosingTypeToken, undefined);
});

test('#7554 nested relations distinguish identically-named types by scope', () => {
  const nested = Uint8Array.of(3, 0, 1, 0);
  const swapped = Uint8Array.of(3, 0, 2, 0);
  const base = {
    types: [
      { name: 'A', flags: 1 },
      { name: 'B', flags: 1 },
      { name: 'N', flags: 2 },
    ],
  };
  const a = parseCil(buildCil({ ...base, extraRows: [[0x29, { count: 1, bytes: nested }]] }).bytes);
  const b = parseCil(buildCil({ ...base, extraRows: [[0x29, { count: 1, bytes: swapped }]] }).bytes);
  assert.equal(a.types[2].enclosingTypeToken, '0x02000001');
  assert.equal(b.types[2].enclosingTypeToken, '0x02000002');
  assert.notEqual(JSON.stringify(a.types.map((t) => t.enclosingTypeToken)), JSON.stringify(b.types.map((t) => t.enclosingTypeToken)));
});

test('#7554 nested-class contracts fail closed', () => {
  const bad = (rows) => rawParse(buildCil({
    types: [
      { name: 'A', flags: 3 },
      { name: 'B', flags: 3 },
      { name: 'N', flags: 2 },
    ],
    extraRows: rows,
  }).bytes);
  // unknown nested rid
  assert.throws(() => bad([[0x29, { count: 1, bytes: Uint8Array.of(9, 0, 1, 0) }]]), /cil-nested-class-reference-invalid/);
  // self-referential
  assert.throws(() => bad([[0x29, { count: 1, bytes: Uint8Array.of(1, 0, 1, 0) }]]), /cil-nested-class-self-referential/);
  // duplicate nested row
  assert.throws(() => bad([[0x29, { count: 2, bytes: Uint8Array.of(3, 0, 1, 0, 3, 0, 2, 0) }]]), /cil-nested-class-nested-duplicate/);
  // two-type cycle
  assert.throws(() => bad([[0x29, { count: 2, bytes: Uint8Array.of(1, 0, 2, 0, 2, 0, 1, 0) }]]), /cil-nested-class-cycle/);
});

test('#7552 a literal must agree with the parent field declared type', () => {
  // FIELD I4 with a Constant row claiming ELEMENT_TYPE_I8: publish must fail
  // closed instead of laundering an I8 literal into an I4 field (#7552 R0).
  // buildCil appends options.blobs first (heap index 8), so the Constant row's
  // valueIndex 8 and the field's signature blob coexist in one heap.
  // valueIndex 8 = first appended blob (the 8-byte I8 payload).
  const mismatchRow = Uint8Array.of(0x0a, 0, 4, 0, 8, 0);
  assert.throws(() => rawParse(buildCil({
    types: [{ name: 'Widget', flags: 0x11 }],
    fields: [{ name: 'X', flags: 0x8056, signature: [0x06, 0x08] }],
    blobs: [Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8)],
    extraRows: [[0x0b, { count: 1, bytes: mismatchRow }]],
  }).bytes), /cil-constant-type-mismatch/);
  // agreement control: I4 field + I4 constant stays publishable
  const agreeRow = Uint8Array.of(0x08, 0, 4, 0, 8, 0);
  const agree = parseCil(buildCil({
    types: [{ name: 'Widget', flags: 0x11 }],
    fields: [{ name: 'X', flags: 0x8056, signature: [0x06, 0x08] }],
    blobs: [Uint8Array.of(42, 0, 0, 0)],
    extraRows: [[0x0b, { count: 1, bytes: agreeRow }]],
  }).bytes);
  assert.deepEqual(agree.fields[0].constant, { type: 'int32', value: 42 });
});

test('#7553 AutoLayout types cannot carry explicit layout rows', () => {
  // Default TypeDef flags (1 = Public → AutoLayout) contradict a ClassLayout
  // row; a layout-carrying TypeDef must declare sequential/explicit layout.
  const layout = new Uint8Array(8);
  new DataView(layout.buffer).setUint16(6, 1, true);
  assert.throws(() => rawParse(buildCil({
    fields: [{ name: 'X' }],
    extraRows: [[0x0f, { count: 1, bytes: layout }]],
  }).bytes), /cil-class-layout-flags-contradiction/);
  const sequential = parseCil(buildCil({
    types: [{ name: 'Widget', flags: 0x11 }],
    fields: [{ name: 'X' }],
    extraRows: [[0x0f, { count: 1, bytes: layout }]],
  }).bytes);
  assert.deepEqual(sequential.types[0].classLayout.classSize, 0);
});

test('#7554 a non-nested visibility TypeDef cannot be a nested child', () => {
  // Public (0x1) visibility is a top-level visibility — nesting it is a
  // flags contradiction (#7554 R0).
  assert.throws(() => rawParse(buildCil({
    types: [
      { name: 'A', flags: 1 },
      { name: 'N', flags: 1 },
    ],
    extraRows: [[0x29, { count: 1, bytes: Uint8Array.of(2, 0, 1, 0) }]],
  }).bytes), /cil-nested-class-visibility-invalid/);
  const ok = parseCil(buildCil({
    types: [
      { name: 'A', flags: 1 },
      { name: 'N', flags: 2 },
    ],
    extraRows: [[0x29, { count: 1, bytes: Uint8Array.of(2, 0, 1, 0) }]],
  }).bytes);
  assert.equal(ok.types[1].enclosingTypeToken, '0x02000001');
});
