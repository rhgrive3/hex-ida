import assert from 'node:assert/strict';
import test from 'node:test';
import { bindCilMetadataTables } from '../../../js/managed/cil/metadata-definitions.js';

function blobHeap(...blobs) {
  const bytes = [0];
  const indexes = [];
  for (const blob of blobs) {
    assert.ok(blob.length < 0x80, 'fixture only uses one-byte compressed lengths');
    indexes.push(bytes.length);
    bytes.push(blob.length, ...blob);
  }
  return { heap: new Uint8Array(bytes), indexes };
}

function defs({ typeFlags = 0x11, fieldFlags = 0, signatureBlobIndex = 0, constants = [], fieldLayouts = [], classLayouts = [], methods = [], params = [], properties = [] } = {}) {
  return {
    types: [{ token: '0x02000001', accessFlags: typeFlags }],
    fields: [{
      token: '0x04000001',
      accessFlags: fieldFlags,
      declaringTypeToken: '0x02000001',
      signatureBlobIndex,
    }],
    methods,
    params,
    properties,
    constants,
    classLayouts,
    fieldLayouts,
    nestedClasses: [],
  };
}

function paramConstant(type, valueIndex, rid = 1) {
  return {
    token: '0x0b000001',
    type,
    parent: { table: 0x08, rid, token: `0x0800000${rid}` },
    valueIndex,
  };
}

function propertyConstant(type, valueIndex, rid = 1) {
  return {
    token: '0x0b000001',
    type,
    parent: { table: 0x17, rid, token: `0x1700000${rid}` },
    valueIndex,
  };
}

function fieldConstant(type, valueIndex) {
  return {
    token: '0x0b000001',
    type,
    parent: { table: 0x04, rid: 1, token: '0x04000001' },
    valueIndex,
  };
}

test('#7552 rejects I4 constants for OBJECT and CLASS fields', () => {
  for (const declared of [0x1c, 0x12]) {
    const { heap, indexes } = blobHeap([0x06, declared], [42, 0, 0, 0]);
    assert.throws(
      () => bindCilMetadataTables(defs({
        signatureBlobIndex: indexes[0],
        constants: [fieldConstant(0x08, indexes[1])],
      }), heap),
      /cil-constant-type-mismatch/,
    );
  }
});

test('#7552 keeps the CLASS null-reference control for reference fields', () => {
  for (const declared of [0x12, 0x1c]) {
    const { heap, indexes } = blobHeap([0x06, declared], [0, 0, 0, 0]);
    const result = bindCilMetadataTables(defs({
      signatureBlobIndex: indexes[0],
      constants: [fieldConstant(0x12, indexes[1])],
    }), heap);
    assert.deepEqual(result.fields[0].constant, { type: 'class', value: null });
  }
});

test('#7553 rejects FieldLayout on SequentialLayout owners', () => {
  assert.throws(
    () => bindCilMetadataTables(defs({
      typeFlags: 0x09,
      fieldLayouts: [{ field: 1, offset: 16 }],
    }), new Uint8Array([0])),
    /cil-class-layout-flags-contradiction/,
  );
});

test('#7553 rejects FieldLayout on static fields', () => {
  assert.throws(
    () => bindCilMetadataTables(defs({
      typeFlags: 0x11,
      fieldFlags: 0x10,
      fieldLayouts: [{ field: 1, offset: 16 }],
    }), new Uint8Array([0])),
    /cil-field-layout-static-field/,
  );
});

test('#7553 keeps ExplicitLayout non-static FieldLayout publishable', () => {
  const result = bindCilMetadataTables(defs({
    typeFlags: 0x11,
    fieldFlags: 0,
    fieldLayouts: [{ field: 1, offset: 16 }],
  }), new Uint8Array([0]));
  assert.equal(result.fields[0].offset, 16);
});

test('#7552 a STRING property cannot carry an I4 constant', () => {
  // PropertySig 08 00 0e (PROPERTY, 0 params, STRING) with a Constant row
  // claiming ELEMENT_TYPE_I4: the declared type is canonical authority, so
  // the mismatch must fail closed (#7552 R0 review).
  const { heap, indexes } = blobHeap([0x08, 0x00, 0x0e], [42, 0, 0, 0]);
  assert.throws(
    () => bindCilMetadataTables(defs({
      properties: [{ token: '0x17000001', typeBlobIndex: indexes[0] }],
      constants: [propertyConstant(0x08, indexes[1])],
    }), heap),
    /cil-constant-type-mismatch/,
  );
});

test('#7552 a STRING property keeps its STRING constant', () => {
  const { heap, indexes } = blobHeap([0x08, 0x00, 0x0e], [1, 0]);
  const result = bindCilMetadataTables(defs({
    properties: [{ token: '0x17000001', typeBlobIndex: indexes[0] }],
    constants: [propertyConstant(0x0e, indexes[1])],
  }), heap);
  assert.deepEqual(result.constants[0].type, 'string');
});

test('#7552 an I4 parameter cannot carry an I8 constant', () => {
  // MethodSig 00 01 08 08 (static, 1 param, I4 ret, I4 param) with a
  // Constant row claiming ELEMENT_TYPE_I8 on sequence 1 (#7552 R0 review).
  const { heap, indexes } = blobHeap([0x00, 0x01, 0x08, 0x08], [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.throws(
    () => bindCilMetadataTables(defs({
      methods: [{ token: '0x06000001', signatureBlobIndex: indexes[0] }],
      params: [{ token: '0x08000001', ownerToken: '0x06000001', sequence: 1 }],
      constants: [paramConstant(0x0a, indexes[1])],
    }), heap),
    /cil-constant-type-mismatch/,
  );
});

test('#7552 an I4 parameter keeps its I4 constant', () => {
  const { heap, indexes } = blobHeap([0x00, 0x01, 0x08, 0x08], [42, 0, 0, 0]);
  const result = bindCilMetadataTables(defs({
    methods: [{ token: '0x06000001', signatureBlobIndex: indexes[0] }],
    params: [{ token: '0x08000001', ownerToken: '0x06000001', sequence: 1 }],
    constants: [paramConstant(0x08, indexes[1])],
  }), heap);
  assert.deepEqual(result.constants[0].type, 'int32');
});

test('#7552 an unprovable parent type fails closed without minting authority', () => {
  // VALUETYPE-typed property: no enum-underlying proof exists in the row set,
  // so the constant cannot be typed and must fail closed.
  const { heap, indexes } = blobHeap([0x08, 0x00, 0x11, 0x04], [42, 0, 0, 0]);
  assert.throws(
    () => bindCilMetadataTables(defs({
      properties: [{ token: '0x17000001', typeBlobIndex: indexes[0] }],
      constants: [propertyConstant(0x08, indexes[1])],
    }), heap),
    /cil-constant-parent-type-unprovable/,
  );
});

test('#7552 an OBJECT property cannot carry a STRING constant', () => {
  // R2 blocker: PropertySig 08 00 1c (PROPERTY, 0 params, OBJECT) with a
  // Constant row claiming ELEMENT_TYPE_STRING — the decoded shape collapses
  // STRING and OBJECT into one identity-less object-ref, so the exact
  // ELEMENT_TYPE byte is the declared identity and the mismatch must fail
  // closed (#7552 R2 review).
  const { heap, indexes } = blobHeap([0x08, 0x00, 0x1c], [72, 0, 105, 0]);
  assert.throws(
    () => bindCilMetadataTables(defs({
      properties: [{ token: '0x17000001', typeBlobIndex: indexes[0] }],
      constants: [propertyConstant(0x0e, indexes[1])],
    }), heap),
    /cil-constant-type-mismatch/,
  );
});

test('#7552 an OBJECT parameter cannot carry a STRING constant', () => {
  // MethodSig 00 01 08 1c (static, 1 param, I4 ret, OBJECT param) with a
  // Constant row claiming ELEMENT_TYPE_STRING on sequence 1 (#7552 R2).
  const { heap, indexes } = blobHeap([0x00, 0x01, 0x08, 0x1c], [72, 0, 105, 0]);
  assert.throws(
    () => bindCilMetadataTables(defs({
      methods: [{ token: '0x06000001', signatureBlobIndex: indexes[0] }],
      params: [{ token: '0x08000001', ownerToken: '0x06000001', sequence: 1 }],
      constants: [paramConstant(0x0e, indexes[1])],
    }), heap),
    /cil-constant-type-mismatch/,
  );
});

test('#7552 an OBJECT property keeps its CLASS null-reference constant', () => {
  const { heap, indexes } = blobHeap([0x08, 0x00, 0x1c], [0, 0, 0, 0]);
  const result = bindCilMetadataTables(defs({
    properties: [{ token: '0x17000001', typeBlobIndex: indexes[0] }],
    constants: [propertyConstant(0x12, indexes[1])],
  }), heap);
  assert.deepEqual(result.constants[0].type, 'class');
  assert.deepEqual(result.constants[0].value, null);
});

test('#7552 an OBJECT parameter keeps its CLASS null-reference constant', () => {
  const { heap, indexes } = blobHeap([0x00, 0x01, 0x08, 0x1c], [0, 0, 0, 0]);
  const result = bindCilMetadataTables(defs({
    methods: [{ token: '0x06000001', signatureBlobIndex: indexes[0] }],
    params: [{ token: '0x08000001', ownerToken: '0x06000001', sequence: 1 }],
    constants: [paramConstant(0x12, indexes[1])],
  }), heap);
  assert.deepEqual(result.constants[0].type, 'class');
  assert.deepEqual(result.constants[0].value, null);
});

test('#7552 a STRING parameter keeps its STRING constant', () => {
  // Valid control: MethodSig 00 01 08 0e (static, 1 param, I4 ret, STRING
  // param) with a matching STRING Constant row (#7552 R2).
  const { heap, indexes } = blobHeap([0x00, 0x01, 0x08, 0x0e], [72, 0, 105, 0]);
  const result = bindCilMetadataTables(defs({
    methods: [{ token: '0x06000001', signatureBlobIndex: indexes[0] }],
    params: [{ token: '0x08000001', ownerToken: '0x06000001', sequence: 1 }],
    constants: [paramConstant(0x0e, indexes[1])],
  }), heap);
  assert.deepEqual(result.constants[0].type, 'string');
  assert.deepEqual(result.constants[0].value, 'Hi');
});

test('#7553 the reserved Sequential|Explicit mask 0x18 fails closed', () => {
  const { heap } = blobHeap([0x00]);
  assert.throws(
    () => bindCilMetadataTables(defs({
      typeFlags: 0x18,
      classLayouts: [{ parent: 1, packingSize: 8, classSize: 16 }],
    }), heap),
    /cil-class-layout-flags-contradiction/,
  );
  assert.throws(
    () => bindCilMetadataTables(defs({
      typeFlags: 0x18,
      fieldFlags: 0,
      fieldLayouts: [{ field: 1, offset: 16 }],
    }), heap),
    /cil-class-layout-flags-contradiction/,
  );
});
