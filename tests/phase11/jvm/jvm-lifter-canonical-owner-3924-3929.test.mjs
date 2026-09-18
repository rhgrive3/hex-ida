import assert from 'node:assert/strict';
import { liftJvmMethod } from '../../../js/managed/jvm/lifter.js';

const jvmClass = {
  moduleId: 'managed-mod:test:canonical-jvm-lifter',
  vmSpecEdition: 'java-se-17',
  thisClassName: 'pkg/Test',
  // #7861: the declared field row binds the (non-volatile) access-flag
  // authority for the internal owner.
  fields: [{ accessFlags: 0, name: 'value', descriptor: 'J' }],
  constantPool: [
    null,
    { tag: 1, value: 'pkg/Test' },
    { tag: 7, nameIndex: 1 },
    { tag: 1, value: 'value' },
    { tag: 1, value: 'J' },
    { tag: 12, nameIndex: 3, descriptorIndex: 4 },
    { tag: 9, classIndex: 2, nameAndTypeIndex: 5 },
  ],
  methods: [{
    accessFlags: 0x0009,
    name: 'm',
    descriptor: '()V',
    code: {
      maxStack: 4,
      maxLocals: 1,
      offset: 0x240,
      exceptionTable: [],
      // First instruction proves #3929 typed field semantics. The second
      // getstatic is deliberately truncated and proves #3924 boundary closure.
      bytecode: Uint8Array.from([0xb2, 0x00, 0x06, 0xb2, 0x00]),
    },
  }],
};

const lifted = liftJvmMethod(0, jvmClass);
assert.equal(lifted.aggregateCompleteness, 'partial');
assert.equal(lifted.bundles.length, 2);

const [field, malformed] = lifted.bundles;
assert.equal(field.mnemonic, 'getstatic');
assert.equal(field.completeness, 'exact');
assert.deepEqual(field.producedValues, [{
  bits: 64,
  category: 2,
  valueKind: 'long',
  descriptor: 'J',
}]);
assert.equal(field.memoryEffects[0].descriptor, 'J');
assert.equal(field.memoryEffects[0].valueBits, 64);
assert.equal(field.memoryEffects[0].valueCategory, 2);

assert.equal(malformed.opcode, 0xb2);
assert.equal(malformed.bytecodeOffset, 3);
assert.equal(malformed.completeness, 'partial');
assert.match(malformed.unknownEffects[0].reason, /malformed-boundary$/);
assert.deepEqual(malformed.producedValues, []);
assert.deepEqual(malformed.memoryEffects, []);

console.log('canonical JVM lifter owner #3924/#3929: PASS');
