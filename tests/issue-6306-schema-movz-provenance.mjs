import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeSchema } from '../js/schema.js';

// Issue #6306: a MOVZ-established constant must be invalidated when the
// register is overwritten by an instruction the constant trackers do not
// model (MOVREG/arithmetic/logic/shift/csel/load). The stale constant used
// to leak into scaledColumns() factor evidence.
test('#6306: MOVREG overwrite invalidates MOVZ provenance before mul scale evidence', () => {
  const words = new Uint32Array([
    0xd2800062, // movz x2,#3
    0xaa0303e2, // mov x2,x3  (x2 no longer 3)
    0xf8617804, // ldr x4,[x0,x1,lsl #3]
    0x9b027c85, // mul x5,x4,x2  (scale depends on runtime x3)
    0xf8217806, // str x6,[x0,x1,lsl #3]
  ]);
  const result = decodeSchema(words, 0x1000n);
  const scaled = (result.best?.scaled || []).filter((s) => s.factor === 3);
  assert.equal(scaled.length, 0, 'stale MOVZ constant 3 must not appear as a scaled column factor');
});

test('#6306: genuine MOVZ provenance still produces scale factor', () => {
  const words = new Uint32Array([
    0xd2800062, // movz x2,#3
    0xf8617804, // ldr x4,[x0,x1,lsl #3]
    0x9b027c85, // mul x5,x4,x2  (factor 3 is real)
    0xf8217806, // str x6,[x0,x1,lsl #3]
  ]);
  const result = decodeSchema(words, 0x1000n);
  const scaled = (result.best?.scaled || []).filter((s) => s.factor === 3);
  assert.equal(scaled.length, 1, 'a live MOVZ constant must still be reported as the factor');
});
