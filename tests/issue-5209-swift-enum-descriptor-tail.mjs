
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseSwiftNominalDescriptor } from '../js/swift.js';

// #5209: EnumDescriptor tails are not StructDescriptor tails. Per the Swift
// runtime Metadata.h layout, the two words after the common nominal
// descriptor header are NumPayloadCasesAndPayloadSizeOffset (low 24 bits =
// payload case count, high 8 bits = payload size offset word) and
// NumEmptyCases. Decoding them as struct NumFields/FieldOffsetVectorOffset
// deterministically misread every valid enum descriptor.

const HEADER = 0x40;
const NAME = 0x80;

function buildEnumBytes({ payloadCasesAndOffset, emptyCases }) {
  const mem = new DataView(new ArrayBuffer(0x400));
  const put32 = (offset, value) => mem.setUint32(offset, value, true);
  const putI32 = (offset, value) => mem.setInt32(offset, value, true);
  put32(HEADER, 0x12);                      // context kind 18 = enum
  putI32(HEADER + 4, 0);                    // parent
  putI32(HEADER + 8, NAME - (HEADER + 8));  // name relative pointer
  putI32(HEADER + 12, 0);                   // metadata accessor
  putI32(HEADER + 16, 0);                   // field descriptor
  put32(HEADER + 20, payloadCasesAndOffset);
  put32(HEADER + 24, emptyCases);
  mem.setUint8(NAME, 0x45);                 // 'E'
  for (let i = NAME + 1; i < 0x200; i++) mem.setUint8(i, 0x41);
  mem.setUint8(0x200, 0);                   // cstring needs a terminator in range
  return new Uint8Array(mem.buffer);
}

function readerFor(bytes) {
  return async (address, length) => {
    const at = Number(address);
    if (at < 0 || at + length > bytes.length) return null;
    return bytes.subarray(at, at + length);
  };
}

test('#5209 enum descriptor decodes payload cases, payload size offset and empty cases per ABI', async () => {
  const descriptor = await parseSwiftNominalDescriptor(
    readerFor(buildEnumBytes({ payloadCasesAndOffset: 0x02000003, emptyCases: 5 })), HEADER);
  assert.ok(descriptor, 'a valid enum descriptor must parse');
  assert.equal(descriptor.kind, 'enum');
  assert.equal(descriptor.numPayloadCases, 3);
  assert.equal(descriptor.payloadSizeOffset, 2);
  assert.equal(descriptor.numEmptyCases, 5);
  assert.equal(descriptor.numCases, 8);
  assert.equal(descriptor.numFields, undefined,
    'enum descriptors must not grow struct NumFields semantics');
  assert.equal(descriptor.fieldOffsetVectorOffset, undefined,
    'enum descriptors must not grow struct FieldOffsetVectorOffset semantics');
});

test('#5209 a 24-bit-saturating payload count no longer becomes a huge numFields', async () => {
  const descriptor = await parseSwiftNominalDescriptor(
    readerFor(buildEnumBytes({ payloadCasesAndOffset: 0x02000003, emptyCases: 5 })), HEADER);
  assert.notEqual(descriptor?.numFields, 33554435,
    'the packed payload word must not surface as a struct field count');
});

test('#5209 struct descriptors keep their NumFields/FieldOffsetVectorOffset tail', async () => {
  const mem = new DataView(new ArrayBuffer(0x400));
  const put32 = (offset, value) => mem.setUint32(offset, value, true);
  const putI32 = (offset, value) => mem.setInt32(offset, value, true);
  put32(HEADER, 0x11);                      // context kind 17 = struct
  putI32(HEADER + 4, 0);
  putI32(HEADER + 8, NAME - (HEADER + 8));
  putI32(HEADER + 12, 0);
  putI32(HEADER + 16, 0);
  put32(HEADER + 20, 4);                    // NumFields
  put32(HEADER + 24, 8);                    // FieldOffsetVectorOffset
  mem.setUint8(NAME, 0x53);                 // 'S'
  for (let i = NAME + 1; i < 0x200; i++) mem.setUint8(i, 0x41);
  mem.setUint8(0x200, 0);
  const descriptor = await parseSwiftNominalDescriptor(readerFor(new Uint8Array(mem.buffer)), HEADER);
  assert.equal(descriptor?.kind, 'struct');
  assert.equal(descriptor?.numFields, 4);
  assert.equal(descriptor?.fieldOffsetVectorOffset, 8);
  assert.equal(descriptor?.numPayloadCases, undefined);
});
