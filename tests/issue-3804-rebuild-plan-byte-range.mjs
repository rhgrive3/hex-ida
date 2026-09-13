// Regression for #3804: js/rebuild/index.js::bytes() handed array input to
// `Uint8Array.from()`, which coerces numbers modulo 256 (256 -> 0) and accepts
// numeric strings. A malformed patch therefore materialized as a *different*
// legal patch and the rebuild report claimed success. Array patch bytes must be
// validated as exact 0..255 integers before they become canonical evidence.
import assert from 'node:assert/strict';
import { createRebuildPlan } from '../js/rebuild/index.js';

const SOURCE_HASH = 'bytes:00000000000000000000000000000000';

function plan(before, after = before.map(() => 1)) {
  return createRebuildPlan({
    binaryId: 'bin',
    sourceHash: SOURCE_HASH,
    operations: [{ offset: 0, before, after }],
  });
}

// 1. Exact bytes are still accepted and preserved.
{
  const built = plan([0, 1, 0xfe, 0xff]);
  assert.deepEqual(built.operations[0].before, [0, 1, 0xfe, 0xff]);
}

// 2. Out-of-range, fractional, negative and non-numeric values must fail closed
//    instead of wrapping / parsing into a legal byte.
for (const malformed of [[256], [-1], [1.5], ['1'], [null], [undefined], [true], [0x1_00]]) {
  assert.throws(
    () => plan(malformed),
    (error) => error instanceof TypeError,
    `before=${JSON.stringify(malformed)} must not be coerced into canonical patch bytes`,
  );
}

// 3. The rejection covers `after` too, which is what actually gets written.
assert.throws(
  () => plan([0], [256]),
  (error) => error instanceof TypeError,
  'after=[256] must not materialize as a write of 0x00',
);

console.log('issue #3804 rebuild plan byte-range regression passed');
