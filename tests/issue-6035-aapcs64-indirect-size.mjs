import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyAAPCS64Arguments } from '../js/targets/abi/aapcs64-core.js';

const u64 = { type: 'uint64_t', bits: 64 };

function classify(args) {
  return classifyAAPCS64Arguments({ callPrototype: { args } });
}

function padded72() {
  return {
    type: 'struct Padded',
    aggregate: true,
    bits: 72,
    alignment: 32,
    layout: {
      bits: 72,
      bytes: 32,
      members: [
        { bits: 64, bytes: 8, byteOffset: 0 },
        { bits: 8, bytes: 1, byteOffset: 8 },
      ],
      padding: [{ byteOffset: 9, bytes: 23 }],
    },
  };
}

test('6035: padded aggregate over 16 bytes goes indirect after GPR exhaustion', () => {
  const args = [...Array.from({ length: 8 }, () => ({ ...u64 })), padded72()];
  const result = classify(args);
  const last = result.arguments[8];
  assert.equal(last.abiClass, 'aggregate-indirect-copy');
  assert.equal(last.pointer, true);
});

test('6035: 16-byte aggregate still goes by value', () => {
  const pair = {
    type: 'struct Pair',
    aggregate: true,
    bits: 128,
    layout: {
      bits: 128,
      bytes: 16,
      members: [
        { bits: 64, bytes: 8, byteOffset: 0 },
        { bits: 64, bytes: 8, byteOffset: 8 },
      ],
      padding: [],
    },
  };
  const result = classify([pair]);
  assert.deepEqual(result.arguments[0].regs, ['x0', 'x1']);
});

test('6035: 192-bit aggregate still goes indirect', () => {
  const triple = {
    type: 'struct Triple',
    aggregate: true,
    bits: 192,
    layout: {
      bits: 192,
      bytes: 24,
      members: [
        { bits: 64, bytes: 8, byteOffset: 0 },
        { bits: 64, bytes: 8, byteOffset: 8 },
        { bits: 64, bytes: 8, byteOffset: 16 },
      ],
      padding: [],
    },
  };
  const result = classify([triple]);
  assert.equal(result.arguments[0].abiClass, 'aggregate-indirect-copy');
});
