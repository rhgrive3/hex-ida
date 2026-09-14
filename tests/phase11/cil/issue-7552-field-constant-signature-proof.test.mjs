import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCil } from '../../../js/managed/cil/parser.js';
import { buildCil } from '../fixtures/medium-cil.mjs';

function constantRow(type = 0x08, valueIndex = 8) {
  // Constant: Type, padding, HasConstant(Field #1 => 1 << 2), #Blob index.
  return Uint8Array.of(type, 0x00, 0x04, 0x00, valueIndex & 0xff, valueIndex >>> 8);
}

function fixture({ signature = [0x06, 0x08], constantType = 0x08, value = [42, 0, 0, 0], patchSignatureIndex = null } = {}) {
  // options.blobs are appended before Field signatures, so the Constant value
  // lives at #Blob index 8. The FieldSig is appended later by the fixture builder.
  const built = buildCil({
    fields: [{ name: 'Answer', flags: 0x8056, signature }],
    blobs: [value],
    extraRows: [[0x0b, { count: 1, bytes: constantRow(constantType, 8) }]],
  });
  if (patchSignatureIndex != null) {
    const tablesStream = built.layout.streams.find(stream => stream.name === '#~');
    const fieldRow = tablesStream.offset + built.layout.tables.offsets.get(0x04);
    new DataView(built.bytes.buffer).setUint16(fieldRow + 4, patchSignatureIndex, true);
  }
  return built.bytes;
}

function assertRejects(bytes, expected) {
  assert.throws(() => parseCil(bytes), error => {
    const text = String(error?.message ?? error);
    return expected.some(code => text.includes(code)) || text.includes('cil-unsupported-binary');
  });
}

test('#7552 Field Constant requires a nonzero provable FieldSig', () => {
  assertRejects(fixture({ patchSignatureIndex: 0 }), [
    'cil-constant-parent-type-unprovable',
  ]);
});

test('#7552 Field Constant rejects an out-of-range FieldSig blob index', () => {
  assertRejects(fixture({ patchSignatureIndex: 0xffff }), [
    'cil-field-signature-blob-invalid',
  ]);
});

test('#7552 Field Constant rejects a malformed FieldSig', () => {
  assertRejects(fixture({ signature: [0x07, 0x08] }), [
    'cil-field-signature-invalid',
  ]);
});

test('#7552 valid I4 FieldSig still publishes its matching I4 Constant', () => {
  const image = parseCil(fixture());
  assert.deepEqual(image.fields[0].constant, { type: 'int32', value: 42 });
  assert.deepEqual(image.constants[0], {
    token: '0x0b000001',
    parent: '0x04000001',
    type: 'int32',
    value: 42,
  });
});


test('#7552 Field Constant rejects truncated CLASS FieldSig payload', () => {
  assertRejects(fixture({
    signature: [0x06, 0x12],
    constantType: 0x12,
    value: [0, 0, 0, 0],
  }), ['cil-field-signature-invalid']);
});

test('#7552 Field Constant rejects trailing bytes after a complete FieldSig Type', () => {
  assertRejects(fixture({ signature: [0x06, 0x08, 0x00] }), [
    'cil-field-signature-invalid',
  ]);
});

test('#7552 valid CLASS FieldSig still publishes CLASS null Constant', () => {
  const image = parseCil(fixture({
    signature: [0x06, 0x12, 0x04], // FIELD CLASS TypeDef #1
    constantType: 0x12,
    value: [0, 0, 0, 0],
  }));
  assert.deepEqual(image.fields[0].constant, { type: 'class', value: null });
});
