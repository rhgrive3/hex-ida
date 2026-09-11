import assert from 'node:assert/strict';
import { classifySysVAMD64Arguments } from '../../../js/targets/abi/sysv-amd64.js';

// Issue #6008: a MEMORY-class aggregate is passed on the stack at an address
// respecting its own alignment, which may exceed 16 bytes (psABI
// low-level-sys-info, Parameter Passing). The old classifier clamped every
// stack alignment to 16, misplacing every following stack argument.

const longArg = { type: 'long', bits: 64, bytes: 8 };
const S32 = {
  type: 'S32',
  aggregate: true,
  bits: 192,
  alignment: 32,
  eightbyteClasses: ['MEMORY'],
  members: [
    { bits: 64, bytes: 8, byteOffset: 0 },
    { bits: 64, bytes: 8, byteOffset: 8 },
    { bits: 64, bytes: 8, byteOffset: 16 },
  ],
};

const result = classifySysVAMD64Arguments({
  callPrototype: { args: [longArg, longArg, longArg, longArg, longArg, longArg, longArg, S32] },
});

assert.equal(result.partial, false, `expected exact classification, got partial:${result.partial} reason:${result.reason}`);
assert.equal(result.arguments[6].location, 'stack');
assert.equal(result.arguments[6].offset, 0, 'first stack slot belongs to the 7th scalar');

const aggregate = result.arguments[7];
assert.equal(aggregate.location, 'stack');
assert.equal(aggregate.offset, 32, '32-byte-aligned MEMORY aggregate must land at the next 32-byte boundary (not 16)');
assert.equal(aggregate.calleeEntryOffset, 8 + 32);
assert.deepEqual(aggregate.pieces.map((p) => p.stackOffset), [32, 40, 48]);

// Alignment 16 keeps its historical behavior; junk alignments fail safe to
// the 8-byte stack slot granularity instead of NaN-poisoning offsets.
const S16 = { ...S32, alignment: 16 };
const r16 = classifySysVAMD64Arguments({
  callPrototype: { args: [longArg, longArg, longArg, longArg, longArg, longArg, longArg, S16] },
});
assert.equal(r16.arguments[7].offset, 16);

for (const junk of [undefined, null, 0, -32, NaN, 'bogus']) {
  const rj = classifySysVAMD64Arguments({
    callPrototype: { args: [longArg, longArg, longArg, longArg, longArg, longArg, longArg, { ...S32, alignment: junk }] },
  });
  assert.equal(rj.arguments[7].offset, 8, `junk alignment ${String(junk)} must fall back to 8-byte slot alignment`);
  assert.equal(Number.isSafeInteger(rj.arguments[7].offset), true);
}

console.log('issue-6008 sysv MEMORY aggregate stack alignment authority: ok');
