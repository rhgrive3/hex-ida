
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

test('#5209 enum descriptor supports empty-only cases', async () => {
  const descriptor = await parseSwiftNominalDescriptor(
    readerFor(buildEnumBytes({ payloadCasesAndOffset: 0x00000000, emptyCases: 7 })), HEADER);
  assert.equal(descriptor?.kind, 'enum');
  assert.equal(descriptor?.numPayloadCases, 0);
  assert.equal(descriptor?.payloadSizeOffset, 0);
  assert.equal(descriptor?.numEmptyCases, 7);
  assert.equal(descriptor?.numCases, 7);
});

test('#5209 enum descriptor supports payload-only cases', async () => {
  const descriptor = await parseSwiftNominalDescriptor(
    readerFor(buildEnumBytes({ payloadCasesAndOffset: 0x01000009, emptyCases: 0 })), HEADER);
  assert.equal(descriptor?.kind, 'enum');
  assert.equal(descriptor?.numPayloadCases, 9);
  assert.equal(descriptor?.payloadSizeOffset, 1);
  assert.equal(descriptor?.numEmptyCases, 0);
  assert.equal(descriptor?.numCases, 9);
});

test('#5209 payload size offset preserves packed high-byte boundaries', async () => {
  const low = await parseSwiftNominalDescriptor(
    readerFor(buildEnumBytes({ payloadCasesAndOffset: 0x00000001, emptyCases: 0 })), HEADER);
  const high = await parseSwiftNominalDescriptor(
    readerFor(buildEnumBytes({ payloadCasesAndOffset: 0xff000001, emptyCases: 0 })), HEADER);
  assert.equal(low?.numPayloadCases, 1);
  assert.equal(low?.payloadSizeOffset, 0);
  assert.equal(high?.numPayloadCases, 1);
  assert.equal(high?.payloadSizeOffset, 255);
});

test('#5209 class descriptors keep their existing class tail semantics', async () => {
  const mem = new DataView(new ArrayBuffer(0x400));
  const put32 = (offset, value) => mem.setUint32(offset, value, true);
  const putI32 = (offset, value) => mem.setInt32(offset, value, true);
  put32(HEADER, 0x10);                      // context kind 16 = class
  putI32(HEADER + 4, 0);
  putI32(HEADER + 8, NAME - (HEADER + 8));
  putI32(HEADER + 12, 0);
  putI32(HEADER + 16, 0);
  putI32(HEADER + 20, 0);                   // superclassType
  put32(HEADER + 24, 2);                    // metadataNegativeSizeInWords
  put32(HEADER + 28, 6);                    // metadataPositiveSizeInWords
  put32(HEADER + 32, 3);                    // numImmediateMembers
  put32(HEADER + 36, 4);                    // numFields
  put32(HEADER + 40, 9);                    // fieldOffsetVectorOffset
  mem.setUint8(NAME, 0x43);                 // 'C'
  for (let i = NAME + 1; i < 0x200; i++) mem.setUint8(i, 0x41);
  mem.setUint8(0x200, 0);
  const descriptor = await parseSwiftNominalDescriptor(readerFor(new Uint8Array(mem.buffer)), HEADER);
  assert.equal(descriptor?.kind, 'class');
  assert.equal(descriptor?.superclassType, null);
  assert.equal(descriptor?.metadataNegativeSizeInWords, 2);
  assert.equal(descriptor?.metadataPositiveSizeInWords, 6);
  assert.equal(descriptor?.numImmediateMembers, 3);
  assert.equal(descriptor?.numFields, 4);
  assert.equal(descriptor?.fieldOffsetVectorOffset, 9);
  assert.equal(descriptor?.numPayloadCases, undefined);
});
