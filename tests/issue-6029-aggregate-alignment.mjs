import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyDarwinArm64Arguments } from '../js/targets/abi/darwin-arm64.js';

function s16() {
  return {
    aggregate: true,
    bits: 128,
    bytes: 16,
    members: Array.from({ length: 16 }, (_, i) => ({ bits: 8, bytes: 1, byteOffset: i, alignmentBytes: 1 })),
  };
}

test('6029: char-array struct is not 16-aligned by size', () => {
  const args = [
    ...Array.from({ length: 8 }, () => ({ type: 'unsigned long', bits: 64 })),
    { type: 'unsigned char', bits: 8 },
    s16(),
    { type: 'unsigned char', bits: 8 },
  ];
  const result = classifyDarwinArm64Arguments({ callPrototype: { args } });
  const [lead, s, tail] = result.arguments.slice(8);
  assert.equal(lead.offset, 0);
  assert.equal(s.offset, 8);
  assert.equal(tail.offset, 24);
});

test('6029: explicit alignment metadata is still honored', () => {
  const args = [
    ...Array.from({ length: 8 }, () => ({ type: 'unsigned long', bits: 64 })),
    { type: 'unsigned char', bits: 8 },
    { ...s16(), alignmentBytes: 16 },
  ];
  const result = classifyDarwinArm64Arguments({ callPrototype: { args } });
  assert.equal(result.arguments[9].offset, 16);
});

test('6029: 16-byte scalar keeps 16-byte alignment', () => {
  const args = [
    ...Array.from({ length: 8 }, () => ({ type: 'unsigned long', bits: 64 })),
    { type: 'unsigned __int128', bits: 128 },
  ];
  const result = classifyDarwinArm64Arguments({ callPrototype: { args } });
  assert.equal(result.arguments[8].offset, 0);
});

test('6029: an unannotated wide member cannot mint exact aggregate alignment', () => {
  const vectorAggregate = {
    aggregate: true,
    bits: 128,
    bytes: 16,
    members: [{ type: 'vector', bits: 128, bytes: 16, byteOffset: 0 }],
  };
  const args = [
    ...Array.from({ length: 8 }, () => ({ type: 'unsigned long', bits: 64 })),
    { type: 'unsigned char', bits: 8 },
    vectorAggregate,
  ];
  const result = classifyDarwinArm64Arguments({ callPrototype: { args } });
  const aggregate = result.arguments[9];
  assert.equal(result.partial, true);
  assert.equal(aggregate.location, 'unknown');
  assert.equal(aggregate.possible, true);
  assert.equal(aggregate.mustUse, false);
  assert.equal(aggregate.reason, 'darwin-arm64-aggregate-alignment-not-proven');
});


test('6029: an unannotated aggregate without alignment evidence is partial', () => {
  const unknownAlignment = {
    aggregate: true,
    bits: 128,
    bytes: 16,
    members: [
      { type: 'unsigned long', bits: 64, bytes: 8, byteOffset: 0 },
      { type: 'unsigned long', bits: 64, bytes: 8, byteOffset: 8 },
    ],
  };
  const args = [
    ...Array.from({ length: 8 }, () => ({ type: 'unsigned long', bits: 64 })),
    { type: 'unsigned char', bits: 8 },
    unknownAlignment,
  ];
  const result = classifyDarwinArm64Arguments({ callPrototype: { args } });
  const aggregate = result.arguments[9];
  assert.equal(result.partial, true);
  assert.equal(aggregate.location, 'unknown');
  assert.equal(aggregate.possible, true);
  assert.equal(aggregate.mustUse, false);
  assert.equal(aggregate.reason, 'darwin-arm64-aggregate-alignment-not-proven');
});