import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyAAPCS64Arguments } from '../../../js/targets/abi/aapcs64-core.js';

/* Issue #6035: AAPCS64 Stage B.4 keys on the composite's physical size.
 * Trailing padding/over-alignment can push the object extent past 16 bytes
 * while the logical payload stays within 128 bits; such an argument must be
 * replaced by a pointer to a caller copy, not passed by value. */
const U64 = { type:'uint64_t', bits:64 };
const PADDED = {
  type:'struct Padded',
  aggregate:true,
  bits:72,
  alignment:32,
  layout:{
    bits:72,
    bytes:32,
    members:[
      { bits:64, bytes:8, byteOffset:0 },
      { bits:8, bytes:1, byteOffset:8 },
    ],
    padding:[{ byteOffset:9, bytes:23 }],
  },
};

test('#6035: physical 32-byte / logical 72-bit aggregate after GPR exhaustion becomes a stack indirect pointer', () => {
  const args = classifyAAPCS64Arguments({
    callPrototype:{ args:[...Array.from({ length:8 }, () => ({ ...U64 })), PADDED] },
  }).arguments;
  const arg = args[8];
  assert.equal(arg.location, 'stack');
  assert.equal(arg.abiClass, 'aggregate-indirect-copy');
  assert.equal(arg.pointer, true);
  assert.equal(arg.bits, 64);
  assert.equal(arg.bytes, 8);
  assert.equal(arg.pointeeBits, 72);
  assert.equal(arg.pointeeBytes, 32);
  assert.equal(arg.offset, 0, 'the pointer occupies one 8-byte stack slot');
});

test('#6035: the same aggregate with registers free takes the pointer in a GP register', () => {
  const arg = classifyAAPCS64Arguments({ callPrototype:{ args:[PADDED] } }).arguments[0];
  assert.equal(arg.location, 'register');
  assert.equal(arg.reg, 'x0');
  assert.equal(arg.abiClass, 'aggregate-indirect-copy');
  assert.equal(arg.pointer, true);
  assert.equal(arg.callerCopy, true);
});

test('#6035: exact 16-byte / 128-bit aggregate keeps direct two-register placement', () => {
  const sixteen = {
    type:'struct S16', aggregate:true, bits:128, bytes:16,
    members:[{ bits:64, bytes:8, byteOffset:0 }, { bits:64, bytes:8, byteOffset:8 }],
  };
  const arg = classifyAAPCS64Arguments({ callPrototype:{ args:[sixteen] } }).arguments[0];
  assert.equal(arg.location, 'registers');
  assert.deepEqual(arg.regs, ['x0','x1']);
  assert.equal(arg.pointer, false);
});

test('#6035: proven >128-bit aggregate keeps the existing indirect path', () => {
  const big = {
    type:'struct Big', aggregate:true, bits:192,
    layout:{
      bits:192, bytes:24,
      members:[
        { bits:64, bytes:8, byteOffset:0 },
        { bits:64, bytes:8, byteOffset:8 },
        { bits:64, bytes:8, byteOffset:16 },
      ],
      padding:[],
    },
  };
  const arg = classifyAAPCS64Arguments({ callPrototype:{ args:[big] } }).arguments[0];
  assert.equal(arg.abiClass, 'aggregate-indirect-copy');
  assert.equal(arg.pointer, true);
});

test('#6035: stack placement after the indirect pointer continues from the 8-byte extent', () => {
  const args = classifyAAPCS64Arguments({
    callPrototype:{ args:[...Array.from({ length:8 }, () => ({ ...U64 })), PADDED, { ...U64 }] },
  }).arguments;
  assert.equal(args[8].abiClass, 'aggregate-indirect-copy');
  assert.equal(args[8].offset, 0);
  assert.equal(args[9].location, 'stack');
  assert.equal(args[9].offset, 8);
});

test('#6035: HFAs keep their own register/spill semantics instead of the pointer rule', () => {
  const h4 = {
    type:'struct H4', aggregate:true, hfa:true, bits:256, bytes:32,
    layout:{
      bits:256, bytes:32,
      members:[
        { bits:64, bytes:8, byteOffset:0 },
        { bits:64, bytes:8, byteOffset:8 },
        { bits:64, bytes:8, byteOffset:16 },
        { bits:64, bytes:8, byteOffset:24 },
      ],
      padding:[],
    },
  };
  const free = classifyAAPCS64Arguments({ callPrototype:{ args:[h4] } }).arguments[0];
  assert.deepEqual(free.regs, ['v0','v1','v2','v3']);
  const spilled = classifyAAPCS64Arguments({
    callPrototype:{ args:[...Array.from({ length:8 }, () => ({ type:'double' })), h4] },
  }).arguments[8];
  assert.equal(spilled.location, 'stack');
  assert.equal(spilled.abiClass, 'hfa');
  assert.equal(spilled.bytes, 32);
  assert.equal(spilled.pointer, false);
});
