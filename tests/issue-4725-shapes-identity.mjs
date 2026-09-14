import assert from 'node:assert/strict';

import { AMOUNT, SHAPE, evidenceFor, foldShapes } from '../js/shapes.js';

function scanOf({ count, disp, flags, amtKind, amtDisp, addr, baseIdentity, amtBaseIdentity }) {
  return {
    count,
    disp: Int32Array.from(disp),
    size: Uint8Array.from(Array(count).fill(4)),
    flags: Uint8Array.from(flags),
    amtKind: Uint8Array.from(amtKind),
    amtDisp: Int32Array.from(amtDisp),
    addr: BigUint64Array.from(addr),
    span: Int32Array.from(Array(count).fill(0x100)),
    amtSize: Uint8Array.from(Array(count).fill(4)),
    amtSpan: Int32Array.from(Array(count).fill(0x100)),
    baseIdentity,
    amtBaseIdentity,
  };
}

// A structured identity must not alias the canonical bigint identity it would
// reach through String(value). The malformed observation stays low-confidence.
{
  const folded = foldShapes(scanOf({
    count: 2,
    disp: [0x20, 0x20],
    flags: [SHAPE.DECREASE, SHAPE.DECREASE],
    amtKind: [AMOUNT.NONE, AMOUNT.NONE],
    amtDisp: [0, 0],
    addr: [0x1000n, 0x2000n],
    baseIdentity: [['1'], 1n],
  }));
  assert.equal(folded.size, 2, 'structured and canonical identities must not share a target entry');
  const entries = [...folded.values()];
  const known = entries.find((entry) => entry.identity === '1');
  const unknown = entries.find((entry) => entry.identity == null);
  assert.equal(known?.identityKnown, true);
  assert.equal(known?.events, 1);
  assert.equal(unknown?.identityKnown, false);
  assert.equal(unknown?.events, 1);
  assert.ok(evidenceFor(folded, 0x20, 'hp')?.codes.some((code) => code.code === 'loc-object-identity-unknown'));
}

// Arrays, objects, booleans, numbers, and boxed strings are all malformed
// transport values. None may invoke user coercion or become known identity.
{
  let coercions = 0;
  const coercible = {
    toString() { coercions++; return '1'; },
    valueOf() { coercions++; return 1; },
  };
  const malformed = [['1'], coercible, true, 1, new String('1')];
  const folded = foldShapes(scanOf({
    count: malformed.length + 1,
    disp: Array(malformed.length + 1).fill(0x24),
    flags: Array(malformed.length + 1).fill(SHAPE.DECREASE),
    amtKind: Array(malformed.length + 1).fill(AMOUNT.NONE),
    amtDisp: Array(malformed.length + 1).fill(0),
    addr: Array.from({ length: malformed.length + 1 }, (_, i) => BigInt(0x3000 + i)),
    baseIdentity: [...malformed, 1n],
  }));
  const entries = [...folded.values()];
  assert.equal(coercions, 0, 'malformed identity must not invoke coercion hooks');
  assert.equal(entries.length, 2);
  assert.equal(entries.find((entry) => entry.identity === '1')?.events, 1);
  assert.equal(entries.find((entry) => entry.identity == null)?.events, malformed.length);
  assert.equal(entries.find((entry) => entry.identity == null)?.identityKnown, false);
}

// The amount/source aggregation has the same authority boundary as target
// aggregation: a structured amount identity must not merge with a bigint one.
{
  const folded = foldShapes(scanOf({
    count: 2,
    disp: [0x40, 0x40],
    flags: [SHAPE.DECREASE | SHAPE.CROSS | SHAPE.SCALED, SHAPE.DECREASE | SHAPE.CROSS | SHAPE.SCALED],
    amtKind: [AMOUNT.FIELD, AMOUNT.FIELD],
    amtDisp: [0x18, 0x18],
    addr: [0x4000n, 0x5000n],
    baseIdentity: [7n, 7n],
    amtBaseIdentity: [['1'], 1n],
  }));
  const amountEntries = [...folded.values()].filter((entry) => entry.offset === 0x18);
  assert.equal(amountEntries.length, 2, 'structured and canonical identities must remain separate for amount sources');
  assert.equal(amountEntries.find((entry) => entry.identity === '1')?.identityKnown, true);
  assert.equal(amountEntries.find((entry) => entry.identity == null)?.identityKnown, false);
  assert.equal(amountEntries.find((entry) => entry.identity === '1')?.events, 1);
  assert.equal(amountEntries.find((entry) => entry.identity == null)?.events, 1);

  const target = [...folded.values()].find((entry) => entry.offset === 0x40 && entry.identity === '7');
  assert.deepEqual([...target.amountFrom.keys()].sort(), ['1:24', 'unknown:24']);
}

console.log('issue #4725 shapes identity coercion regression: PASS');
