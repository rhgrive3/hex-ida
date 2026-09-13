import assert from 'node:assert/strict';
import test from 'node:test';
import { abiPlugin } from '../../../js/targets/abi/index.js';

const lp64 = abiPlugin('lp64');

// Helper to fill all 8 integer argument registers (a0-a7)
function registerFillers() {
  return Array.from({ length: 8 }, (_, i) => ({ type: 'uint64_t', bits: 64, name: `arg${i}` }));
}

test('issue #5621: size16/align8 aggregate at prior stack offset 8 remains at offset 8', () => {
  const fillers = registerFillers();
  // Arg 8 (9th arg) goes to stack offset 0, taking 8 bytes (stackOffset becomes 8)
  const stackArg0 = { type: 'uint64_t', bits: 64, name: 's0' };
  // Arg 9 (10th arg) is size16/align8 aggregate
  const pairArg = {
    type: 'struct',
    aggregate: true,
    bits: 128,
    alignment: 8,
    members: [
      { type: 'uint64_t', bits: 64, byteOffset: 0 },
      { type: 'uint64_t', bits: 64, byteOffset: 8 },
    ],
  };

  const classified = lp64.classifyArguments({
    callPrototype: { args: [...fillers, stackArg0, pairArg] },
  });

  const pairClassified = classified.arguments[9];
  assert.equal(pairClassified.location, 'stack');
  assert.equal(pairClassified.offset, 8, 'size16/align8 aggregate must be placed at offset 8, not aligned to 16');
});

test('issue #5621: size16/align16 aggregate at prior stack offset 8 aligns to offset 16', () => {
  const fillers = registerFillers();
  const stackArg0 = { type: 'uint64_t', bits: 64, name: 's0' };
  const pairArg = {
    type: 'struct',
    aggregate: true,
    bits: 128,
    alignment: 16,
    members: [
      { type: 'uint64_t', bits: 64, byteOffset: 0 },
      { type: 'uint64_t', bits: 64, byteOffset: 8 },
    ],
  };

  const classified = lp64.classifyArguments({
    callPrototype: { args: [...fillers, stackArg0, pairArg] },
  });

  const pairClassified = classified.arguments[9];
  assert.equal(pairClassified.location, 'stack');
  assert.equal(pairClassified.offset, 16, 'size16/align16 aggregate must be aligned to offset 16');
});

test('issue #5621: size8/align16 aggregate at prior stack offset 8 aligns to offset 16', () => {
  const fillers = registerFillers();
  const stackArg0 = { type: 'uint64_t', bits: 64, name: 's0' };
  const overalignedArg = {
    type: 'struct',
    aggregate: true,
    bits: 64,
    alignment: 16,
    members: [{ type: 'uint64_t', bits: 64, byteOffset: 0 }],
  };

  const classified = lp64.classifyArguments({
    callPrototype: { args: [...fillers, stackArg0, overalignedArg] },
  });

  const argClassified = classified.arguments[9];
  assert.equal(argClassified.location, 'stack');
  assert.equal(argClassified.offset, 16, 'size8/align16 aggregate must be aligned to offset 16, not left at 8');
});

test('issue #5621: size8/align4 aggregate has effective alignment 8 (XLEN floor)', () => {
  const fillers = registerFillers();
  const stackArg0 = { type: 'uint64_t', bits: 64, name: 's0' };
  const underalignedArg = {
    type: 'struct',
    aggregate: true,
    bits: 64,
    alignment: 4,
    members: [{ type: 'uint32_t', bits: 32, byteOffset: 0 }, { type: 'uint32_t', bits: 32, byteOffset: 4 }],
  };

  const classified = lp64.classifyArguments({
    callPrototype: { args: [...fillers, stackArg0, underalignedArg] },
  });

  const argClassified = classified.arguments[9];
  assert.equal(argClassified.location, 'stack');
  assert.equal(argClassified.offset, 8, 'size8/align4 aggregate has XLEN floor (8 bytes alignment)');
});

test('issue #5621: alignment > 16 is capped at stack alignment 16', () => {
  const fillers = registerFillers();
  const stackArg0 = { type: 'uint64_t', bits: 64, name: 's0' };
  const hugeAlignArg = {
    type: 'struct',
    aggregate: true,
    bits: 128,
    alignment: 32,
    members: [{ type: 'uint64_t', bits: 64, byteOffset: 0 }, { type: 'uint64_t', bits: 64, byteOffset: 8 }],
  };

  const classified = lp64.classifyArguments({
    callPrototype: { args: [...fillers, stackArg0, hugeAlignArg] },
  });

  const argClassified = classified.arguments[9];
  assert.equal(argClassified.location, 'stack');
  assert.equal(argClassified.offset, 16, 'alignment 32 is capped at stack alignment 16');
});

test('issue #5621: malformed/conflicting alignment metadata fails closed as partial', () => {
  const fillers = registerFillers();
  const stackArg0 = { type: 'uint64_t', bits: 64, name: 's0' };
  const malformedArg = {
    type: 'struct',
    aggregate: true,
    bits: 64,
    alignment: 3, // not a power of 2
    members: [{ type: 'uint64_t', bits: 64, byteOffset: 0 }],
  };

  const classified = lp64.classifyArguments({
    callPrototype: { args: [...fillers, stackArg0, malformedArg] },
  });

  assert.equal(classified.partial, true, 'malformed alignment must set partial: true');
  assert.equal(classified.arguments[9].location, 'unknown');
});
