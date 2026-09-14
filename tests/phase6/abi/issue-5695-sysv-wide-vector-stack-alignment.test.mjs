import assert from 'node:assert/strict';
import test from 'node:test';

import { classifySysVAMD64Arguments } from '../../../js/targets/abi/sysv-amd64.js';

/* SysV AMD64 psABI: `__m256`/`__m512` arguments that do not fit the vector
 * register bank are placed in the incoming argument area aligned to 32/64
 * bytes (the mode width). The stack fallback previously pinned every vector
 * spill to 16-byte alignment (#5695). */

function exhaustedState() {
  return [
    ...Array.from({ length:8 }, () => ({ type:'double', bits:64 })),
    ...Array.from({ length:7 }, () => ({ type:'uint64_t', bits:64 })),
  ];
}

test('__m256 stack spill aligns to 32 bytes', () => {
  const result = classifySysVAMD64Arguments({ callPrototype:{
    args:[...exhaustedState(), { type:'vector', vector:true, bits:256 }],
  } });
  const entry = result.arguments[15];
  assert.equal(entry.location, 'stack');
  assert.equal(entry.bits, 256);
  assert.equal(entry.offset, 32, 'a 256-bit vector spill needs 32-byte alignment');
  assert.equal(entry.calleeEntryOffset, 40);
  assert.equal(entry.alignment, 32);
});

test('__m512 stack spill aligns to 64 bytes', () => {
  const result = classifySysVAMD64Arguments({ callPrototype:{
    args:[...exhaustedState(), { type:'vector', vector:true, bits:512 }],
  } });
  const entry = result.arguments[15];
  assert.equal(entry.location, 'stack');
  assert.equal(entry.bits, 512);
  assert.equal(entry.offset, 64, 'a 512-bit vector spill needs 64-byte alignment');
  assert.equal(entry.alignment, 64);
});

test('following stack arguments continue after the wide vector extent', () => {
  const result = classifySysVAMD64Arguments({ callPrototype:{
    args:[...exhaustedState(), { type:'vector', vector:true, bits:256 }, { type:'uint64_t', bits:64 }],
  } });
  const tail = result.arguments[16];
  assert.equal(tail.location, 'stack');
  assert.equal(tail.offset, 64, 'the tail starts after the 32-byte vector at offset 32');
});

test('128-bit vector spill control keeps 16-byte alignment', () => {
  const result = classifySysVAMD64Arguments({ callPrototype:{
    args:[...exhaustedState(), { type:'vector', vector:true, bits:128 }],
  } });
  const entry = result.arguments[15];
  assert.equal(entry.location, 'stack');
  assert.equal(entry.offset, 16);
  assert.equal(entry.alignment, 16);
});

test('scalar stack spill control keeps 8-byte alignment', () => {
  const result = classifySysVAMD64Arguments({ callPrototype:{
    args:[...exhaustedState(), { type:'uint64_t', bits:64 }],
  } });
  const entry = result.arguments[15];
  assert.equal(entry.location, 'stack');
  assert.equal(entry.offset, 8);
});
