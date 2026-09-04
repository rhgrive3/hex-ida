import test from 'node:test';
import assert from 'node:assert/strict';
import { describeTypeIndex } from '../js/analysis/debug/pdb.js';

test('issue #6195: PDB simple type index recognizes 32-bit, 64-bit, and 128-bit pointer modes', () => {
  const dummyTypes = new Map();

  // 1. Direct primitive (int: 0x0074)
  const directInt = describeTypeIndex(0x0074, dummyTypes);
  assert.equal(directInt.name, 'int');
  assert.equal(directInt.widthBits, 32);
  assert.equal(directInt.class, 'integer');
  assert.equal(directInt.complete, true);

  // 2. NearPointer32 | int (0x0400 | 0x0074 = 0x0474)
  const nearPtr32 = describeTypeIndex(0x0474, dummyTypes);
  assert.equal(nearPtr32.name, 'int *');
  assert.equal(nearPtr32.widthBits, 32);
  assert.equal(nearPtr32.class, 'pointer');
  assert.equal(nearPtr32.complete, true);

  // 3. FarPointer32 | int (0x0500 | 0x0074 = 0x0574)
  const farPtr32 = describeTypeIndex(0x0574, dummyTypes);
  assert.equal(farPtr32.name, 'int *');
  assert.equal(farPtr32.widthBits, 32);
  assert.equal(farPtr32.class, 'pointer');
  assert.equal(farPtr32.complete, true);

  // 4. NearPointer64 | int (0x0600 | 0x0074 = 0x0674)
  const nearPtr64 = describeTypeIndex(0x0674, dummyTypes);
  assert.equal(nearPtr64.name, 'int *');
  assert.equal(nearPtr64.widthBits, 64);
  assert.equal(nearPtr64.class, 'pointer');
  assert.equal(nearPtr64.complete, true);

  // 5. NearPointer128 | int (0x0700 | 0x0074 = 0x0774)
  const nearPtr128 = describeTypeIndex(0x0774, dummyTypes);
  assert.equal(nearPtr128.name, 'int *');
  assert.equal(nearPtr128.widthBits, 128);
  assert.equal(nearPtr128.class, 'pointer');
  assert.equal(nearPtr128.complete, true);

  // 6. NearPointer32 | void (0x0400 | 0x0003 = 0x0403)
  const voidPtr32 = describeTypeIndex(0x0403, dummyTypes);
  assert.equal(voidPtr32.name, 'void *');
  assert.equal(voidPtr32.widthBits, 32);
  assert.equal(voidPtr32.class, 'pointer');
  assert.equal(voidPtr32.complete, true);

  // 7. Unknown base kind under NearPointer32 (e.g. 0x04ff)
  const unknownPtr32 = describeTypeIndex(0x04ff, dummyTypes);
  assert.equal(unknownPtr32.name, 'unknown *');
  assert.equal(unknownPtr32.widthBits, 32);
  assert.equal(unknownPtr32.class, 'pointer');
  assert.equal(unknownPtr32.complete, false);

  // 8. Unsupported mode (e.g. 0x0100) fails closed as unknown
  const unknownMode = describeTypeIndex(0x0174, dummyTypes);
  assert.equal(unknownMode.name, 'unknown');
  assert.equal(unknownMode.complete, false);
});

console.log('issue #6195 test file loaded.');
