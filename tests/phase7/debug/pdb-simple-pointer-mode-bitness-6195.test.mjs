import test from 'node:test';
import assert from 'node:assert/strict';
import { describeTypeIndex } from '../../../js/analysis/debug/pdb.js';

test('issue #6195: PDB simple type index recognizes 32-bit, 64-bit, and 128-bit pointer modes', () => {
  const dummyTypes = new Map();

  const directInt = describeTypeIndex(0x0074, dummyTypes);
  assert.equal(directInt.name, 'int');
  assert.equal(directInt.widthBits, 32);
  assert.equal(directInt.class, 'integer');
  assert.equal(directInt.complete, true);

  const nearPtr32 = describeTypeIndex(0x0474, dummyTypes);
  assert.equal(nearPtr32.name, 'int *');
  assert.equal(nearPtr32.widthBits, 32);
  assert.equal(nearPtr32.class, 'pointer');
  assert.equal(nearPtr32.complete, true);

  const farPtr32 = describeTypeIndex(0x0574, dummyTypes);
  assert.equal(farPtr32.name, 'int *');
  assert.equal(farPtr32.widthBits, 32);
  assert.equal(farPtr32.class, 'pointer');
  assert.equal(farPtr32.complete, true);

  const nearPtr64 = describeTypeIndex(0x0674, dummyTypes);
  assert.equal(nearPtr64.name, 'int *');
  assert.equal(nearPtr64.widthBits, 64);
  assert.equal(nearPtr64.class, 'pointer');
  assert.equal(nearPtr64.complete, true);

  const nearPtr128 = describeTypeIndex(0x0774, dummyTypes);
  assert.equal(nearPtr128.name, 'int *');
  assert.equal(nearPtr128.widthBits, 128);
  assert.equal(nearPtr128.class, 'pointer');
  assert.equal(nearPtr128.complete, true);

  const voidPtr32 = describeTypeIndex(0x0403, dummyTypes);
  assert.equal(voidPtr32.name, 'void *');
  assert.equal(voidPtr32.widthBits, 32);
  assert.equal(voidPtr32.class, 'pointer');
  assert.equal(voidPtr32.complete, true);

  const unknownPtr32 = describeTypeIndex(0x04ff, dummyTypes);
  assert.equal(unknownPtr32.name, 'unknown *');
  assert.equal(unknownPtr32.widthBits, 32);
  assert.equal(unknownPtr32.class, 'pointer');
  assert.equal(unknownPtr32.complete, false);

  const unknownMode = describeTypeIndex(0x0174, dummyTypes);
  assert.equal(unknownMode.name, 'unknown');
  assert.equal(unknownMode.complete, false);
});
