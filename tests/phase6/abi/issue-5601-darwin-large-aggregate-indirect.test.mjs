import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyDarwinArm64Arguments } from '../../../js/targets/abi/darwin-arm64.js';

/* Issue #5601: under AAPCS64 Stage B.4 (also used by Darwin arm64), a
 * composite larger than 16 bytes is copied by the caller and the argument is
 * replaced by a pointer to that copy.  The Darwin classifier split such
 * objects across x0..xN as if they were by-value register arguments. */
const BIG = {
  type:'struct Big',
  aggregate:true,
  bits:192,
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

test('#5601: 24-byte aggregate with registers free is an indirect-copy pointer', () => {
  const arg = classifyDarwinArm64Arguments({ callPrototype:{ args:[BIG] } }).arguments[0];
  assert.equal(arg.location, 'register');
  assert.equal(arg.reg, 'x0');
  assert.equal(arg.abiClass, 'aggregate-indirect-copy');
  assert.equal(arg.pointer, true);
  assert.equal(arg.callerCopy, true);
  assert.equal(arg.pointeeBits, 192);
  assert.equal(arg.pointeeBytes, 24);
});

test('#5601: 32-byte aggregate after GPR exhaustion is a stack indirect pointer', () => {
  const wide = {
    type:'struct Wide', aggregate:true, bits:256,
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
  const args = classifyDarwinArm64Arguments({
    callPrototype:{ args:[...Array.from({ length:8 }, () => ({ type:'uint64_t', bits:64 })), wide, { type:'uint64_t', bits:64 }] },
  }).arguments;
  const arg = args[8];
  assert.equal(arg.location, 'stack');
  assert.equal(arg.abiClass, 'aggregate-indirect-copy');
  assert.equal(arg.pointer, true);
  assert.equal(arg.bytes, 8);
  assert.equal(arg.offset, 0);
  assert.equal(args[9].location, 'stack', 'with GPRs exhausted the next argument follows on the stack');
  assert.equal(args[9].abiClass, 'integer');
  assert.equal(args[9].offset, 8, 'it continues after the pointer slot');
});

test('#5601: aggregates of at most 16 bytes keep direct register placement', () => {
  const small = {
    type:'struct S16', aggregate:true, bits:128,
    layout:{
      bits:128, bytes:16,
      members:[
        { bits:64, bytes:8, byteOffset:0 },
        { bits:64, bytes:8, byteOffset:8 },
      ],
      padding:[],
    },
  };
  const arg = classifyDarwinArm64Arguments({ callPrototype:{ args:[small] } }).arguments[0];
  assert.deepEqual(arg.regs, ['x0','x1']);
  assert.equal(arg.pointer, false);
});
