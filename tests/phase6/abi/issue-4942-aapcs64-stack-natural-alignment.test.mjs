import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyCallArguments } from '../../../js/architecture/compat/ir-core-arm64-aapcs64-v1.js';

/* AAPCS64 Stage C: stack argument placement rounds NSAA up to the argument's
 * natural alignment (C.4 for HFA/HVA/quad-FP/short-vector candidates, C.14
 * max(8, Natural Alignment) for the stack assignment). The compat v1
 * classifier packed every stack argument back-to-back on 8-byte steps, so a
 * 128-bit short vector landing after an 8-byte argument skipped its 16-byte
 * alignment hole (#4942). */

const EIGHT_DOUBLES = Array.from({ length: 8 }, () => ({ type: 'double', bits: 64 }));

test('#4942: a 128-bit stack vector rounds NSAA to its 16-byte natural alignment', () => {
  const out = classifyCallArguments({
    callPrototype: {
      args: [
        ...EIGHT_DOUBLES,
        { type: 'double', bits: 64 },
        { abiClass: 'vector', type: 'vector128', bits: 128 },
      ],
    },
  }, {});
  const [, vector] = out.arguments.slice(8);
  assert.equal(vector.location, 'stack');
  assert.equal(vector.offset, 16, 'offsets 8-15 stay an alignment hole before the vector');
  assert.equal(vector.bytes, 16);
});

test('#4942: plain 8-byte stack arguments keep contiguous 8-byte NSAA steps', () => {
  const out = classifyCallArguments({
    callPrototype: {
      args: [
        ...Array.from({ length: 8 }, () => ({ type: 'uint64_t', bits: 64 })),
        { type: 'uint64_t', bits: 64 },
        { type: 'uint32_t', bits: 32 },
      ],
    },
  }, {});
  const [a, b] = out.arguments.slice(8);
  assert.equal(a.location, 'stack');
  assert.equal(a.offset, 0);
  assert.equal(b.location, 'stack');
  assert.equal(b.offset, 8, 'no spurious padding without a 16-byte-alignment claim');
});

test('#4942: an HFA with 64-bit members takes 8-byte NSAA alignment', () => {
  const out = classifyCallArguments({
    callPrototype: {
      args: [
        ...EIGHT_DOUBLES,
        { type: 'double', bits: 64 },
        { type: 'struct S', hfa: true, members: 2, bits: 64 },
      ],
    },
  }, {});
  const hfa = out.arguments[9];
  assert.equal(hfa.location, 'stack');
  assert.equal(hfa.offset, 8, 'the strictest member alignment is 8');
  assert.equal(hfa.bytes, 16);
});

test('#4942: an HFA with 128-bit members rounds NSAA to 16', () => {
  const out = classifyCallArguments({
    callPrototype: {
      args: [
        ...EIGHT_DOUBLES,
        { type: 'double', bits: 64 },
        { type: 'struct Q', hfa: true, members: 2, bits: 128 },
      ],
    },
  }, {});
  const hfa = out.arguments[9];
  assert.equal(hfa.location, 'stack');
  assert.equal(hfa.offset, 16);
});

test('#4942: a 128-bit quad-FP stack argument rounds NSAA to 16 (C.4)', () => {
  const out = classifyCallArguments({
    callPrototype: {
      args: [
        ...EIGHT_DOUBLES,
        { type: 'double', bits: 64 },
        { abiClass: 'fp', type: '__float128', bits: 128 },
      ],
    },
  }, {});
  const [, quad] = out.arguments.slice(8);
  const spill = out.arguments[8];
  assert.equal(spill.location, 'stack');
  assert.equal(spill.offset, 0, 'the 8-byte spill keeps the first stack slot');
  assert.equal(quad.location, 'stack');
  assert.equal(quad.offset, 16, 'quad FP natural alignment inserts the C.4 hole');
  assert.equal(quad.bytes, 16);
});

test('#4942: a 64-bit FP stack argument keeps 8-byte NSAA steps', () => {
  const out = classifyCallArguments({
    callPrototype: {
      args: [
        ...EIGHT_DOUBLES,
        { type: 'double', bits: 64 },
        { type: 'double', bits: 64 },
      ],
    },
  }, {});
  const [, next] = out.arguments.slice(8);
  assert.equal(next.location, 'stack');
  assert.equal(next.offset, 8, 'doubles are not quad-FP candidates');
});

test('#4942: an explicitly declared 16-byte alignment is honored on the stack', () => {
  const out = classifyCallArguments({
    callPrototype: {
      args: [
        ...Array.from({ length: 8 }, () => ({ type: 'uint64_t', bits: 64 })),
        { type: 'uint64_t', bits: 64 },
        { type: 'struct A', bits: 64, aggregate: true, alignment: 16 },
      ],
    },
  }, {});
  const aggregate = out.arguments[9];
  assert.equal(aggregate.location, 'stack');
  assert.equal(aggregate.offset, 16, 'a proven 16-byte type alignment inserts the NSAA hole');
});

test('#4942: a structured declared alignment fails closed to the derived alignment', () => {
  const out = classifyCallArguments({
    callPrototype: {
      args: [
        ...Array.from({ length: 8 }, () => ({ type: 'uint64_t', bits: 64 })),
        { type: 'uint64_t', bits: 64 },
        { type: 'uint32_t', bits: 32, alignment: { bits: 16 } },
      ],
    },
  }, {});
  const aggregate = out.arguments[9];
  assert.equal(aggregate.location, 'stack');
  assert.equal(aggregate.offset, 8, 'structured alignment evidence is never coerced into padding');
});
