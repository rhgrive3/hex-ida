import assert from 'node:assert/strict';
import test from 'node:test';

import { classifySysVAMD64Arguments } from '../../../js/targets/abi/sysv-amd64.js';

/* Issue #6008: the psABI requires a MEMORY-class argument to be passed at an
 * address respecting its own alignment, which may exceed 16 (e.g.
 * _Alignas(512)). The classifier clamped the requirement to 16 and minted a
 * stack location the real ABI never produces (clang places the aggregate at
 * +32 after the first stack scalar). */
const LONG = { type:'long' };
const MEMORY_AGGREGATE = (alignment) => ({
  type:'struct S32',
  aggregate:true,
  bits:192,
  bytes:32,
  alignment,
  eightbyteClasses:['MEMORY'],
  members:[
    { bits:64, bytes:8, byteOffset:0 },
    { bits:64, bytes:8, byteOffset:8 },
    { bits:64, bytes:8, byteOffset:16 },
  ],
  padding:[{ offset:24, bytes:8 }],
});

function classify(alignment, tail = []) {
  const args = [LONG, LONG, LONG, LONG, LONG, LONG, LONG, MEMORY_AGGREGATE(alignment), ...tail];
  return classifySysVAMD64Arguments({ callPrototype:{ args } }).arguments;
}

test('#6008: MEMORY aggregate with explicit 32-byte alignment is placed at a 32-byte aligned stack offset', () => {
  const args = classify(32, [LONG]);
  const aggregate = args[7];
  assert.equal(aggregate.location, 'stack');
  assert.equal(aggregate.offset, 32);
  assert.equal(aggregate.calleeEntryOffset, 40);
  assert.equal(aggregate.abiClass, 'aggregate-memory');
  assert.equal(aggregate.bits, 192);
  assert.equal(aggregate.bytes, 32);
  assert.equal(aggregate.pieces[0].stackOffset, 32);
  const tail = args[8];
  assert.equal(tail.location, 'stack');
  assert.equal(tail.offset, 64, 'following stack arguments must continue after the over-aligned aggregate');
});

test('#6008: explicit 64-byte alignment is honored instead of clamped', () => {
  const args = classify(64);
  assert.equal(args[7].location, 'stack');
  assert.equal(args[7].offset, 64);
});

test('#6008: 16-byte alignment behavior is preserved', () => {
  const args = classify(16);
  assert.equal(args[7].offset, 16);
  assert.equal(args[7].calleeEntryOffset, 24);
});

test('#6008: ordinary 8-byte aligned MEMORY aggregate placement is unchanged', () => {
  const args = classify(8);
  assert.equal(args[7].offset, 8);
});

test('#6008: x87 long double stack placement stays 16-byte aligned', () => {
  const args = classifySysVAMD64Arguments({
    callPrototype:{ args:[LONG, LONG, LONG, LONG, LONG, LONG, { type:'long double' }] },
  }).arguments;
  const x87 = args[6];
  assert.equal(x87.location, 'stack');
  assert.equal(x87.offset, 0);
  assert.equal(x87.alignment, 16);
});

test('#6008: register-passed aggregates are unaffected', () => {
  const args = classifySysVAMD64Arguments({
    callPrototype:{ args:[{
      type:'struct P', aggregate:true, bits:128, bytes:16,
      eightbyteClasses:['INTEGER','INTEGER'],
    }] },
  }).arguments;
  assert.equal(args[0].location, 'registers');
  assert.deepEqual(args[0].regs, ['rdi','rsi']);
});
