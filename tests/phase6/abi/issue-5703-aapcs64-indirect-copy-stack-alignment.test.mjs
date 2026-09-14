import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyAAPCS64Arguments } from '../../../js/targets/abi/aapcs64.js';

const u64 = () => ({ type:'uint64_t', bits:64 });
const aggregate = (bits, alignment = 16) => ({
  type:`struct A${bits}`,
  aggregate:true,
  bits,
  alignment,
  layout:{
    bits,
    bytes:bits / 8,
    members:Array.from({ length:bits / 64 }, (_unused, index) => ({
      type:'uint64_t', bits:64, bytes:8, byteOffset:index * 8,
    })),
    padding:[],
  },
});

const classify = (args) => classifyAAPCS64Arguments({ callPrototype:{ args } });

test('#5703 large aggregate replacement pointer uses pointer stack alignment', () => {
  const big = aggregate(192, 16);
  const result = classify([
    ...Array.from({ length:8 }, u64),
    u64(),
    big,
  ]);
  const pointer = result.arguments[9];

  assert.equal(result.arguments[8].offset, 0);
  assert.equal(pointer.location, 'stack');
  assert.equal(pointer.abiClass, 'aggregate-indirect-copy');
  assert.equal(pointer.pointer, true);
  assert.equal(pointer.callerCopy, true);
  assert.equal(pointer.bytes, 8);
  assert.equal(pointer.offset, 8);
  assert.equal(pointer.alignment, 8);
  assert.equal(big.alignment, 16);
});

test('#5703 replacement pointer at initial NSAA stays at zero', () => {
  const result = classify([
    ...Array.from({ length:8 }, u64),
    aggregate(192, 16),
  ]);
  assert.equal(result.arguments[8].offset, 0);
  assert.equal(result.arguments[8].alignment, 8);
});

test('#5703 stack cursor continues from the replacement pointer slot', () => {
  const result = classify([
    ...Array.from({ length:8 }, u64),
    u64(),
    aggregate(192, 16),
    u64(),
  ]);
  assert.equal(result.arguments[8].offset, 0);
  assert.equal(result.arguments[9].offset, 8);
  assert.equal(result.arguments[10].offset, 16);
});

test('#5703 genuine direct 16-byte aggregate keeps 16-byte stack alignment', () => {
  const result = classify([
    ...Array.from({ length:8 }, u64),
    u64(),
    aggregate(128, 16),
  ]);
  const direct = result.arguments[9];
  assert.equal(direct.location, 'stack');
  assert.equal(direct.abiClass, 'aggregate');
  assert.equal(direct.pointer, false);
  assert.equal(direct.offset, 16);
  assert.equal(direct.alignment, 16);
});
