import assert from 'node:assert/strict';
import { partitionDecodedFunction } from '../js/analysis/semantic-function-base.js';

// Issue #5821: partitionDecodedFunction() rejected duplicate start addresses
// but accepted overlapping byte ranges. Two sorted instructions with disjoint
// geometry is an invariant of a linear decoded stream; overlaps must fail
// closed instead of landing in one linear basic block.

const plugin = {
  classifyControlFlow: () => 'fallthrough',
  directControlTarget: () => null,
};

// Overlapping ranges, distinct starts: must fail closed.
assert.throws(
  () => partitionDecodedFunction([
    { address: 0x1000n, length: 4 },
    { address: 0x1002n, length: 4 },
  ], plugin),
  (err) => err instanceof TypeError && err.message === 'semantic-function-instruction-range-overlap',
  'overlapping instruction byte ranges must be rejected',
);

// Zero-length overlap at exact adjacency stays valid.
const adjacent = partitionDecodedFunction([
  { address: 0x1000n, length: 4 },
  { address: 0x1004n, length: 4 },
], plugin);
assert.equal(Array.isArray(adjacent) && adjacent.length === 1, true, 'adjacent non-overlapping instructions stay one linear block');
assert.equal(adjacent[0].instructions.length, 2);

// Duplicate start address keeps its dedicated rejection.
assert.throws(
  () => partitionDecodedFunction([
    { address: 0x2000n, length: 4 },
    { address: 0x2000n, length: 4 },
  ], plugin),
  (err) => err.message === 'semantic-function-duplicate-instruction-address',
);

// Control boundaries still split blocks normally.
const split = partitionDecodedFunction([
  { address: 0x3000n, length: 4 },
  { address: 0x3004n, length: 4 },
], {
  classifyControlFlow: (instruction) => (BigInt(instruction.address) === 0x3000n ? 'branch' : 'fallthrough'),
  directControlTarget: (instruction) => (BigInt(instruction.address) === 0x3000n ? 0x3008n : null),
});
assert.equal(Array.isArray(split) && split.length >= 2, true, 'control boundaries still partition');

console.log('issue-5821 decoded instruction range overlap rejected: ok');
