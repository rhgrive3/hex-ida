import assert from 'node:assert/strict';
import test from 'node:test';

import { DARWIN_ARM64_ABI } from '../../../js/targets/abi/darwin-arm64.js';

/* Apple ARM64 stack arguments consume compact slots of their natural layout:
 * "Function arguments may consume slots on the stack that are not multiples of
 * 8 bytes" (Writing ARM64 Code for Apple Platforms). An HFA that spills to the
 * stack keeps its canonical member packing instead of being widened to one
 * 8-byte slot per member. Verified against clang -target arm64-apple-macos11:
 * { float a,b,c,d } after 8 FP + 8 GP registers is read at sp+0/4/8/12 and a
 * following unsigned char at sp+16. */

const EXHAUSTED_BANKS = [
  ...Array.from({ length:8 }, () => ({ type:'float' })),
  ...Array.from({ length:8 }, () => ({ type:'long' })),
];

const FLOAT_HFA4 = {
  hfa:true,
  bits:128,
  bytes:16,
  alignmentBytes:4,
  members:[
    { bits:32, bytes:4, byteOffset:0 },
    { bits:32, bytes:4, byteOffset:4 },
    { bits:32, bytes:4, byteOffset:8 },
    { bits:32, bytes:4, byteOffset:12 },
  ],
};

test('darwin float[4] HFA stack fallback keeps the compact 16-byte layout', () => {
  const result = DARWIN_ARM64_ABI.classifyArguments({
    callPrototype:{ args:[...EXHAUSTED_BANKS, { ...FLOAT_HFA4, type:'H4' }] },
  });
  const entry = result.stackArguments.find((argument) => argument?.index === 16);
  assert.ok(entry, 'the HFA must fall to the stack');
  assert.equal(entry.bytes, 16, 'float[4] HFA must occupy 16 stack bytes, not 32');
  assert.equal(entry.offset, 0);
  assert.deepEqual(entry.pieces.map((piece) => piece.byteOffset), [0, 4, 8, 12],
    'members keep their canonical byte offsets');
  assert.deepEqual(entry.pieces.map((piece) => piece.bytes), [4, 4, 4, 4],
    'member pieces keep their 4-byte element size');
  assert.deepEqual(entry.pieces.map((piece) => piece.stackOffset), [0, 4, 8, 12]);
  assert.equal(entry.stackElementBytes, 4);
});

test('darwin following stack argument starts right after the compact HFA', () => {
  const result = DARWIN_ARM64_ABI.classifyArguments({
    callPrototype:{ args:[...EXHAUSTED_BANKS, { ...FLOAT_HFA4, type:'H4' }, { type:'unsigned char' }] },
  });
  const hfa = result.stackArguments.find((argument) => argument?.index === 16);
  const tail = result.stackArguments.find((argument) => argument?.index === 17);
  assert.ok(hfa && tail, 'both arguments must fall to the stack');
  assert.equal(tail.offset, hfa.offset + 16,
    'the tail must start at sp+16 after the 16-byte HFA, not sp+32');
});

test('darwin explicitly over-aligned float HFA keeps compact members at the aligned stack offset', () => {
  const result = DARWIN_ARM64_ABI.classifyArguments({
    functionPrototype:{
      args:[
        ...EXHAUSTED_BANKS,
        { type:'float', bits:32, bytes:4, alignmentBytes:4 },
        { ...FLOAT_HFA4, alignmentBytes:16, type:'over-aligned-H4' },
        { type:'unsigned char' },
      ],
    },
  });
  const entry = result.stackArguments.find((argument) => argument?.index === 17);
  const tail = result.stackArguments.find((argument) => argument?.index === 18);
  assert.ok(entry && tail, 'the over-aligned HFA and tail must fall to the stack');
  assert.equal(entry.offset, 16, 'explicit 16-byte aggregate alignment must be preserved');
  assert.equal(entry.alignmentBytes, 16);
  assert.equal(entry.bytes, 16, 'over-alignment must not widen compact HFA storage');
  assert.deepEqual(entry.pieces.map((piece) => piece.byteOffset), [0, 4, 8, 12],
    'over-alignment must not alter canonical member packing');
  assert.deepEqual(entry.pieces.map((piece) => piece.stackOffset), [16, 20, 24, 28]);
  assert.equal(tail.offset, 32, 'the following argument begins after the compact HFA extent');
});

test('darwin float[2] HFA stack fallback keeps its canonical size', () => {
  const hfa2 = {
    hfa:true, bits:64, bytes:8, alignmentBytes:4,
    members:[{ bits:32, bytes:4, byteOffset:0 }, { bits:32, bytes:4, byteOffset:4 }],
  };
  const result = DARWIN_ARM64_ABI.classifyArguments({
    callPrototype:{ args:[...EXHAUSTED_BANKS, { ...hfa2, type:'H2' }, { type:'unsigned char' }] },
  });
  const entry = result.stackArguments.find((argument) => argument?.index === 16);
  assert.equal(entry.bytes, 8);
  assert.deepEqual(entry.pieces.map((piece) => piece.byteOffset), [0, 4]);
  const tail = result.stackArguments.find((argument) => argument?.index === 17);
  assert.equal(tail.offset, entry.offset + 8);
});

test('darwin double[2] HFA control keeps 16 bytes at 8-byte member strides', () => {
  const d2 = {
    hfa:true, bits:128, bytes:16, alignmentBytes:8,
    members:[{ bits:64, bytes:8, byteOffset:0 }, { bits:64, bytes:8, byteOffset:8 }],
  };
  const result = DARWIN_ARM64_ABI.classifyArguments({
    callPrototype:{ args:[...EXHAUSTED_BANKS, { ...d2, type:'D2' }, { type:'unsigned char' }] },
  });
  const entry = result.stackArguments.find((argument) => argument?.index === 16);
  assert.equal(entry.bytes, 16);
  assert.deepEqual(entry.pieces.map((piece) => piece.byteOffset), [0, 8]);
  const tail = result.stackArguments.find((argument) => argument?.index === 17);
  assert.equal(tail.offset, entry.offset + 16);
});

test('darwin 128-bit HVA x2 control keeps 32 bytes at 16-byte member strides', () => {
  const hva = {
    hva:true, bits:256, bytes:32, alignmentBytes:16,
    members:[{ bits:128, bytes:16, byteOffset:0 }, { bits:128, bytes:16, byteOffset:16 }],
  };
  const result = DARWIN_ARM64_ABI.classifyArguments({
    callPrototype:{ args:[...EXHAUSTED_BANKS, { ...hva, type:'V2' }, { type:'unsigned char' }] },
  });
  const entry = result.stackArguments.find((argument) => argument?.index === 16);
  assert.equal(entry.bytes, 32);
  assert.deepEqual(entry.pieces.map((piece) => piece.byteOffset), [0, 16]);
  const tail = result.stackArguments.find((argument) => argument?.index === 17);
  assert.equal(tail.offset, entry.offset + 32);
});

test('darwin __fp16 HFA keeps half-width member packing on the stack', () => {
  const fp16 = {
    hfa:true, bits:64, bytes:8, alignmentBytes:2,
    members:[
      { bits:16, bytes:2, byteOffset:0 },
      { bits:16, bytes:2, byteOffset:2 },
      { bits:16, bytes:2, byteOffset:4 },
      { bits:16, bytes:2, byteOffset:6 },
    ],
  };
  const result = DARWIN_ARM64_ABI.classifyArguments({
    callPrototype:{ args:[...EXHAUSTED_BANKS, { ...fp16, type:'F16x4' }, { type:'unsigned char' }] },
  });
  const entry = result.stackArguments.find((argument) => argument?.index === 16);
  assert.equal(entry.bytes, 8, '__fp16[4] is 8 bytes total, not 32');
  assert.deepEqual(entry.pieces.map((piece) => piece.byteOffset), [0, 2, 4, 6]);
  const tail = result.stackArguments.find((argument) => argument?.index === 17);
  assert.equal(tail.offset, entry.offset + 8);
});

function withoutAggregateAlignment(aggregate) {
  const copy = { ...aggregate };
  delete copy.alignmentBytes;
  return copy;
}

const COMPACT_PRODUCTION_FORMS = [
  { label:'float[4] HFA', aggregate:FLOAT_HFA4, elementBytes:4 },
  { label:'float[2] HFA', aggregate:{
    hfa:true, bits:64, bytes:8, alignmentBytes:4,
    members:[{ bits:32, bytes:4, byteOffset:0 }, { bits:32, bytes:4, byteOffset:4 }],
  }, elementBytes:4 },
  { label:'double[2] HFA', aggregate:{
    hfa:true, bits:128, bytes:16, alignmentBytes:8,
    members:[{ bits:64, bytes:8, byteOffset:0 }, { bits:64, bytes:8, byteOffset:8 }],
  }, elementBytes:8 },
  { label:'128-bit HVA x2', aggregate:{
    hva:true, bits:256, bytes:32, alignmentBytes:16,
    members:[{ bits:128, bytes:16, byteOffset:0 }, { bits:128, bytes:16, byteOffset:16 }],
  }, elementBytes:16 },
  { label:'__fp16[4] HFA', aggregate:{
    hfa:true, bits:64, bytes:8, alignmentBytes:2,
    members:[
      { bits:16, bytes:2, byteOffset:0 },
      { bits:16, bytes:2, byteOffset:2 },
      { bits:16, bytes:2, byteOffset:4 },
      { bits:16, bytes:2, byteOffset:6 },
    ],
  }, elementBytes:2 },
];

for (const { label, aggregate, elementBytes } of COMPACT_PRODUCTION_FORMS) {
  test(`darwin production functionPrototype ${label} aligns a spilled scalar before the compact aggregate`, () => {
    const result = DARWIN_ARM64_ABI.classifyArguments({
      functionPrototype:{
        args:[
          ...EXHAUSTED_BANKS,
          { type:'float', bits:32, bytes:4, alignmentBytes:4 },
          { ...withoutAggregateAlignment(aggregate), type:`production-${label}` },
          { type:'unsigned char' },
        ],
      },
    });
    const entry = result.stackArguments.find((argument) => argument?.index === 17);
    const tail = result.stackArguments.find((argument) => argument?.index === 18);
    assert.ok(entry && tail, `${label} must use the production functionPrototype shape`);
    const expectedOffset = Math.ceil(4 / elementBytes) * elementBytes;
    assert.equal(entry.offset, expectedOffset,
      `${label} uses homogeneous element alignment after the spilled scalar`);
    assert.equal(entry.alignmentBytes, elementBytes);
    assert.equal(tail.offset, entry.offset + entry.bytes);
  });
}
