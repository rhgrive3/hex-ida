import assert from 'node:assert/strict';
import { liftJvmMethod } from '../js/managed/jvm/lifter.js';
import { lowerVMEffectsToSemanticIr } from '../js/managed/shared/bridge-v2.js';

const cls = {
  moduleId: 'managed-mod:ref-width-repro',
  vmSpecEdition: 'java-se-17',
  thisClassName: 'pkg/Test',
  fields: [{ accessFlags: 0, name: 'value', descriptor: 'Ljava/lang/String;' }],
  constantPool: [
    null,
    { tag: 1, value: 'pkg/Test' },
    { tag: 7, nameIndex: 1 },
    { tag: 1, value: 'value' },
    { tag: 1, value: 'Ljava/lang/String;' },
    { tag: 12, nameIndex: 3, descriptorIndex: 4 },
    { tag: 9, classIndex: 2, nameAndTypeIndex: 5 },
  ],
  methods: [{
    accessFlags: 0x0009,
    name: 'm',
    descriptor: '()V',
    code: {
      maxStack: 1,
      maxLocals: 0,
      offset: 0,
      exceptionTable: [],
      bytecode: Uint8Array.from([
        0x01,       // aconst_null
        0xb4, 0, 6, // getfield pkg/Test.value:Ljava/lang/String;
        0x57,       // pop
        0xb1,       // return
      ]),
    },
  }],
};

const fn = liftJvmMethod(0, cls);
const aconstNull = fn.bundles[0];
const getfield = fn.bundles[1];

assert.equal(aconstNull.producedValues[0].bits, 32);
assert.equal(getfield.consumedValues[0].bits, 32);
assert.equal(getfield.producedValues[0].bits, 32);

const ir = lowerVMEffectsToSemanticIr(fn);
assert.ok(ir.semanticIr);

console.log('issue-9243-jvm-reference-width: PASS');
