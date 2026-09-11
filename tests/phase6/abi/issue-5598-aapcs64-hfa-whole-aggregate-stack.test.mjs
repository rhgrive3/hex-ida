import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyAAPCS64Arguments } from '../../../js/targets/abi/aapcs64-core.js';

/* AAPCS64 Stage C for a spilled HFA/HVA (aapcs64.rst C.2-C.6): the argument's
 * WHOLE size is rounded up to a multiple of 8 bytes exactly once (C.3), the
 * NSAA is aligned to the argument's natural alignment (C.4), and the aggregate
 * is copied contiguously in its canonical member packing (C.6) — stack HFAs
 * have "exactly the same layout" as other composites. Members must NOT be
 * widened to one 8-byte slot each (#5598). Mirrors the darwin compact-layout
 * contract of tests/phase6/abi/issue-5988 with the standard-ABI C.3 rounding. */

const EXHAUSTED_BANKS = [
  ...Array.from({ length:8 }, () => ({ type:'float' })),
  ...Array.from({ length:8 }, () => ({ type:'long' })),
];

function classify(args) {
  return classifyAAPCS64Arguments({ callPrototype:{ args } });
}

function stackEntry(result, index) {
  const entry = result.stackArguments.find((argument) => argument?.index === index);
  assert.ok(entry, `argument ${index} must fall to the stack`);
  return entry;
}

test('#5598 HFA float[2] stack fallback rounds the whole argument once (8 bytes, offsets 0/4)', () => {
  const result = classify([...EXHAUSTED_BANKS, {
    type:'H2', hfa:true, bits:64, bytes:8, alignment:4,
    members:[{ bits:32, bytes:4, byteOffset:0 }, { bits:32, bytes:4, byteOffset:4 }],
  }, { type:'unsigned char' }]);
  const entry = stackEntry(result, 16);
  assert.equal(entry.bytes, 8, 'float[2] HFA must occupy 8 stack bytes, not 16');
  assert.equal(entry.stackElementBytes, 4);
  assert.deepEqual(entry.pieces.map((piece) => piece.byteOffset), [0, 4]);
  assert.deepEqual(entry.pieces.map((piece) => piece.bytes), [4, 4]);
  const tail = stackEntry(result, 17);
  assert.equal(tail.offset, entry.offset + 8,
    'the next stack argument starts after the whole rounded aggregate');
});

test('#5598 HFA float[4] keeps 16-byte layout with member offsets 0/4/8/12', () => {
  const result = classify([...EXHAUSTED_BANKS, {
    type:'H4', hfa:true, bits:128, bytes:16, alignment:4,
    members:[
      { bits:32, bytes:4, byteOffset:0 }, { bits:32, bytes:4, byteOffset:4 },
      { bits:32, bytes:4, byteOffset:8 }, { bits:32, bytes:4, byteOffset:12 },
    ],
  }, { type:'unsigned char' }]);
  const entry = stackEntry(result, 16);
  assert.equal(entry.bytes, 16);
  assert.deepEqual(entry.pieces.map((piece) => piece.byteOffset), [0, 4, 8, 12]);
  const tail = stackEntry(result, 17);
  assert.equal(tail.offset, entry.offset + 16);
});

test('#5598 HFA __fp16[2] rounds the whole aggregate to 8 and keeps member offsets 0/2', () => {
  const result = classify([...EXHAUSTED_BANKS, {
    type:'H2h', hfa:true, bits:32, bytes:4, alignment:2,
    members:[{ bits:16, bytes:2, byteOffset:0 }, { bits:16, bytes:2, byteOffset:2 }],
  }, { type:'unsigned char' }]);
  const entry = stackEntry(result, 16);
  assert.equal(entry.bytes, 8, 'C.3 rounds size(H2h)=4 up to 8 exactly once');
  assert.equal(entry.stackElementBytes, 2);
  assert.deepEqual(entry.pieces.map((piece) => piece.byteOffset), [0, 2],
    'C.6 keeps the canonical member packing');
  assert.deepEqual(entry.pieces.map((piece) => piece.bytes), [2, 2]);
  const tail = stackEntry(result, 17);
  assert.equal(tail.offset, entry.offset + 8);
});

test('#5598 HFA double[2] control keeps 16 bytes', () => {
  const result = classify([...EXHAUSTED_BANKS, {
    type:'D2', hfa:true, bits:128, bytes:16, alignment:8,
    members:[{ bits:64, bytes:8, byteOffset:0 }, { bits:64, bytes:8, byteOffset:8 }],
  }]);
  const entry = stackEntry(result, 16);
  assert.equal(entry.bytes, 16);
  assert.deepEqual(entry.pieces.map((piece) => piece.byteOffset), [0, 8]);
});

test('#5598 HVA 128-bit x2 control keeps 32 bytes', () => {
  const result = classify([...EXHAUSTED_BANKS, {
    type:'V2', hva:true, bits:256, bytes:32, alignment:16,
    members:[
      { bits:128, bytes:16, byteOffset:0 }, { bits:128, bytes:16, byteOffset:16 },
    ],
  }]);
  const entry = stackEntry(result, 16);
  assert.equal(entry.bytes, 32);
  assert.deepEqual(entry.pieces.map((piece) => piece.byteOffset), [0, 16]);
});

test('#5598 exhausted v-registers still set NSRN=8 before the stack fallback', () => {
  const result = classify([...EXHAUSTED_BANKS, {
    type:'D2', hfa:true, bits:128, bytes:16, alignment:8,
    members:[{ bits:64, bytes:8, byteOffset:0 }, { bits:64, bytes:8, byteOffset:8 }],
  }]);
  const entry = stackEntry(result, 16);
  assert.ok(entry.aggregate && entry.homogeneousLayoutProven);
  assert.equal(entry.offset, 0);
});

test('#5598 natural 16-byte HVA alignment aligns the stack offset, not member layout', () => {
  const result = classify([...EXHAUSTED_BANKS, { type:'unsigned long' }, { type:'unsigned long' }, {
    type:'VA2', hva:true, bits:256, bytes:32, alignment:16,
    members:[
      { bits:128, bytes:16, byteOffset:0 }, { bits:128, bytes:16, byteOffset:16 },
    ],
  }, { type:'unsigned char' }]);
  const entry = stackEntry(result, 18);
  assert.equal(entry.offset, 16, 'C.4 aligns the NSAA to the 16-byte aggregate alignment');
  assert.equal(entry.bytes, 32);
  assert.deepEqual(entry.pieces.map((piece) => piece.stackOffset), [16, 32],
    'member packing must not be re-aligned per member');
  const tail = stackEntry(result, 19);
  assert.equal(tail.offset, entry.offset + 32);
});

test('#5598 HVA float32[3] (12 bytes) rounds the whole argument to 16', () => {
  const result = classify([...EXHAUSTED_BANKS, {
    type:'H3', hva:true, bits:96, bytes:12, alignment:4,
    members:[
      { bits:32, bytes:4, byteOffset:0 }, { bits:32, bytes:4, byteOffset:4 },
      { bits:32, bytes:4, byteOffset:8 },
    ],
  }]);
  const entry = stackEntry(result, 16);
  assert.equal(entry.bytes, 16, 'C.3 rounds size=12 up to the next multiple of 8');
  assert.deepEqual(entry.pieces.map((piece) => piece.byteOffset), [0, 4, 8]);
});
