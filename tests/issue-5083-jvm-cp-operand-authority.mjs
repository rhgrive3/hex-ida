// Regression for #5083: managed bytecode reference operands must be checked
// against the canonical table entry the opcode contract requires before the
// lifter mints `exact` VM facts. A `ldc2_w` naming a Utf8, an invoke naming a
// non-Methodref/out-of-range index, or new/checkcast/instanceof naming a
// non-Class must fail closed to partial with the fabricated effect withheld,
// never publish false exact semantics (JVMS 6.5/4.4; ldc precedent 8004).
import assert from 'node:assert/strict';
import test from 'node:test';

import { liftJvmMethod } from '../js/managed/jvm/lifter.js';
import { liftDexMethod } from '../js/managed/dex/lifter.js';
import { dexMethod } from './phase11/fixtures/medium-dex.mjs';

function klass(bytecode, constantPool) {
  return {
    moduleId: 'managed-mod:test:jvm:5083',
    vmSpecEdition: 'java-se-17',
    thisClassName: 'T',
    constantPool,
    methods: [{
      accessFlags: 0x0008,
      name: 'm',
      descriptor: '()V',
      code: {
        maxStack: 4,
        maxLocals: 1,
        bytecode: Uint8Array.from(bytecode),
        exceptionTable: [],
        offset: 0x100,
      },
    }],
  };
}

const pool = [null,
  { tag: 1, value: 'T' },                              // 1 Utf8
  { tag: 1, value: 'java/lang/Runnable' },             // 2 Utf8
  { tag: 1, value: 'm' },                              // 3 Utf8
  { tag: 1, value: '()V' },                            // 4 Utf8
  { tag: 1, value: 'C' },                              // 5 Utf8 — wrong-kind target
  { tag: 7, nameIndex: 1 },                            // 6 Class "T"
  { tag: 12, nameIndex: 3, descriptorIndex: 4 },       // 7 NameAndType "m:()V"
  { tag: 10, classIndex: 6, nameAndTypeIndex: 7 },     // 8 Methodref
  { tag: 11, classIndex: 6, nameAndTypeIndex: 7 },     // 9 InterfaceMethodref
  { tag: 3, value: 42 },                               // 10 Integer
];

const reasons = (bundle) => bundle.unknownEffects.map((u) => u.reason);

test('#5083 ldc2_w naming a Utf8 entry is never an exact 64-bit constant (AC1)', () => {
  const fn = liftJvmMethod(0, klass([0x14, 0x00, 0x05, 0x58, 0xb1], pool));
  const bundle = fn.bundles[0];
  assert.equal(bundle.mnemonic, 'ldc2_w');
  assert.equal(bundle.completeness, 'partial');
  assert.deepEqual(bundle.producedValues, []);
  assert.ok(reasons(bundle).includes('jvm-ldc-constant-unresolved:5'));
  assert.notEqual(fn.aggregateCompleteness, 'exact');
});

test('#5083 invoke opcodes reject out-of-range and wrong-kind CP operands (AC2/AC4)', () => {
  const cases = [
    ['invokevirtual #5 Utf8', [0xb6, 0x00, 0x05, 0xb1], 5],
    ['invokespecial #10 Integer', [0xb7, 0x00, 0x0a, 0xb1], 10],
    ['invokestatic out-of-range', [0xb8, 0x00, 0x63, 0xb1], 99],
    ['invokeinterface #8 Methodref', [0xb9, 0x00, 0x08, 0x01, 0x00, 0xb1], 8],
    ['invokevirtual #9 InterfaceMethodref', [0xb6, 0x00, 0x09, 0xb1], 9],
  ];
  for (const [name, bytecode, idx] of cases) {
    const fn = liftJvmMethod(0, klass(bytecode, pool));
    const bundle = fn.bundles[0];
    assert.equal(bundle.completeness, 'partial', name);
    assert.deepEqual(bundle.callEffects, [], name);
    assert.ok(reasons(bundle).includes(`jvm-method-reference-unresolved:${idx}`), name);
    assert.notEqual(fn.aggregateCompleteness, 'exact', name);
  }
});

test('#5083 field opcodes reject a non-Fieldref operand (AC3)', () => {
  const fn = liftJvmMethod(0, klass([0x01, 0xb4, 0x00, 0x08, 0x57, 0xb1], pool));
  const bundle = fn.bundles.find((b) => b.opcode === 0xb4);
  assert.equal(bundle.completeness, 'partial');
  assert.ok(reasons(bundle).includes('unresolved-jvm-field-reference'));
  assert.deepEqual(bundle.memoryEffects, []);
  assert.notEqual(fn.aggregateCompleteness, 'exact');
});

test('#5083 new/checkcast/instanceof reject non-Class and out-of-range operands (AC5)', () => {
  const cases = [
    ['new #5 Utf8', [0xbb, 0x00, 0x05, 0x57, 0xb1], 5],
    ['new out-of-range', [0xbb, 0x00, 0x63, 0x57, 0xb1], 99],
    ['instanceof #10 Integer', [0x01, 0xc1, 0x00, 0x0a, 0x57, 0xb1], 10],
    ['checkcast #8 Methodref', [0x2a, 0xc0, 0x00, 0x08, 0xb0], 8],
    ['instanceof out-of-range', [0x01, 0xc1, 0x00, 0x63, 0x57, 0xb1], 99],
  ];
  for (const [name, bytecode, idx] of cases) {
    const fn = liftJvmMethod(0, klass(bytecode, pool));
    const bundle = fn.bundles.find((b) => [0xbb, 0xc0, 0xc1].includes(b.opcode));
    assert.equal(bundle.completeness, 'partial', name);
    assert.ok(reasons(bundle).includes(`jvm-class-reference-unresolved:${idx}`), name);
    for (const value of bundle.producedValues) {
      assert.equal(value.cpClassIndex, undefined, name);
    }
    assert.notEqual(fn.aggregateCompleteness, 'exact', name);
  }
});

test('#5083 valid CP reference operands keep their established exact semantics (AC6)', () => {
  const virtual = liftJvmMethod(0, klass([0xb6, 0x00, 0x08, 0xb1], pool)).bundles[0];
  assert.equal(virtual.completeness, 'exact');
  assert.deepEqual(virtual.callEffects, [{ cpIndex: 8, dispatchKind: 'virtual' }]);

  const iface = liftJvmMethod(0, klass([0xb9, 0x00, 0x09, 0x01, 0x00, 0xb1], pool)).bundles[0];
  assert.equal(iface.completeness, 'exact');
  assert.deepEqual(iface.callEffects, [{ cpIndex: 9, dispatchKind: 'interface' }]);

  const anew = liftJvmMethod(0, klass([0xbb, 0x00, 0x06, 0x57, 0xb1], pool)).bundles[0];
  assert.equal(anew.completeness, 'exact');
  assert.deepEqual(anew.producedValues, [{ bits: 64, cpClassIndex: 6 }]);

  const instanceofBundle = liftJvmMethod(0, klass([0x01, 0xc1, 0x00, 0x06, 0x57, 0xb1], pool))
    .bundles.find((b) => b.opcode === 0xc1);
  assert.equal(instanceofBundle.completeness, 'exact');
  assert.deepEqual(instanceofBundle.producedValues, [{ bits: 32, cpClassIndex: 6 }]);
  assert.equal(instanceofBundle.consumedValues.length, 1);

  const checkcastBundle = liftJvmMethod(0, klass([0x2a, 0xc0, 0x00, 0x06, 0xb0], pool))
    .bundles.find((b) => b.opcode === 0xc0);
  assert.equal(checkcastBundle.completeness, 'partial');
  assert.ok(reasons(checkcastBundle).includes('jvm-checkcast-exception-unrepresented'));
  assert.equal(checkcastBundle.producedValues[0].id, 'obj-refined');
  assert.equal(checkcastBundle.producedValues[0].cpClassIndex, 6);

  const integer = liftJvmMethod(0, klass([0x12, 0x0a, 0xb1], pool)).bundles[0];
  assert.equal(integer.completeness, 'exact');
  assert.deepEqual(integer.producedValues, [{ bits: 32, cpIndex: 10, category: 1, constant: 42 }]);
});

test('#5083 DEX reference operands out of range fail closed, never fabricate identity', () => {
  for (const op of [0x1a, 0x22, 0x52, 0x71]) {
    const words = [op, 1, ...(op === 0x71 ? [0] : []), 0x000e];
    const bundle = liftDexMethod(0, dexMethod(words)).bundles[0];
    assert.notEqual(bundle.completeness, 'exact', `op 0x${op.toString(16)}`);
    assert.equal(bundle.unknownEffects[0].reason, 'dex-reference-index-out-of-range');
    for (const field of ['producedValues', 'locationWrites', 'memoryEffects', 'callEffects']) {
      assert.deepEqual(bundle[field], [], `op 0x${op.toString(16)} ${field}`);
    }
  }
  const validString = liftDexMethod(0, dexMethod([0x1a, 0, 0x000e])).bundles[0];
  assert.equal(validString.completeness, 'exact');
});
