// Regression for #7545: ECMA-335 II.22.18 FieldRVA (0x1D) — a static field's
// initial data RVA must survive into the canonical metadata. The table used to
// be layout-walked only, so changing the FieldRVA row or the backing bytes
// left the canonical projection byte-identical (irreversible data loss).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseCil } from '../js/managed/cil/parser.js';
import { buildCil } from './phase11/fixtures/medium-cil.mjs';

// Single section maps RVA 0x2000 -> file 0x200; metadata root lives at RVA 0x2100.
const fileOffset = rva => 0x200 + (rva - 0x2000);
const base = {
  types: [{ name: 'K', namespace: 'Interop', methodList: 1, fieldList: 1 }],
  fields: [{ name: 'X', flags: 0x0116 }],
  methods: [],
};
const fieldRvaRow = (rva, rid = 1) => Uint8Array.of(rva & 0xff, (rva >> 8) & 0xff, (rva >> 16) & 0xff, (rva >> 24) & 0xff, rid, 0);
const semantic = image => JSON.stringify({
  types: image.types,
  fields: image.fields,
  methods: image.methods,
  methodBodies: image.methodBodies,
});

test('#7545 a FieldRVA row binds the static field initial-data RVA into canonical metadata', () => {
  const withData = buildCil({
    ...base,
    extraRows: new Map([[0x1d, { count: 1, bytes: fieldRvaRow(0x3800) }]]),
  });
  withData.bytes.set(Uint8Array.of(0x44, 0x33, 0x22, 0x11), fileOffset(0x3800));
  const image = parseCil(withData.bytes);
  // The canonical field carries the RVA authority; a successful parse also
  // proves the overlay mapped it inside the loaded image, off the metadata area.
  assert.equal(image.fields[0].rva, 0x3800);
  assert.equal(image.fields[0].token, '0x04000001');
  assert.equal(image.fields[0].declaringTypeToken, '0x02000001');
});

test('#7545 changing the FieldRVA changes the canonical semantic projection', () => {
  const at0x3800 = parseCil(buildCil({
    ...base,
    extraRows: new Map([[0x1d, { count: 1, bytes: fieldRvaRow(0x3800) }]]),
  }).bytes);
  const at0x3810 = parseCil(buildCil({
    ...base,
    extraRows: new Map([[0x1d, { count: 1, bytes: fieldRvaRow(0x3810) }]]),
  }).bytes);
  assert.notEqual(semantic(at0x3800), semantic(at0x3810));
});

test('#7545 distinct backing bytes at the mapped RVAs stay distinguishable by field identity', () => {
  const a = buildCil({
    ...base,
    extraRows: new Map([[0x1d, { count: 1, bytes: fieldRvaRow(0x3800) }]]),
  });
  a.bytes.set(Uint8Array.of(0x44, 0x33, 0x22, 0x11), fileOffset(0x3800));
  const b = buildCil({
    ...base,
    extraRows: new Map([[0x1d, { count: 1, bytes: fieldRvaRow(0x3810) }]]),
  });
  b.bytes.set(Uint8Array.of(0x88, 0x77, 0x66, 0x55), fileOffset(0x3810));
  const imageA = parseCil(a.bytes), imageB = parseCil(b.bytes);
  assert.notEqual(semantic(imageA), semantic(imageB));
  assert.equal(imageA.fields[0].rva, 0x3800);
  assert.equal(imageB.fields[0].rva, 0x3810);
  assert.deepEqual(
    [...a.bytes.subarray(fileOffset(0x3800), fileOffset(0x3800) + 4)],
    [0x44, 0x33, 0x22, 0x11],
  );
  assert.deepEqual(
    [...b.bytes.subarray(fileOffset(0x3810), fileOffset(0x3810) + 4)],
    [0x88, 0x77, 0x66, 0x55],
  );
});

test('#7545 FieldRVA -> FieldDef association is token/RID exact', () => {
  const two = {
    ...base,
    fields: [{ name: 'X', flags: 0x0116 }, { name: 'Y', flags: 0x0116 }],
  };
  const image = parseCil(buildCil({
    ...two,
    extraRows: new Map([[0x1d, { count: 1, bytes: fieldRvaRow(0x3800, 2) }]]),
  }).bytes);
  // FieldRVA.Field is a plain Field RID: only Field RID 2 gets the binding.
  assert.equal(image.fields[0].rva, undefined);
  assert.equal(image.fields[1].rva, 0x3800);
  assert.equal(image.fields[1].token, '0x04000002');
});

test('#7545 FieldPtr reordering does not corrupt FieldRVA field identity', () => {
  const image = parseCil(buildCil({
    ...base,
    fields: [{ name: 'X', flags: 0x0116 }, { name: 'Y', flags: 0x0116 }],
    // Unoptimized #-style FieldPtr: the type's member list is [Y, X].
    extraRows: new Map([
      [0x03, { count: 2, bytes: Uint8Array.of(2, 0, 1, 0) }],
      [0x1d, { count: 1, bytes: fieldRvaRow(0x3800, 1) }],
    ]),
  }).bytes);
  assert.equal(image.fields[0].rva, 0x3800);
  assert.equal(image.fields[1].rva, undefined);
  assert.equal(image.fields[0].declaringTypeToken, '0x02000001');
  assert.equal(image.fields[1].declaringTypeToken, '0x02000001');
});

test('#7545 FieldRVA validation is fail-closed (II.22.18)', () => {
  const cases = [
    // RVA = 0: no initial data location.
    fieldRvaRow(0),
    // RVA 0x7f00 maps nowhere in the single 0x2000.. section.
    fieldRvaRow(0x7f00),
    // RVA inside the metadata root area.
    fieldRvaRow(0x2300),
    // Field RID 9 with a single Field row.
    fieldRvaRow(0x3800, 9),
  ];
  for (const bytes of cases) {
    assert.throws(() => parseCil(buildCil({
      ...base,
      extraRows: new Map([[0x1d, { count: 1, bytes }]]),
    }).bytes), /cil-unsupported-binary/);
  }
  // Two FieldRVA rows for the same Field: the binding is ambiguous.
  assert.throws(() => parseCil(buildCil({
    ...base,
    extraRows: new Map([[0x1d, { count: 2, bytes: [...fieldRvaRow(0x3800), ...fieldRvaRow(0x3810)] }]]),
  }).bytes), /cil-unsupported-binary/);
  // FieldRVA for a field without the HasFieldRVA (0x0100) attribute.
  assert.throws(() => parseCil(buildCil({
    ...base,
    fields: [{ name: 'X', flags: 0x0006 }],
    extraRows: new Map([[0x1d, { count: 1, bytes: fieldRvaRow(0x3800) }]]),
  }).bytes), /cil-unsupported-binary/);
});
