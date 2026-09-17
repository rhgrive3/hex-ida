import assert from 'node:assert/strict';
import test from 'node:test';

import { liftJvmMethod } from '../../../js/managed/jvm/lifter.js';
import { lowerVMEffectsToSemanticIr } from '../../../js/managed/shared/bridge-v2.js';

function image(bytecode, descriptor = '()V', { maxStack = 8, maxLocals = 8 } = {}) {
  return {
    moduleId: 'managed-mod:issue-5304',
    vmSpecEdition: 'java-se-17',
    thisClassName: 'pkg/Test',
    fields: [],
    constantPool: [
      null,
      { tag: 1, value: 'java/lang/String' },
      { tag: 7, nameIndex: 1 },
      { tag: 1, value: '[[I' },
      { tag: 7, nameIndex: 3 },
    ],
    methods: [{
      accessFlags: 0x0009,
      name: 'f',
      descriptor,
      code: {
        maxStack,
        maxLocals,
        offset: 0,
        exceptionTable: [],
        bytecode: Uint8Array.from(bytecode),
      },
    }],
  };
}

const LOADS = [
  [0x2e, 'iaload', 4, 32, 'int'],
  [0x2f, 'laload', 8, 64, 'long'],
  [0x30, 'faload', 4, 32, 'float'],
  [0x31, 'daload', 8, 64, 'double'],
  [0x32, 'aaload', 4, 32, 'reference'],
  [0x33, 'baload', 1, 32, 'byte-or-boolean'],
  [0x34, 'caload', 2, 32, 'char'],
  [0x35, 'saload', 2, 32, 'short'],
];

const STORES = [
  [0x4f, 'iastore', 4, 32, 'int'],
  [0x50, 'lastore', 8, 64, 'long'],
  [0x51, 'fastore', 4, 32, 'float'],
  [0x52, 'dastore', 8, 64, 'double'],
  [0x53, 'aastore', 4, 32, 'reference'],
  [0x54, 'bastore', 1, 32, 'byte-or-boolean'],
  [0x55, 'castore', 2, 32, 'char'],
  [0x56, 'sastore', 2, 32, 'short'],
];

test('#5304 xaload family preserves arrayref/index, element width/type and runtime exceptions', () => {
  for (const [opcode, mnemonic, byteWidth, bits, valueKind] of LOADS) {
    const fn = liftJvmMethod(0, image([opcode]));
    const bundle = fn.bundles[0];
    assert.equal(bundle.mnemonic, mnemonic);
    assert.equal(bundle.completeness, 'partial');
    assert.deepEqual(bundle.consumedValues.map((value) => value.id), ['index', 'arrayref']);
    assert.equal(bundle.producedValues[0].bits, bits);
    assert.equal(bundle.producedValues[0].valueKind, valueKind);
    assert.equal(bundle.memoryEffects.length, 1);
    assert.equal(bundle.memoryEffects[0].space, 'array-element');
    assert.equal(bundle.memoryEffects[0].isWrite, false);
    assert.equal(bundle.memoryEffects[0].byteWidth, byteWidth);
    assert.deepEqual(bundle.possibleExceptions.map((entry) => entry.kind), [
      'null-reference',
      'array-index-out-of-bounds',
    ]);
    assert.ok(bundle.unknownEffects.some((entry) => entry.reason === 'jvm-array-index-address-unrepresented'));
  }
});

test('#5304 xastore family preserves arrayref/index/value and exact element storage width', () => {
  for (const [opcode, mnemonic, byteWidth, bits, valueKind] of STORES) {
    const fn = liftJvmMethod(0, image([opcode]));
    const bundle = fn.bundles[0];
    assert.equal(bundle.mnemonic, mnemonic);
    assert.equal(bundle.completeness, 'partial');
    assert.deepEqual(bundle.consumedValues.map((value) => value.id), ['value', 'index', 'arrayref']);
    assert.equal(bundle.consumedValues[0].bits, bits);
    assert.equal(bundle.consumedValues[0].valueKind, valueKind);
    assert.equal(bundle.memoryEffects[0].space, 'array-element');
    assert.equal(bundle.memoryEffects[0].isWrite, true);
    assert.equal(bundle.memoryEffects[0].byteWidth, byteWidth);
    const exceptionKinds = bundle.possibleExceptions.map((entry) => entry.kind);
    assert.ok(exceptionKinds.includes('null-reference'));
    assert.ok(exceptionKinds.includes('array-index-out-of-bounds'));
    assert.equal(exceptionKinds.includes('array-store'), opcode === 0x53);
  }
});

test('#5304 newarray/anewarray/multianewarray publish fresh array allocation identity and fail closed on heap effects', () => {
  const primitive = liftJvmMethod(0, image([0x04, 0xbc, 0x0a, 0xb0], '()[I')).bundles.find((entry) => entry.opcode === 0xbc);
  assert.equal(primitive.producedValues[0].valueType, '[I');
  assert.equal(primitive.producedValues[0].referenceKind, 'new-array-allocation');
  assert.equal(primitive.producedValues[0].allocationState, 'initialized');
  assert.equal(primitive.producedValues[0].fresh, true);
  assert.match(primitive.producedValues[0].allocationId, /^jvm-allocation:/);
  assert.equal(primitive.producedValues[0].arrayElementByteWidth, 4);
  assert.equal(primitive.possibleExceptions[0].kind, 'negative-array-size');

  const reference = liftJvmMethod(0, image([0x04, 0xbd, 0x00, 0x02, 0xb0], '()[Ljava/lang/String;')).bundles.find((entry) => entry.opcode === 0xbd);
  assert.equal(reference.producedValues[0].valueType, '[Ljava/lang/String;');
  assert.equal(reference.producedValues[0].arrayComponentType, 'java/lang/String');
  assert.equal(reference.producedValues[0].fresh, true);

  const multi = liftJvmMethod(0, image([0x04, 0x04, 0xc5, 0x00, 0x04, 0x02, 0xb0], '()[[I')).bundles.find((entry) => entry.opcode === 0xc5);
  assert.equal(multi.producedValues[0].valueType, '[[I');
  assert.equal(multi.producedValues[0].arrayDimensions, 2);
  assert.equal(multi.producedValues[0].arrayRank, 2);
  assert.deepEqual(multi.consumedValues.map((value) => value.id), ['dimension_1', 'dimension_0']);
  assert.equal(multi.producedValues[0].fresh, true);
});

test('#5304 arraylength preserves reference dependency and null exception authority', () => {
  const fn = liftJvmMethod(0, image([0x2a, 0xbe, 0xac], '([I)I', { maxLocals: 1, maxStack: 1 }));
  const bundle = fn.bundles.find((entry) => entry.opcode === 0xbe);
  assert.equal(bundle.mnemonic, 'arraylength');
  assert.equal(bundle.consumedValues[0].id, 'arrayref');
  assert.equal(bundle.consumedValues[0].type.addressSpace, 'managed-heap');
  assert.equal(bundle.producedValues[0].bits, 32);
  assert.equal(bundle.possibleExceptions[0].kind, 'null-reference');
  assert.equal(bundle.completeness, 'partial');
});

test('#5304 bridge keeps array memory effects visible instead of default unsupported opcode', () => {
  const fn = liftJvmMethod(0, image(
    [0x2a, 0x1b, 0x2e, 0xac],
    '([II)I',
    { maxLocals: 2, maxStack: 2 },
  ));
  const lowered = lowerVMEffectsToSemanticIr(fn);
  const node = lowered.semanticIr.nodes.find((entry) => entry.metadata?.mnemonic === 'iaload');
  assert.ok(node);
  assert.equal(node.kind, 'load');
  assert.equal(node.memory.addressSpace, 'array-element');
  assert.equal(node.memory.widthBits, 32);
  assert.equal(node.completeness, 'partial');
  assert.ok(node.inputs.length >= 2, 'arrayref/index dataflow remains attached to the load');
});

test('#5304 invalid allocation operands fail closed without fabricated array authority', () => {
  const invalidType = liftJvmMethod(0, image([0x04, 0xbc, 0x03]));
  const newarray = invalidType.bundles.find((entry) => entry.opcode === 0xbc);
  assert.equal(newarray.completeness, 'partial');
  assert.equal(newarray.producedValues.length, 0);
  assert.ok(newarray.unknownEffects.some((entry) => entry.reason === 'jvm-newarray-invalid-atype:3'));

  const validArrayComponent = liftJvmMethod(0, image([0x04, 0xbd, 0x00, 0x04]));
  const anewarray = validArrayComponent.bundles.find((entry) => entry.opcode === 0xbd);
  assert.equal(anewarray.producedValues[0].valueType, '[[[I');

  const invalidDims = liftJvmMethod(0, image([0x04, 0x04, 0xc5, 0x00, 0x04, 0x03]));
  const multi = invalidDims.bundles.find((entry) => entry.opcode === 0xc5);
  assert.equal(multi.completeness, 'partial');
  assert.equal(multi.producedValues.length, 0);
  assert.ok(multi.unknownEffects.some((entry) => entry.reason === 'jvm-multianewarray-dimensions-invalid'));
});
