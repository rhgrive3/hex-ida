import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeSchema } from '../js/schema.js';

const SCALE_TAIL = [
  0xf8617804, // ldr x4,[x0,x1,lsl #3]
  0x9b027c85, // mul x5,x4,x2
  0xf8217806, // str x6,[x0,x1,lsl #3]
];

function scaledFactors(prefix) {
  const result = decodeSchema(new Uint32Array([...prefix, ...SCALE_TAIL]), 0x1000n);
  return (result?.best?.scaled || []).map((scaled) => scaled.factor);
}

// Issue #6306: every ordinary write family recognized by writtenGpr() must
// invalidate a MOVZ-established constant before it can reach scaled evidence.
test('#6306: MOVREG overwrite invalidates MOVZ provenance before mul scale evidence', () => {
  const factors = scaledFactors([
    0xd2800062, // movz x2,#3
    0xaa0303e2, // mov x2,x3
  ]);
  assert.equal(factors.includes(3), false, 'MOVREG overwrite must kill stale factor 3');
});

test('#6306: ARITH overwrite invalidates MOVZ provenance', () => {
  const factors = scaledFactors([
    0xd2800062, // movz x2,#3
    0x8b040062, // add x2,x3,x4
  ]);
  assert.equal(factors.includes(3), false, 'ARITH overwrite must kill stale factor 3');
});

test('#6306: LOGIC overwrite invalidates MOVZ provenance', () => {
  const factors = scaledFactors([
    0xd2800062, // movz x2,#3
    0xca040062, // eor x2,x3,x4
  ]);
  assert.equal(factors.includes(3), false, 'LOGIC overwrite must kill stale factor 3');
});

test('#6306: genuine MOVZ provenance still produces scale factor', () => {
  const factors = scaledFactors([
    0xd2800062, // movz x2,#3
  ]);
  assert.equal(factors.filter((factor) => factor === 3).length, 1, 'a live MOVZ constant must still be reported as the factor');
});

test('#6306: MOVZ plus MOVK preserves the composed wide constant', () => {
  const factors = scaledFactors([
    0xd2800062, // movz x2,#3
    0xf2a00022, // movk x2,#1,lsl #16 => 0x10003
  ]);
  assert.equal(factors.filter((factor) => factor === 0x10003).length, 1, 'MOVK must update the live MOVZ constant instead of killing it');
});

test('#6306: call clobber continues to invalidate caller-saved constant provenance', () => {
  const factors = scaledFactors([
    0xd2800062, // movz x2,#3
    0x94000000, // bl . (x2 is caller-saved and must become unknown)
  ]);
  assert.equal(factors.includes(3), false, 'call clobber must keep x2 unknown after a call');
});
