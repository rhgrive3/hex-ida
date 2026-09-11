import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyDarwinArm64Arguments } from '../../../js/targets/abi/darwin-arm64.js';

const EXHAUSTED_BANKS = [
  ...Array.from({ length:8 }, () => ({ type:'float' })),
  ...Array.from({ length:8 }, () => ({ type:'long' })),
];

const FLOAT_HFA4_MEMBERS = [
  { bits:32, bytes:4, byteOffset:0 },
  { bits:32, bytes:4, byteOffset:4 },
  { bits:32, bytes:4, byteOffset:8 },
  { bits:32, bytes:4, byteOffset:12 },
];

function floatHfa4(overrides = {}) {
  return {
    type:'float[4]', hfa:true, bits:128, bytes:16,
    members:FLOAT_HFA4_MEMBERS,
    ...overrides,
  };
}

function classify(args) {
  return classifyDarwinArm64Arguments({ callPrototype:{ args } });
}

test('#7348 scalar and homogeneous arguments classify without missing explicit-alignment authority', () => {
  const scalar = classify([{ type:'unsigned long', bits:64 }, floatHfa4()]);
  assert.equal(scalar.arguments[0].location, 'register');
  assert.equal(scalar.arguments[1].abiClass, 'hfa');
  assert.deepEqual(scalar.arguments[1].regs, ['v0', 'v1', 'v2', 'v3']);
});

test('#7348 direct aggregate alignment remains distinct from inferred member alignment', () => {
  const members = Array.from({ length:16 }, (_, byteOffset) => ({
    bits:8, bytes:1, byteOffset, alignmentBytes:1,
  }));
  const explicit = classify([
    ...Array.from({ length:8 }, () => ({ type:'unsigned long', bits:64 })),
    { type:'unsigned char', bits:8 },
    { type:'char-array', aggregate:true, bits:128, bytes:16, alignmentBytes:16, members },
  ]);
  const inferred = classify([
    ...Array.from({ length:8 }, () => ({ type:'unsigned long', bits:64 })),
    { type:'unsigned char', bits:8 },
    { type:'char-array', aggregate:true, bits:128, bytes:16, members },
  ]);

  assert.equal(explicit.arguments[9].offset, 16);
  assert.equal(explicit.arguments[9].alignmentBytes, 16);
  assert.equal(inferred.arguments[9].offset, 8);
  assert.equal(inferred.arguments[9].alignmentBytes, 8);
});

test('#7348 an explicitly over-aligned spilled float HFA keeps compact member spacing', () => {
  const result = classify([
    ...EXHAUSTED_BANKS,
    { type:'float', bits:32, bytes:4, alignmentBytes:4 },
    floatHfa4({ alignmentBytes:16 }),
    { type:'unsigned char', bits:8 },
  ]);
  const entry = result.stackArguments.find((argument) => argument?.index === 17);
  const tail = result.stackArguments.find((argument) => argument?.index === 18);

  assert.ok(entry && tail);
  assert.equal(entry.offset, 16);
  assert.equal(entry.alignmentBytes, 16);
  assert.deepEqual(entry.pieces.map((piece) => piece.stackOffset), [16, 20, 24, 28]);
  assert.deepEqual(entry.pieces.map((piece) => piece.byteOffset), [0, 4, 8, 12]);
  assert.equal(tail.offset, 32);
});

test('#7348 an HFA without explicit alignment keeps compact element-sized slots', () => {
  const result = classify([
    ...EXHAUSTED_BANKS,
    { type:'float', bits:32, bytes:4, alignmentBytes:4 },
    floatHfa4(),
    { type:'unsigned char', bits:8 },
  ]);
  const entry = result.stackArguments.find((argument) => argument?.index === 17);
  const tail = result.stackArguments.find((argument) => argument?.index === 18);

  assert.ok(entry && tail);
  assert.equal(entry.offset, 4);
  assert.equal(entry.alignmentBytes, 4);
  assert.equal(entry.bytes, 16);
  assert.deepEqual(entry.pieces.map((piece) => piece.stackOffset), [4, 8, 12, 16]);
  assert.equal(tail.offset, 20);
});

test('#7348 invalid direct alignment metadata never becomes explicit authority', () => {
  // Numeric-looking structured values are metadata, not numeric authority.
  for (const alignmentBytes of [0, -16, 1.5, Number.MAX_SAFE_INTEGER + 1, 'not-an-alignment', '16', ['16'], new Number(16)]) {
    const result = classify([
      ...EXHAUSTED_BANKS,
      { type:'float', bits:32, bytes:4, alignmentBytes:4 },
      floatHfa4({ alignmentBytes }),
      { type:'unsigned char', bits:8 },
    ]);
    const entry = result.stackArguments.find((argument) => argument?.index === 17);
    assert.ok(entry, `invalid alignment ${String(alignmentBytes)} must still classify`);
    assert.equal(entry.offset, 4, `invalid alignment ${String(alignmentBytes)} must not force 16-byte placement`);
    assert.equal(entry.alignmentBytes, 4);
  }
});

test('#7348 preserves #6029 fail-closed aggregate alignment evidence', () => {
  const vectorAggregate = {
    type:'vector', aggregate:true, bits:128, bytes:16,
    members:[{ type:'vector', bits:128, bytes:16, byteOffset:0 }],
  };
  const result = classify([
    ...Array.from({ length:8 }, () => ({ type:'unsigned long', bits:64 })),
    { type:'unsigned char', bits:8 },
    vectorAggregate,
  ]);
  const aggregate = result.arguments[9];

  assert.equal(result.partial, true);
  assert.equal(aggregate.location, 'unknown');
  assert.equal(aggregate.possible, true);
  assert.equal(aggregate.mustUse, false);
  assert.equal(aggregate.reason, 'darwin-arm64-aggregate-alignment-not-proven');
});
