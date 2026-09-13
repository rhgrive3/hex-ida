import assert from 'node:assert/strict';
import { parseCil, probeCil } from '../../../js/managed/cil/parser.js';
import { overlayCilMetadata } from '../../../js/managed/cil/parser-overlay.js';
import { parseCil as parseCilBase } from '../../../js/managed/cil/parser-base.js';
import { buildCil } from '../fixtures/medium-cil.mjs';

// parseCil() collapses every metadata failure into 'cil-unsupported-binary', so
// the structural checks below go through the overlay entry point that preserves
// the exact fail-closed reason code.
const parseStrict = bytes => overlayCilMetadata(bytes, parseCilBase(bytes));

// #7557 / #7556 — FieldMarshal (0x0D) and CustomAttribute (0x0C) rows were
// structurally walked but never semantically decoded, so two binaries whose
// managed -> native marshalling descriptor or runtime-affecting attribute
// differed produced an identical canonical semantic image.
//
// The fixtures below are byte-level, independent of the production layout code
// (tests/phase11/fixtures/medium-cil.mjs). The values follow ECMA-335 II.23.4
// (NATIVE_TYPE_LPSTR = 0x14, NATIVE_TYPE_LPWSTR = 0x15).

const STRINGS = ['Holder', 'Fixture', 'X', 'Run', 'mscorlib', 'System',
  'ThreadStaticAttribute', 'Object', '.ctor', 'p1'];

// The fixture builder places each leading string at the heap cursor, so the
// index of NAMES[i] is derivable without re-reading the built heap.
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

// II.24.2.6 coded indices: HasFieldMarshal(Field|Param, 1 bit),
// HasCustomAttribute(22 tables, 5 bits), CustomAttributeType(MethodDef|
// MemberRef, 3 bits), MemberRefParent(TypeDef|TypeRef|ModuleRef|MethodDef|
// TypeSpec, 3 bits), ResolutionScope(Module|ModuleRef|AssemblyRef|TypeRef, 2 bits).
const HAS_FIELD_MARSHAL_FIELD = rid => (rid << 1) | 0;
const HAS_FIELD_MARSHAL_PARAM = rid => (rid << 1) | 1;
const HAS_CUSTOM_ATTRIBUTE_FIELD = rid => (rid << 5) | 1;
const CUSTOM_ATTRIBUTE_TYPE_METHODDEF = rid => (rid << 3) | 2;
const CUSTOM_ATTRIBUTE_TYPE_MEMBERREF = rid => (rid << 3) | 3;
const MEMBER_REF_PARENT_TYPEREF = rid => (rid << 3) | 1;
const SCOPE_ASSEMBLYREF = rid => (rid << 2) | 2;

// The fixture builder hard-codes blob index 1 (method signature) and index 5
// (field signature), so the legacy 8-byte heap prefix is kept and the extra
// blobs are appended by `blobs` in a deterministic order.
const BLOB_BASE_BYTES = 8;
const MARSHAL_BLOB_INDEX = BLOB_BASE_BYTES;
const attributeValueBlobIndex = marshalSpec => BLOB_BASE_BYTES + 1 + marshalSpec.length;

function typeRefRows() {
  return rows(6, [
    (view, p) => { u16(view, p, SCOPE_ASSEMBLYREF(1)); u16(view, p + 2, STR['ThreadStaticAttribute']); u16(view, p + 4, STR.System); },
    (view, p) => { u16(view, p, SCOPE_ASSEMBLYREF(1)); u16(view, p + 2, STR.Object); u16(view, p + 4, STR.System); },
  ]);
}

function assemblyRefRows() {
  return rows(20, [(view, p) => { u16(view, p, 4); u16(view, p + 2, 0); u16(view, p + 4, 0); u16(view, p + 6, 0); u32(view, p + 8, 0); u16(view, p + 12, 0); u16(view, p + 14, STR.mscorlib); u16(view, p + 16, 0); u16(view, p + 18, 0); }]);
}

function memberRefRows(signatureBlobIndex = 1) {
  return rows(6, [(view, p) => { u16(view, p, MEMBER_REF_PARENT_TYPEREF(1)); u16(view, p + 2, STR['.ctor']); u16(view, p + 4, signatureBlobIndex); }]);
}

function fieldMarshalRow(parentBase, nativeTypeBlobIndex) {
  return rows(4, [(view, p) => { u16(view, p, parentBase); u16(view, p + 2, nativeTypeBlobIndex); }]);
}

function customAttributeRow({ parentBase, typeBase, valueBlobIndex }) {
  return rows(6, [(view, p) => { u16(view, p, parentBase); u16(view, p + 2, typeBase); u16(view, p + 4, valueBlobIndex); }]);
}

function paramRows(specs) {
  return rows(6, specs.map(spec => (view, p) => {
    u16(view, p, spec.flags);
    u16(view, p + 2, spec.sequence);
    u16(view, p + 4, STR[spec.name] ?? 0);
  }));
}

function fixture({
  marshalSpec = [0x14], attributeValue, customAttribute = true, methodSignature,
  constructorSignature = [0x20, 0x00, 0x01],
  customAttributeValueIndex, fieldFlags = 0x1006, fieldMarshal, paramMarshal, params,
} = {}) {
  const rawAttributeValue = attributeValue ?? [0x01, 0x00, 0x00, 0x00];
  const blobIndex = attributeValueBlobIndex(marshalSpec);
  const constructorSignatureBlobIndex = blobIndex + 1 + rawAttributeValue.length;
  const extraRows = [
    [0x23, { count: 1, bytes: assemblyRefRows() }],
    [0x01, { count: 2, bytes: typeRefRows() }],
    [0x0a, { count: 1, bytes: memberRefRows(constructorSignatureBlobIndex) }],
  ];
  if (params) extraRows.push([0x08, { count: params.length, bytes: paramRows(params) }]);
  const marshalRows = [];
  if (fieldMarshal !== null) marshalRows.push(fieldMarshal ?? fieldMarshalRow(HAS_FIELD_MARSHAL_FIELD(1), MARSHAL_BLOB_INDEX));
  if (paramMarshal) marshalRows.push(paramMarshal);
  if (marshalRows.length) {
    extraRows.push([0x0d, { count: marshalRows.length, bytes: Uint8Array.from(marshalRows.flatMap(row => [...row])) }]);
  }
  if (customAttribute) {
    extraRows.push([0x0c, { count: 1, bytes: customAttributeRow({
      parentBase: HAS_CUSTOM_ATTRIBUTE_FIELD(1),
      typeBase: CUSTOM_ATTRIBUTE_TYPE_MEMBERREF(1),
      valueBlobIndex: customAttributeValueIndex ?? blobIndex,
    }) }]);
  }
  const built = buildCil({
    methods: [{ name: 'Run', body: [0x2a], ...(methodSignature ? { signature: methodSignature } : {}) }],
    types: [{ name: 'Holder', namespace: 'Fixture', methodList: 1, fieldList: 1 }],
    fields: [{ name: 'X', flags: fieldFlags }],
    leadingStrings: STRINGS,
    blobs: [marshalSpec, rawAttributeValue, constructorSignature],
    extraRows,
  });
  return built.bytes;
}

const project = image => JSON.stringify({
  types: image.types, fields: image.fields, methods: image.methods, methodBodies: image.methodBodies,
});
const PROBE = { supported: true, confidence: 1, formatVersion: 'pe-cli', vmSpecEdition: 'clr-v4' };

// ── #7557 FieldMarshal ─────────────────────────────────────────────────────────

{
  const image = parseCil(fixture());
  assert.equal(image.fieldMarshals.length, 1, 'FieldMarshal row must reach the canonical image');
  assert.equal(image.fieldMarshals[0].parentToken, '0x04000001');
  assert.deepEqual(image.fieldMarshals[0].parent, { table: 0x04, rid: 1, kind: 'field' });
  assert.equal(image.fieldMarshals[0].nativeTypeBlobIndex, MARSHAL_BLOB_INDEX);
  assert.deepEqual([...image.fieldMarshals[0].rawMarshalSpec], [0x14]);
  assert.deepEqual(image.fieldMarshals[0].marshalSpec, { nativeType: 0x14, nativeTypeName: 'LPSTR' });
  // The owning Field carries the descriptor too (the HasFieldMarshal flag alone
  // only proved that *some* descriptor existed).
  assert.deepEqual(image.fields[0].marshalSpec, { nativeType: 0x14, nativeTypeName: 'LPSTR' });
  assert.deepEqual([...image.fields[0].rawMarshalSpec], [0x14]);
  assert.equal(image.fields[0].fieldMarshalToken, '0x0d000001');
}

{
  // The issue's exact counterexample: identical type/field/method metadata, only
  // the MarshalSpec changes (LPStr -> LPWStr). The canonical projection must
  // differ now, and must have been identical before.
  const lpwstr = fixture({ marshalSpec: [0x15] });
  const ansi = fixture({ marshalSpec: [0x14] });
  assert.deepEqual(probeCil(lpwstr), PROBE);
  assert.deepEqual(probeCil(ansi), PROBE);
  const wide = parseCil(lpwstr, { binaryId: 'same' });
  const narrow = parseCil(ansi, { binaryId: 'same' });
  assert.equal(wide.fields[0].marshalSpec.nativeTypeName, 'LPWSTR');
  assert.equal(narrow.fields[0].marshalSpec.nativeTypeName, 'LPSTR');
  assert.notEqual(project(wide), project(narrow), 'LPSTR/LPWSTR must not collapse to one image');
  assert.notEqual(wide.fieldMarshals[0].marshalSpec.nativeType,
    narrow.fieldMarshals[0].marshalSpec.nativeType);
}

{
  // ARRAY (0x2a) MarshalSpec keeps its structured payload: element type, then
  // optional ParamNum / NumElem (II.23.4).
  const image = parseCil(fixture({ marshalSpec: [0x2a, 0x50, 0x02, 0x01] }));
  assert.deepEqual(image.fieldMarshals[0].marshalSpec, {
    nativeType: 0x2a, nativeTypeName: 'ARRAY',
    arrayElementType: 0x50, arrayElementTypeName: 'MAX', paramNum: 2, numElem: 1,
  });
}

{
  // An unknown/future native type is not dropped and not named: the raw payload
  // authority survives.
  const image = parseCil(fixture({ marshalSpec: [0x2c, 0xaa, 0xbb] }));
  const spec = image.fieldMarshals[0].marshalSpec;
  assert.equal(spec.nativeType, 0x2c);
  assert.equal(spec.nativeTypeName, null);
  assert.deepEqual([...spec.payload], [0xaa, 0xbb]);
  assert.deepEqual([...image.fieldMarshals[0].rawMarshalSpec], [0x2c, 0xaa, 0xbb]);
}

{
  // NativeType is a fixed byte (not a compressed integer): even a future enum
  // value with its high bit set must retain the exact type/payload boundary.
  const image = parseCil(fixture({ marshalSpec: [0x80, 0xaa, 0xbb] }));
  const spec = image.fieldMarshals[0].marshalSpec;
  assert.equal(spec.nativeType, 0x80);
  assert.equal(spec.nativeTypeName, null);
  assert.deepEqual([...spec.payload], [0xaa, 0xbb]);
}

{
  // A recognised intrinsic carries no payload: trailing bytes are malformed.
  assert.throws(() => parseStrict(fixture({ marshalSpec: [0x14, 0x00] })), /cil-fieldmarshal-marshal-spec-invalid/);
  // Truncated compressed ParamNum after the fixed-byte ARRAY and element type.
  assert.throws(() => parseStrict(fixture({ marshalSpec: [0x2a, 0x50, 0x80] })), /cil-fieldmarshal-marshal-spec-invalid/);
  // ARRAY with an unknown element type.
  assert.throws(() => parseStrict(fixture({ marshalSpec: [0x2a, 0x01] })), /cil-fieldmarshal-marshal-spec-invalid/);
  // ARRAY with trailing bytes beyond NumElem.
  assert.throws(() => parseStrict(fixture({ marshalSpec: [0x2a, 0x14, 0x01, 0x01, 0xff] })),
    /cil-fieldmarshal-marshal-spec-invalid/);
}

{
  // Fail-closed structural constraints (II.22.17).
  // Row without the HasFieldMarshal flag.
  assert.throws(() => parseStrict(fixture({ fieldFlags: 0x0006 })),
    /cil-fieldmarshal-field-flag-missing/);
  // Flag without a row.
  assert.throws(() => parseStrict(fixture({ fieldMarshal: null })),
    /cil-fieldmarshal-row-missing/);
  // Parent RID out of range.
  assert.throws(() => parseStrict(fixture({ fieldMarshal: fieldMarshalRow(HAS_FIELD_MARSHAL_FIELD(2), MARSHAL_BLOB_INDEX) })),
    /cil-fieldmarshal-parent-invalid/);
  // NativeType must be a valid non-null #Blob entry.
  assert.throws(() => parseStrict(fixture({ fieldMarshal: fieldMarshalRow(HAS_FIELD_MARSHAL_FIELD(1), 0) })),
    /cil-fieldmarshal-native-type-blob-invalid/);
  // Duplicate FieldMarshal rows for one Parent.
  assert.throws(() => parseStrict(fixture({
    fieldMarshal: fieldMarshalRow(HAS_FIELD_MARSHAL_FIELD(1), MARSHAL_BLOB_INDEX),
    paramMarshal: fieldMarshalRow(HAS_FIELD_MARSHAL_FIELD(1), MARSHAL_BLOB_INDEX),
  })), /cil-fieldmarshal-parent-duplicate/);
}

{
  // Param is the other legal Parent kind, and keeps its exact token.
  const image = parseCil(fixture({
    fieldFlags: 0x0006,
    fieldMarshal: null,
    methodSignature: [0x00, 0x01, 0x01, 0x08],
    params: [{ flags: 0x2000, sequence: 1, name: 'p1' }],
    paramMarshal: fieldMarshalRow(HAS_FIELD_MARSHAL_PARAM(1), MARSHAL_BLOB_INDEX),
  }));
  assert.equal(image.fieldMarshals.length, 1);
  assert.equal(image.fieldMarshals[0].parentToken, '0x08000001');
  assert.deepEqual(image.fieldMarshals[0].parent, { table: 0x08, rid: 1, kind: 'param' });
  assert.deepEqual(image.params[0].marshalSpec, { nativeType: 0x14, nativeTypeName: 'LPSTR' });
  // Flag without a row is equally invalid for a Param.
  assert.throws(() => parseStrict(fixture({
    fieldFlags: 0x0006,
    fieldMarshal: null,
    methodSignature: [0x00, 0x01, 0x01, 0x08],
    params: [{ flags: 0x0000, sequence: 1, name: 'p1' }],
    paramMarshal: fieldMarshalRow(HAS_FIELD_MARSHAL_PARAM(1), MARSHAL_BLOB_INDEX),
  })), /cil-fieldmarshal-param-flag-missing/);
  assert.throws(() => parseStrict(fixture({
    fieldFlags: 0x0006,
    methodSignature: [0x00, 0x01, 0x01, 0x08],
    params: [{ flags: 0x2000, sequence: 1, name: 'p1' }],
    fieldMarshal: null,
  })), /cil-fieldmarshal-row-missing/);
}

// ── #7556 CustomAttribute ──────────────────────────────────────────────────────

{
  const image = parseCil(fixture());
  assert.equal(image.customAttributes.length, 1);
  const attribute = image.customAttributes[0];
  assert.equal(attribute.parentToken, '0x04000001');
  assert.deepEqual(attribute.parent, { table: 0x04, rid: 1 });
  assert.equal(attribute.constructorToken, '0x0a000001');
  assert.deepEqual(attribute.constructor, {
    table: 0x0a, rid: 1, name: '.ctor', declaringType: 'System.ThreadStaticAttribute',
  });
  // The runtime-affecting attribute is recoverable by identity, so a consumer can
  // separate a thread-relative static from an ordinary process static.
  assert.equal(attribute.attributeTypeName, 'System.ThreadStaticAttribute::.ctor');
  assert.equal(attribute.prolog, 0x0001);
  assert.equal(attribute.numNamed, 0);
  assert.deepEqual([...attribute.rawValue], [0x01, 0x00, 0x00, 0x00]);
  assert.equal(typeof image.memberRefs[0].declaringTypeName, 'string');
  assert.equal(image.memberRefs[0].declaringTypeName, 'System.ThreadStaticAttribute');
}

{
  // The issue's exact counterexample: the [ThreadStatic] row must change the
  // canonical semantic projection.
  const withAttribute = parseCil(fixture({ customAttribute: true }), { binaryId: 'same' });
  const withoutAttribute = parseCil(fixture({ customAttribute: false }), { binaryId: 'same' });
  assert.equal(withoutAttribute.customAttributes.length, 0);
  assert.equal(withAttribute.fields[0].accessFlags, withoutAttribute.fields[0].accessFlags,
    'the HasCustomAttribute evidence is the row itself, not a flag');
  assert.notEqual(project(withAttribute), project(withoutAttribute));
}

{
  // The CLI's empty-blob form is valid only for constructors with no fixed
  // arguments; it cannot be used to skip signature-bound payload validation.
  const image = parseCil(fixture({ customAttributeValueIndex: 0 }));
  assert.equal(image.customAttributes[0].prolog, null);
  assert.equal(image.customAttributes[0].numNamed, 0);
  assert.equal(image.customAttributes[0].rawValue, null);
  assert.throws(() => parseStrict(fixture({
    constructorSignature: [0x20, 0x01, 0x01, 0x08],
    customAttributeValueIndex: 0,
  })), /cil-customattribute-value-invalid/);
}

{
  // Fixed Int32 arguments precede NumNamed. Reading bytes 2..3 as the count
  // would incorrectly publish 5 instead of zero for this value.
  const image = parseCil(fixture({
    constructorSignature: [0x20, 0x01, 0x01, 0x08],
    attributeValue: [0x01, 0x00, 0x05, 0x00, 0x00, 0x00, 0x00, 0x00],
  }));
  assert.equal(image.customAttributes[0].prolog, 0x0001);
  assert.equal(image.customAttributes[0].numNamed, 0);
  assert.deepEqual([...image.customAttributes[0].rawValue], [0x01, 0x00, 0x05, 0x00, 0x00, 0x00, 0x00, 0x00]);
}

{
  // A named property has its discriminator, declared type, SerString name,
  // and complete serialized value after the count.
  const image = parseCil(fixture({
    attributeValue: [0x01, 0x00, 0x01, 0x00, 0x54, 0x08, 0x01, 0x58, 0x07, 0x00, 0x00, 0x00],
  }));
  assert.equal(image.customAttributes[0].numNamed, 1);
}

{
  // MethodDef constructors are legal and keep their own token identity.
  const withMethodDefCtor = parseCil(buildCil({
    methods: [{ name: '.ctor', signature: [0x20, 0x00, 0x01], body: [0x2a] }],
    types: [{ name: 'Holder', namespace: 'Fixture', methodList: 1, fieldList: 1 }],
    fields: [{ name: 'X', flags: 0x1006 }],
    leadingStrings: STRINGS,
    blobs: [[0x14], [0x01, 0x00, 0x00, 0x00]],
    extraRows: [
      [0x0d, { count: 1, bytes: fieldMarshalRow(HAS_FIELD_MARSHAL_FIELD(1), MARSHAL_BLOB_INDEX) }],
      [0x0c, { count: 1, bytes: customAttributeRow({
        parentBase: HAS_CUSTOM_ATTRIBUTE_FIELD(1),
        typeBase: CUSTOM_ATTRIBUTE_TYPE_METHODDEF(1),
        valueBlobIndex: attributeValueBlobIndex([0x14]),
      }) }],
    ],
  }).bytes);
  assert.equal(withMethodDefCtor.customAttributes[0].constructorToken, '0x06000001');
  assert.deepEqual(withMethodDefCtor.customAttributes[0].constructor, {
    table: 0x06, rid: 1, name: '.ctor', declaringType: 'Fixture.Holder',
  });
  assert.equal(withMethodDefCtor.customAttributes[0].attributeTypeName, 'Fixture.Holder::.ctor');
}

{
  // Fail-closed structural constraints (II.22.10).
  const buildOne = (override, attributeValue = [0x01, 0x00, 0x00, 0x00]) => {
    const marshalSpec = [0x14];
    const constructorSignature = [0x20, 0x00, 0x01];
    const constructorSignatureBlobIndex = BLOB_BASE_BYTES + 1 + marshalSpec.length + 1 + attributeValue.length;
    const built = buildCil({
      methods: [{ name: 'Run', body: [0x2a] }],
      types: [{ name: 'Holder', namespace: 'Fixture', methodList: 1, fieldList: 1 }],
      fields: [{ name: 'X', flags: 0x1006 }],
      leadingStrings: STRINGS,
      blobs: [marshalSpec, attributeValue, constructorSignature],
      extraRows: [
        [0x23, { count: 1, bytes: assemblyRefRows() }],
        [0x01, { count: 2, bytes: typeRefRows() }],
        [0x0a, { count: 1, bytes: memberRefRows(constructorSignatureBlobIndex) }],
        [0x0d, { count: 1, bytes: fieldMarshalRow(HAS_FIELD_MARSHAL_FIELD(1), MARSHAL_BLOB_INDEX) }],
        [0x0c, { count: 1, bytes: customAttributeRow(override) }],
      ],
    });
    return built.bytes;
  };
  // Invalid Parent RID.
  assert.throws(() => parseStrict(buildOne({
    parentBase: HAS_CUSTOM_ATTRIBUTE_FIELD(2),
    typeBase: CUSTOM_ATTRIBUTE_TYPE_MEMBERREF(1),
    valueBlobIndex: attributeValueBlobIndex([0x14]),
  })), /cil-customattribute-parent-invalid/);
  // CustomAttributeType tag 0 / 1 / 4 address no table.
  for (const tag of [0, 1, 4]) {
    assert.throws(() => parseStrict(buildOne({
      parentBase: HAS_CUSTOM_ATTRIBUTE_FIELD(1),
      typeBase: (1 << 3) | tag,
      valueBlobIndex: attributeValueBlobIndex([0x14]),
    })), /cil-customattribute-constructor-invalid/, `tag ${tag} must be rejected`);
  }
  // Invalid constructor RID.
  assert.throws(() => parseStrict(buildOne({
    parentBase: HAS_CUSTOM_ATTRIBUTE_FIELD(1),
    typeBase: CUSTOM_ATTRIBUTE_TYPE_MEMBERREF(2),
    valueBlobIndex: attributeValueBlobIndex([0x14]),
  })), /cil-customattribute-constructor-invalid/);
  // Invalid #Blob index.
  assert.throws(() => parseStrict(buildOne({
    parentBase: HAS_CUSTOM_ATTRIBUTE_FIELD(1),
    typeBase: CUSTOM_ATTRIBUTE_TYPE_MEMBERREF(1),
    valueBlobIndex: 0x40,
  })), /cil-customattribute-value-blob-invalid/);
  // Missing/foreign prolog and truncated values are not authoritative state.
  for (const value of [[0x02, 0x00, 0x00, 0x00], [0x01, 0x00], [0x00, 0x00, 0x00, 0x00]]) {
    assert.throws(() => parseStrict(buildOne({
      parentBase: HAS_CUSTOM_ATTRIBUTE_FIELD(1),
      typeBase: CUSTOM_ATTRIBUTE_TYPE_MEMBERREF(1),
      valueBlobIndex: attributeValueBlobIndex([0x14]),
    }, value)), /cil-customattribute-value-invalid/, `value ${value.join(',')} must be rejected`);
  }
  // Fixed constructor arguments must fit before NumNamed is read.
  assert.throws(() => parseStrict(fixture({
    constructorSignature: [0x20, 0x01, 0x01, 0x08],
    attributeValue: [0x01, 0x00, 0x05, 0x00],
  })), /cil-customattribute-value-invalid/);
  // A declared named argument must include its complete serialized value.
  assert.throws(() => parseStrict(fixture({
    attributeValue: [0x01, 0x00, 0x01, 0x00, 0x54, 0x08, 0x01, 0x58, 0x07, 0x00, 0x00],
  })), /cil-customattribute-value-invalid/);
  // A static method cannot serve as a custom attribute constructor.
  assert.throws(() => parseStrict(fixture({
    constructorSignature: [0x00, 0x00, 0x01],
  })), /cil-customattribute-constructor-signature-invalid/);
}

console.log('issue #7557/#7556 FieldMarshal + CustomAttribute canonical authority: ok');
