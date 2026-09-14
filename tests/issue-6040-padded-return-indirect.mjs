import test from 'node:test';
import assert from 'node:assert/strict';
import { RISCV_LP64_ABI } from '../js/targets/abi/riscv-lp64.js';

const padded24 = {
  returnType: 'struct Padded',
  aggregate: true,
  returnBits: 72,
  layout: {
    bits: 72,
    bytes: 24,
    members: [
      { bits: 64, bytes: 8, byteOffset: 0 },
      { bits: 8, bytes: 1, byteOffset: 8 },
    ],
    padding: [{ byteOffset: 9, bytes: 15 }],
  },
};

test('6040: padded aggregate over 2*XLEN returns indirectly', () => {
  const result = RISCV_LP64_ABI.classifyFunctionReturn({ functionPrototype: padded24 });
  assert.equal(result?.indirect, true);
  assert.equal(result?.resultLocation, 'memory');
  assert.equal(result?.hiddenResultPointer?.input, 'x10');
});

test('6040: small padded aggregate keeps the padded-layout partial', () => {
  const small = {
    returnType: 'struct Small',
    aggregate: true,
    returnBits: 72,
    layout: {
      bits: 72,
      bytes: 16,
      members: [
        { bits: 64, bytes: 8, byteOffset: 0 },
        { bits: 8, bytes: 1, byteOffset: 8 },
      ],
      padding: [{ byteOffset: 9, bytes: 7 }],
    },
  };
  const result = RISCV_LP64_ABI.classifyFunctionReturn({ functionPrototype: small });
  assert.equal(result?.partial, true);
  assert.match(result?.reason ?? '', /padded-aggregate-return-layout-not-represented/);
});
