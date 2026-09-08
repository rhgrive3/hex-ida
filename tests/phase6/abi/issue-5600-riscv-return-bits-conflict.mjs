import assert from 'node:assert/strict';
import test from 'node:test';

import { RISCV_LP64_ABI, RISCV_LP64D_ABI } from '../../../js/targets/abi/riscv-lp64.js';

const CONFLICTING_PROTOTYPE = Object.freeze({
  aggregate: true,
  returnBits: 64,
  bits: 32,
  bytes: 8,
  members: [ { bits: 64, bytes: 8, byteOffset: 0 } ],
  padding: [],
  returnsValue: true,
});

const CONSISTENT_PROTOTYPE = Object.freeze({
  aggregate: true,
  returnBits: 64,
  bits: 64,
  bytes: 8,
  members: [ { bits: 64, bytes: 8, byteOffset: 0 } ],
  padding: [],
  returnsValue: true,
});

const RETURN_BITS_ONLY_PROTOTYPE = Object.freeze({
  aggregate: true,
  returnBits: 64,
  bytes: 8,
  members: [ { bits: 64, bytes: 8, byteOffset: 0 } ],
  padding: [],
  returnsValue: true,
});

test('#5600 contradictory returnBits/bits must fail closed as layout-unproven', () => {
  const result = RISCV_LP64_ABI.classifyFunctionReturn({ functionPrototype: CONFLICTING_PROTOTYPE });
  assert.ok(result, 'classification must produce a record');
  assert.equal(result.partial, true);
  assert.equal(result.reg, null);
  assert.equal(result.bits, null);
  assert.match(result.reason, /aggregate-return-size-layout-unproven$/);
  assert.equal(result.reason, 'lp64-aggregate-return-size-layout-unproven');
});

test('#5600 an explicitly present undefined bits alias must remain layout-unproven', () => {
  const malformed = { ...RETURN_BITS_ONLY_PROTOTYPE, bits: undefined };
  assert.equal(Object.hasOwn(malformed, 'bits'), true);
  const result = RISCV_LP64_ABI.classifyFunctionReturn({ functionPrototype: malformed });
  assert.ok(result, 'classification must produce a record');
  assert.equal(result.partial, true);
  assert.equal(result.reg, null);
  assert.equal(result.bits, null);
  assert.equal(result.reason, 'lp64-aggregate-return-size-layout-unproven');
});

test('#5600 consistent returnBits/bits aliases keep the canonical aggregate return', () => {
  const result = RISCV_LP64_ABI.classifyFunctionReturn({ functionPrototype: CONSISTENT_PROTOTYPE });
  assert.ok(result);
  assert.equal(result.aggregate, true);
  assert.equal(result.bits, 64);
  assert.equal(result.reg, 'x10');
  assert.equal(result.partial, undefined);
});

test('#5600 lp64d soft/hard float variants reject the same contradiction', () => {
  const result = RISCV_LP64D_ABI.classifyFunctionReturn({ functionPrototype: CONFLICTING_PROTOTYPE });
  assert.ok(result);
  assert.equal(result.partial, true);
  assert.match(result.reason, /aggregate-return-size-layout-unproven$/);
});

test('#5600 returnBits-only prototypes still normalize through the shared canonicalizer', () => {
  assert.equal(Object.hasOwn(RETURN_BITS_ONLY_PROTOTYPE, 'bits'), false);
  const result = RISCV_LP64_ABI.classifyFunctionReturn({
    functionPrototype: RETURN_BITS_ONLY_PROTOTYPE,
  });
  assert.ok(result);
  assert.equal(result.aggregate, true);
  assert.equal(result.bits, 64);
  assert.equal(result.reg, 'x10');
});
