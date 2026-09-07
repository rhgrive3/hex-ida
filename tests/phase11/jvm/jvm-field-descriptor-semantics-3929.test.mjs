import assert from 'node:assert/strict';
import { classifyJvmFieldDescriptor, resolveJvmFieldRef } from '../../../js/managed/jvm/field-reference.js';
import { liftJvmMethod } from '../../../js/managed/jvm/lifter.js';

function makeClass(descriptor, bytecode, { fieldTag = 9 } = {}) {
  return {
    moduleId: 'managed-mod:test',
    vmSpecEdition: 'java-se-17',
    thisClassName: 'pkg/Test',
    constantPool: [
      null,
      { tag: 1, value: 'pkg/Owner' },
      { tag: 7, nameIndex: 1 },
      { tag: 1, value: 'value' },
      { tag: 1, value: descriptor },
      { tag: 12, nameIndex: 3, descriptorIndex: 4 },
      fieldTag === 9
        ? { tag: 9, classIndex: 2, nameAndTypeIndex: 5 }
        : { tag: fieldTag, classIndex: 2, nameAndTypeIndex: 5 },
    ],
    methods: [{
      accessFlags: 0x0009,
      name: 'm',
      descriptor: '()V',
      code: {
        maxStack: 8,
        maxLocals: 1,
        offset: 0,
        exceptionTable: [],
        bytecode: Uint8Array.from(bytecode),
      },
    }],
  };
}

function fieldBundle(descriptor, opcode, options = {}) {
  const image = makeClass(descriptor, [opcode, 0x00, 0x06, 0xb1], options);
  return liftJvmMethod(0, image).bundles[0];
}

assert.deepEqual(classifyJvmFieldDescriptor('J'), {
  descriptor: 'J', bits: 64, category: 2, slots: 2, valueKind: 'long',
});
assert.deepEqual(classifyJvmFieldDescriptor('D'), {
  descriptor: 'D', bits: 64, category: 2, slots: 2, valueKind: 'double',
});
assert.deepEqual(classifyJvmFieldDescriptor('Ljava/lang/String;'), {
  descriptor: 'Ljava/lang/String;', bits: 64, category: 1, slots: 1, valueKind: 'reference',
});
assert.deepEqual(classifyJvmFieldDescriptor('[[I'), {
  descriptor: '[[I', bits: 64, category: 1, slots: 1, valueKind: 'reference',
});
for (const invalid of [
  'V', 'Lfoo.bar;', 'L/foo;', 'Lfoo//bar;', '[V', '[[', `${'['.repeat(256)}I`,
  'constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__',
]) {
  assert.equal(classifyJvmFieldDescriptor(invalid), null, `must reject invalid field descriptor ${invalid}`);
}

const resolved = resolveJvmFieldRef(makeClass('J', [0xb2, 0, 6]), 6);
assert.equal(resolved?.owner, 'pkg/Owner');
assert.equal(resolved?.name, 'value');
assert.equal(resolved?.descriptor, 'J');
assert.equal(resolved?.slots, 2);

const getLong = fieldBundle('J', 0xb2);
assert.equal(getLong.completeness, 'exact');
assert.deepEqual(getLong.producedValues, [{ bits: 64, category: 2, valueKind: 'long', descriptor: 'J' }]);
assert.equal(getLong.memoryEffects[0].valueBits, 64);
assert.equal(getLong.memoryEffects[0].valueCategory, 2);
assert.equal(getLong.memoryEffects[0].descriptor, 'J');

const putDouble = fieldBundle('D', 0xb3);
assert.equal(putDouble.completeness, 'exact');
assert.deepEqual(putDouble.consumedValues, [{ id: 'val', bits: 64, category: 2, valueKind: 'double', descriptor: 'D' }]);
assert.equal(putDouble.memoryEffects[0].valueCategory, 2);

const getReference = fieldBundle('Ljava/lang/String;', 0xb4);
assert.equal(getReference.completeness, 'exact');
assert.deepEqual(getReference.consumedValues, [{ id: 'obj', bits: 64, category: 1, valueKind: 'reference' }]);
assert.deepEqual(getReference.producedValues, [{ bits: 64, category: 1, valueKind: 'reference', descriptor: 'Ljava/lang/String;' }]);
assert.equal(getReference.memoryEffects[0].space, 'field');

const putArray = fieldBundle('[I', 0xb5);
assert.equal(putArray.completeness, 'exact');
assert.deepEqual(putArray.consumedValues, [
  { id: 'val', bits: 64, category: 1, valueKind: 'reference', descriptor: '[I' },
  { id: 'obj', bits: 64, category: 1, valueKind: 'reference' },
]);

const getInt = fieldBundle('I', 0xb2);
assert.equal(getInt.completeness, 'exact');
assert.deepEqual(getInt.producedValues, [{ bits: 32, category: 1, valueKind: 'int', descriptor: 'I' }]);

for (const bundle of [
  fieldBundle('J', 0xb2, { fieldTag: 10 }),
  fieldBundle('V', 0xb2),
]) {
  assert.equal(bundle.completeness, 'partial');
  assert.deepEqual(bundle.memoryEffects, []);
  assert.ok(bundle.unknownEffects.some((effect) => effect.category === 'types'));
  assert.ok(bundle.unknownEffects.some((effect) => effect.category === 'stack'));
  assert.ok(bundle.unknownEffects.some((effect) => effect.category === 'memory'));
}

console.log('jvm field descriptor semantics #3929: PASS');
