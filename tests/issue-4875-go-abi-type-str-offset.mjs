import assert from 'node:assert/strict';
import { parseGoTypeDescriptor } from '../js/metadata/go.js';

const TYPES_BASE = 128;
const REAL_NAME = 'MyInt';
const DECOY_NAME = 'Decoy';
const REAL_NAME_OFF = 4;
const DECOY_NAME_OFF = 64;

function currentAbiTypeFieldOffsets(ptrSize) {
  const afterKind = ptrSize * 2 + 8;
  return {
    size: 0,
    ptrdata: ptrSize,
    hash: ptrSize * 2,
    tflag: ptrSize * 2 + 4,
    align: ptrSize * 2 + 5,
    fieldAlign: ptrSize * 2 + 6,
    kind: ptrSize * 2 + 7,
    equal: afterKind,
    gcdata: afterKind + ptrSize,
    str: afterKind + ptrSize * 2,
    ptrToThis: afterKind + ptrSize * 2 + 4,
    headerBytes: afterKind + ptrSize * 2 + 8,
  };
}

function writeNameRecord(buf, off, name) {
  const bytes = new TextEncoder().encode(name);
  buf[off] = 0;
  buf[off + 1] = bytes.length;
  buf.set(bytes, off + 2);
}

function buildType({ ptrSize, equalValue = DECOY_NAME_OFF, gcdataValue = 0 }) {
  const field = currentAbiTypeFieldOffsets(ptrSize);
  assert.equal(field.str, ptrSize === 8 ? 40 : 24);
  assert.equal(field.headerBytes, ptrSize === 8 ? 48 : 32);
  const buf = new Uint8Array(field.headerBytes + TYPES_BASE + DECOY_NAME_OFF + 16);
  const dv = new DataView(buf.buffer);
  const putPtr = (off, value) => {
    if (ptrSize === 4) dv.setUint32(off, value, true);
    else dv.setBigUint64(off, BigInt(value), true);
  };

  putPtr(field.size, 8);
  putPtr(field.ptrdata, 0);
  putPtr(field.equal, equalValue);
  putPtr(field.gcdata, gcdataValue);
  dv.setUint32(field.hash, 0x12345678, true);
  dv.setInt32(field.str, REAL_NAME_OFF, true);
  dv.setInt32(field.ptrToThis, 0, true);
  buf[field.tflag] = 2;
  buf[field.align] = ptrSize;
  buf[field.fieldAlign] = ptrSize;
  buf[field.kind] = 2;

  writeNameRecord(buf, TYPES_BASE + REAL_NAME_OFF, REAL_NAME);
  writeNameRecord(buf, TYPES_BASE + DECOY_NAME_OFF, DECOY_NAME);
  return buf;
}

const current64 = buildType({ ptrSize: 8 });
const current32 = buildType({ ptrSize: 4 });

function nameOf(buf, options) {
  return parseGoTypeDescriptor(buf, 0, options)?.name;
}

assert.equal(
  nameOf(current64, { ptrSize: 8, little: true, typesBase: TYPES_BASE }),
  REAL_NAME,
  '64-bit Str (NameOff) must be read at +40, after Equal and GCData',
);
assert.equal(
  nameOf(current32, { ptrSize: 4, little: true, typesBase: TYPES_BASE }),
  REAL_NAME,
  '32-bit Str (NameOff) must be read at +24, after Equal and GCData',
);
assert.equal(
  nameOf(current64, { ptrSize: 8, little: true, typesBase: TYPES_BASE, version: '1.20+' }),
  REAL_NAME,
);
assert.equal(
  nameOf(current32, { ptrSize: 4, little: true, typesBase: TYPES_BASE, version: '1.16' }),
  REAL_NAME,
);

for (const ptrSize of [8, 4]) {
  const both = buildType({ ptrSize, equalValue: DECOY_NAME_OFF, gcdataValue: DECOY_NAME_OFF });
  assert.equal(
    nameOf(both, { ptrSize, little: true, typesBase: TYPES_BASE }),
    REAL_NAME,
    'Equal and GCData contents must never be reinterpreted as NameOff',
  );
  assert.notEqual(nameOf(both, { ptrSize, little: true, typesBase: TYPES_BASE }), DECOY_NAME);
}

const desc64 = parseGoTypeDescriptor(current64, 0, { ptrSize: 8, little: true, typesBase: TYPES_BASE });
assert.equal(desc64.kind, 'int');
assert.equal(desc64.size, 8);
assert.equal(desc64.ptrdata, 0);
assert.equal(desc64.hash, 0x12345678);
assert.equal(desc64.align, 8);
assert.equal(desc64.fieldAlign, 8);

assert.equal(
  parseGoTypeDescriptor(current64.subarray(0, 40), 0, { ptrSize: 8, little: true, typesBase: TYPES_BASE }),
  null,
  'a 64-bit header shorter than 48 bytes cannot carry Str/PtrToThis and must fail closed',
);
assert.equal(
  parseGoTypeDescriptor(current32.subarray(0, 24), 0, { ptrSize: 4, little: true, typesBase: TYPES_BASE }),
  null,
  'a 32-bit header shorter than 32 bytes cannot carry Str/PtrToThis and must fail closed',
);
assert.notEqual(
  parseGoTypeDescriptor(current64.subarray(0, 48), 0, { ptrSize: 8, little: true }),
  null,
  'the exact current-layout 64-bit header length must stay accepted',
);
assert.notEqual(
  parseGoTypeDescriptor(current32.subarray(0, 32), 0, { ptrSize: 4, little: true }),
  null,
  'the exact current-layout 32-bit header length must stay accepted',
);
assert.ok(
  nameOf(current64.subarray(0, 48), { ptrSize: 8, little: true }).startsWith('go_type_int_'),
  'without a types base the descriptor keeps its explicit synthetic name',
);

assert.equal(
  parseGoTypeDescriptor(current64, 0, { ptrSize: 8, little: true, typesBase: TYPES_BASE, version: '1.2' }),
  null,
  'Go 1.2 uses a different _type layout and must fail closed instead of guessing offsets',
);
assert.equal(
  parseGoTypeDescriptor(current64, 0, { ptrSize: 8, little: true, typesBase: TYPES_BASE, version: 'constructor' }),
  null,
  'inherited Object.prototype keys must not resolve a layout',
);
assert.equal(
  parseGoTypeDescriptor(current64, 0, { ptrSize: 8, little: true, typesBase: TYPES_BASE, version: 1.2 }),
  null,
  'a non-string version token must fail closed',
);

console.log('issue #4875 Go abi.Type Str name offset regression passed');
