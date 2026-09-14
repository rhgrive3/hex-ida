import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyDarwinArm64Arguments } from '../../../js/targets/abi/darwin-arm64.js';

/* AAPCS64 Stage C (adopted by the Apple arm64 ABI): an HFA/HVA that cannot
 * fit the remaining SIMD/FP registers sets NSRN to 8 and spills to the
 * stack. The FP bank is then exhausted — a later scalar FP argument must
 * not re-enter the v-register path through a stale cursor (#5605). */

const sixDoubles = () => Array.from({ length:6 }, () => ({ type:'double', bits:64 }));
const hfa4 = () => ({
  hfa:true, bits:256, bytes:32, alignmentBytes:8,
  members:Array.from({ length:4 }, (_unused, index) => ({ bits:64, bytes:8, byteOffset:index * 8 })),
});

test('spilled HFA4 exhausts the FP bank; the following double goes to the stack', () => {
  const result = classifyDarwinArm64Arguments({ callPrototype:{
    args:[...sixDoubles(), hfa4(), { type:'double', bits:64 }],
  } });
  const spilled = result.arguments[6];
  assert.equal(spilled.location, 'stack', 'the HFA4 cannot fit the remaining two registers');
  const tail = result.arguments[7];
  assert.equal(tail.location, 'stack', 'NSRN is exhausted after the HFA spill');
  assert.ok(!result.srcs.some((source) => source.reg === 'v6' || source.reg === 'v7'),
    'no v-register input may be published after the bank is exhausted');
});

test('HVA with explicit metadata routes through the FP bank and spills exhaust it', () => {
  const hva4 = {
    hva:true, type:'__m128 x4', bits:512, bytes:64, alignmentBytes:16,
    members:Array.from({ length:4 }, (_unused, index) => ({ bits:128, bytes:16, byteOffset:index * 16 })),
  };
  const result = classifyDarwinArm64Arguments({ callPrototype:{
    args:[...sixDoubles(), hva4, { type:'double', bits:64 }],
  } });
  assert.equal(result.arguments[6].location, 'stack');
  assert.equal(result.arguments[7].location, 'stack');
  assert.ok(!result.srcs.some((source) => source.reg === 'v6' || source.reg === 'v7'));
});

test('a fitting HFA keeps its registers and the bank is exactly full afterwards', () => {
  const hfa2 = {
    hfa:true, bits:128, bytes:16, alignmentBytes:8,
    members:Array.from({ length:2 }, (_unused, index) => ({ bits:64, bytes:8, byteOffset:index * 8 })),
  };
  const result = classifyDarwinArm64Arguments({ callPrototype:{
    args:[...sixDoubles(), hfa2, { type:'double', bits:64 }],
  } });
  assert.equal(result.arguments[6].location, 'register');
  assert.deepEqual(result.arguments[6].regs, ['v6', 'v7']);
  assert.equal(result.arguments[7].location, 'stack');
});

test('HFA fitting exactly into the remaining registers keeps later FP scalars on the stack', () => {
  const hfa2 = {
    hfa:true, bits:128, bytes:16, alignmentBytes:8,
    members:Array.from({ length:2 }, (_unused, index) => ({ bits:64, bytes:8, byteOffset:index * 8 })),
  };
  const result = classifyDarwinArm64Arguments({ callPrototype:{
    args:[...sixDoubles(), hfa2, { type:'double', bits:64 }],
  } });
  assert.equal(result.arguments[6].location, 'register');
  assert.deepEqual(result.arguments[6].regs, ['v6', 'v7']);
  assert.equal(result.arguments[7].location, 'stack', 'the bank is legitimately full now');
});

test('GP bank exhaustion does not consume FP registers', () => {
  const gps = Array.from({ length:9 }, () => ({ type:'uint64_t', bits:64 }));
  const result = classifyDarwinArm64Arguments({ callPrototype:{
    args:[...gps, { type:'double', bits:64 }],
  } });
  assert.equal(result.arguments[9].location, 'register');
  assert.equal(result.arguments[9].reg, 'v0');
});
