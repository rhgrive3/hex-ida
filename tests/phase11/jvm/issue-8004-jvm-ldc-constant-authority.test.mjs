import assert from 'node:assert/strict';
import test from 'node:test';

import { liftJvmMethod } from '../../../js/managed/jvm/lifter.js';
import { lowerVMEffectsToSemanticIr } from '../../../js/managed/shared/bridge-v2.js';

// #8004 — the JVM lifter resolved ldc/ldc_w/ldc2_w against nothing: the
// produced value carried only {bits, category, cpIndex} while the bundle
// stayed `exact`, so compiler-generated constants became input-less complete
// unary nodes with the constant value absent, floats became bitvectors, and
// String constants lost their known reference kind. The runtime constant
// pool entry named by the index is the value's authority (JVMS §6.5, §4.4):
// the resolution must reach the final Semantic IR, and an entry that cannot
// be resolved losslessly fails closed instead of publishing an exact
// constant that dropped its value.

const CODE_OFFSET = 0x180;

function classWith({ constantPool, bytecode }) {
  return {
    moduleId: 'managed-mod:test:jvm',
    vmSpecEdition: 'java-se-17',
    thisClassName: 'T',
    constantPool,
    methods: [{
      accessFlags: 0x0008,
      name: 'm',
      descriptor: '()V',
      code: {
        maxStack: 4,
        maxLocals: 0,
        bytecode: Uint8Array.from(bytecode),
        exceptionTable: [],
        offset: CODE_OFFSET,
      },
    }],
  };
}

const pool = [null,
  { tag: 1, value: 'hex-ida-audit' },            // 1: string content
  { tag: 1, value: 'java/lang/Object' },         // 2: class name
  { tag: 1, value: '(I)V' },                     // 3: method type descriptor
  { tag: 1, value: 'f' },                        // 4: method name
  { tag: 1, value: 'T' },                        // 5: method handle owner
  { tag: 3, value: 123456789 },                  // 6: Integer
  { tag: 4, value: 1.25 },                       // 7: Float
  { tag: 5, value: 1234567890123n },             // 8: Long (+ reserved 9)
  null,                                          // 9: reserved long slot
  { tag: 6, value: 1.25 },                       // 10: Double (+ reserved 11)
  null,                                          // 11: reserved double slot
  { tag: 8, stringIndex: 1 },                    // 12: String
  { tag: 7, nameIndex: 2 },                      // 13: Class
  { tag: 16, descriptorIndex: 3 },               // 14: MethodType
  { tag: 10, classIndex: 13, nameAndTypeIndex: 16 }, // 15: Methodref for handle (kind 6 = REF_invokeStatic)
  { tag: 12, nameIndex: 4, descriptorIndex: 3 }, // 16: NameAndType
  { tag: 15, referenceKind: 6, referenceIndex: 15 }, // 17: MethodHandle
  { tag: 4, value: NaN },                        // 18: Float NaN
];

const ldc = (idx) => [0x12, idx, 0xb1];                 // ldc #idx; return
const ldcW = (idx) => [0x13, idx >> 8, idx & 0xff, 0xb1]; // ldc_w #idx; return
const ldc2W = (idx) => [0x14, idx >> 8, idx & 0xff, 0xb1]; // ldc2_w #idx; return

// A JVM reference pushes a 32-bit managed-heap address; the machine type
// must survive into the final Semantic IR instead of degrading to bitvector32.
const REF_TYPE = { kind: 'address', widthBits: 32, addressSpace: 'managed-heap' };

const lift = ({ constantPool, bytecode }) =>
  liftJvmMethod(0, classWith({ constantPool, bytecode })).bundles[0];

test('#8004 ldc resolves the Integer entry as the exact constant', () => {
  const bundle = lift({ constantPool: pool, bytecode: ldc(6) });
  assert.equal(bundle.completeness, 'exact');
  assert.deepEqual(bundle.producedValues, [
    { bits: 32, cpIndex: 6, category: 1, constant: 123456789 },
  ]);
});

test('#8004 ldc resolves the Float entry with float machine-type authority', () => {
  const bundle = lift({ constantPool: pool, bytecode: ldc(7) });
  assert.equal(bundle.completeness, 'exact');
  assert.deepEqual(bundle.producedValues, [{
    bits: 32, cpIndex: 7, category: 1, constant: 1.25,
    type: { kind: 'float', widthBits: 32, format: 'binary32' },
  }]);
});

test('#8004 ldc2_w resolves the Long entry', () => {
  const bundle = lift({ constantPool: pool, bytecode: ldc2W(8) });
  assert.equal(bundle.completeness, 'exact');
  assert.deepEqual(bundle.producedValues, [
    { bits: 64, cpIndex: 8, category: 2, constant: '1234567890123' },
  ]);
});

test('#8004 ldc2_w resolves the Double entry with float64 machine-type authority', () => {
  const bundle = lift({ constantPool: pool, bytecode: ldc2W(10) });
  assert.equal(bundle.completeness, 'exact');
  assert.deepEqual(bundle.producedValues, [{
    bits: 64, cpIndex: 10, category: 2, constant: 1.25,
    type: { kind: 'float', widthBits: 64, format: 'binary64' },
  }]);
});

test('#8004 ldc keeps the String reference kind and its resolved content', () => {
  const bundle = lift({ constantPool: pool, bytecode: ldc(12) });
  assert.equal(bundle.completeness, 'exact');
  assert.deepEqual(bundle.producedValues, [{
    bits: 32, cpIndex: 12, category: 1, type: REF_TYPE,
    stackType: 'reference', valueType: 'string', constant: 'hex-ida-audit',
  }]);
});

test('#8004 ldc resolves Class, MethodType, and MethodHandle reference identities', () => {
  assert.deepEqual(lift({ constantPool: pool, bytecode: ldc(13) }).producedValues, [{
    bits: 32, cpIndex: 13, category: 1, type: REF_TYPE,
    stackType: 'reference', valueType: 'class', constant: 'java/lang/Object',
  }]);
  assert.deepEqual(lift({ constantPool: pool, bytecode: ldc(14) }).producedValues, [{
    bits: 32, cpIndex: 14, category: 1, type: REF_TYPE,
    stackType: 'reference', valueType: 'method-type', constant: '(I)V',
  }]);
  assert.deepEqual(lift({ constantPool: pool, bytecode: ldc(17) }).producedValues, [{
    bits: 32, cpIndex: 17, category: 1, type: REF_TYPE,
    stackType: 'reference', valueType: 'method-handle', referenceKind: 6,
    constant: 'java/lang/Object.f:(I)V',
  }]);
});

test('#8004 non-finite float constants keep an exact canonical form', () => {
  const bundle = lift({ constantPool: pool, bytecode: ldc(18) });
  assert.deepEqual(bundle.producedValues, [{
    bits: 32, cpIndex: 18, category: 1, constant: 'NaN',
    type: { kind: 'float', widthBits: 32, format: 'binary32' },
  }]);
});

test('#8004 ldc_w accepts the same loadable constants as ldc', () => {
  const bundle = lift({ constantPool: pool, bytecode: ldcW(6) });
  assert.deepEqual(bundle.producedValues, [
    { bits: 32, cpIndex: 6, category: 1, constant: 123456789 },
  ]);
});

test('#8004 MethodHandle kind/tag mismatches fail closed (JVMS 4.4.8)', () => {
  // REF_invokeStatic (6) may not name a Fieldref.
  const kind6Fieldref = lift({
    constantPool: [null,
      { tag: 1, value: 'T' }, { tag: 1, value: 'f' }, { tag: 1, value: '(I)V' },
      { tag: 9, classIndex: 1, nameAndTypeIndex: 2 },
      { tag: 12, nameIndex: 1, descriptorIndex: 3 },
      { tag: 15, referenceKind: 6, referenceIndex: 4 }],
    bytecode: ldc(6),
  });
  assert.equal(kind6Fieldref.completeness, 'partial');
  assert.deepEqual(kind6Fieldref.unknownEffects.map((u) => u.reason),
    ['jvm-ldc-constant-unresolved:6']);

  // REF_getField (1) may not name a Methodref.
  const kind1Methodref = lift({
    constantPool: [null,
      { tag: 1, value: 'T' }, { tag: 1, value: 'f' }, { tag: 1, value: '(I)V' },
      { tag: 10, classIndex: 1, nameAndTypeIndex: 2 },
      { tag: 12, nameIndex: 1, descriptorIndex: 3 },
      { tag: 15, referenceKind: 1, referenceIndex: 4 }],
    bytecode: ldc(6),
  });
  assert.equal(kind1Methodref.completeness, 'partial');
  assert.deepEqual(kind1Methodref.unknownEffects.map((u) => u.reason),
    ['jvm-ldc-constant-unresolved:6']);

  // REF_invokeInterface (9) may only name an InterfaceMethodref.
  const kind9Methodref = lift({
    constantPool: [null,
      { tag: 1, value: 'T' }, { tag: 1, value: 'f' }, { tag: 1, value: '(I)V' },
      { tag: 10, classIndex: 1, nameAndTypeIndex: 2 },
      { tag: 12, nameIndex: 1, descriptorIndex: 3 },
      { tag: 15, referenceKind: 9, referenceIndex: 4 }],
    bytecode: ldc(6),
  });
  assert.equal(kind9Methodref.completeness, 'partial');
  assert.deepEqual(kind9Methodref.unknownEffects.map((u) => u.reason),
    ['jvm-ldc-constant-unresolved:6']);

  // REF_invokeInterface (9) with an InterfaceMethodref resolves.
  const kind9Interface = lift({
    constantPool: [null,
      { tag: 1, value: 'T' }, { tag: 1, value: 'f' }, { tag: 1, value: '(I)V' },
      { tag: 7, nameIndex: 1 },
      { tag: 11, classIndex: 4, nameAndTypeIndex: 6 },
      { tag: 12, nameIndex: 2, descriptorIndex: 3 },
      { tag: 15, referenceKind: 9, referenceIndex: 5 }],
    bytecode: ldc(7),
  });
  assert.equal(kind9Interface.completeness, 'exact');
  assert.deepEqual(kind9Interface.producedValues, [{
    bits: 32, cpIndex: 7, category: 1,
    stackType: 'reference', valueType: 'method-handle', referenceKind: 9,
    constant: 'T.f:(I)V', type: REF_TYPE,
  }]);
});

test('#8004 constants that cannot be resolved losslessly fail closed', () => {
  // Out-of-range index.
  const outOfRange = lift({ constantPool: pool, bytecode: ldc(99) });
  assert.equal(outOfRange.completeness, 'partial');
  assert.deepEqual(outOfRange.producedValues, []);
  assert.deepEqual(outOfRange.unknownEffects.map((u) => u.reason),
    ['jvm-ldc-constant-unresolved:99']);

  // Reserved second slot of a Long entry.
  const reserved = lift({ constantPool: pool, bytecode: ldc(9) });
  assert.equal(reserved.completeness, 'partial');
  assert.deepEqual(reserved.unknownEffects.map((u) => u.reason),
    ['jvm-ldc-constant-unresolved:9']);

  // ldc2_w may only name Long/Double — an Integer is a tag/opcode mismatch.
  const mismatch = lift({ constantPool: pool, bytecode: ldc2W(6) });
  assert.equal(mismatch.completeness, 'partial');
  assert.deepEqual(mismatch.producedValues, []);
  assert.deepEqual(mismatch.unknownEffects.map((u) => u.reason),
    ['jvm-ldc-constant-unresolved:6']);

  // A CONSTANT_Dynamic's value is bootstrap-computed, not statically exact.
  const dynamic = lift({
    constantPool: [null, { tag: 17, bootstrapMethodAttrIndex: 0, nameAndTypeIndex: 2 }],
    bytecode: ldc(1),
  });
  assert.equal(dynamic.completeness, 'partial');
  assert.deepEqual(dynamic.unknownEffects.map((u) => u.reason),
    ['jvm-ldc-constant-unresolved:1']);

  // A String entry whose UTF8 target is missing fails closed.
  const brokenString = lift({
    constantPool: [null, { tag: 8, stringIndex: 42 }],
    bytecode: ldc(1),
  });
  assert.equal(brokenString.completeness, 'partial');
  assert.deepEqual(brokenString.unknownEffects.map((u) => u.reason),
    ['jvm-ldc-constant-unresolved:1']);
});

test('#8004 resolved constants reach the final Semantic IR', () => {
  const lowered = lowerVMEffectsToSemanticIr(
    liftJvmMethod(0, classWith({ constantPool: pool, bytecode: ldc(6) })),
  );
  const bundle = liftJvmMethod(0, classWith({ constantPool: pool, bytecode: ldc(6) })).bundles[0];
  const node = lowered.semanticIr.nodes.find((n) => n.sourceEffectIds?.includes(bundle.operationId));
  assert.ok(node, 'ldc node required');
  const value = lowered.semanticIr.values.find((v) => node.outputs.includes(v.id));
  assert.equal(value.metadata.constant, '123456789');

  const floatLowered = lowerVMEffectsToSemanticIr(
    liftJvmMethod(0, classWith({ constantPool: pool, bytecode: ldc(7) })),
  );
  const floatBundle = liftJvmMethod(0, classWith({ constantPool: pool, bytecode: ldc(7) })).bundles[0];
  const floatNode = floatLowered.semanticIr.nodes.find((n) => n.sourceEffectIds?.includes(floatBundle.operationId));
  const floatValue = floatLowered.semanticIr.values.find((v) => floatNode.outputs.includes(v.id));
  assert.equal(floatValue.metadata.constant, '1.25');
  assert.deepEqual(floatValue.machineType, { kind: 'float', widthBits: 32, format: 'binary32' });
});

// The reference-kind half of #8004: String/Class/MethodType/MethodHandle must
// reach the final public value as managed-heap addresses with their
// value-kind identity intact — not complete bitvector32 values with the
// reference authority erased.
function loweredReference(cpIndex) {
  const fn = liftJvmMethod(0, classWith({ constantPool: pool, bytecode: ldc(cpIndex) }));
  const lowered = lowerVMEffectsToSemanticIr(fn);
  const node = lowered.semanticIr.nodes.find((n) => n.sourceEffectIds?.includes(fn.bundles[0].operationId));
  assert.ok(node, 'ldc node required');
  return lowered.semanticIr.values.find((v) => node.outputs.includes(v.id));
}

test('#8004 reference-kind constants keep their identity in the final Semantic IR', () => {
  const string = loweredReference(12);
  assert.deepEqual(string.machineType, REF_TYPE);
  assert.deepEqual(string.metadata,
    { valueType: 'string', constant: 'hex-ida-audit' });

  const clazz = loweredReference(13);
  assert.deepEqual(clazz.machineType, REF_TYPE);
  assert.deepEqual(clazz.metadata,
    { valueType: 'class', constant: 'java/lang/Object' });

  const methodType = loweredReference(14);
  assert.deepEqual(methodType.machineType, REF_TYPE);
  assert.deepEqual(methodType.metadata,
    { valueType: 'method-type', constant: '(I)V' });

  const methodHandle = loweredReference(17);
  assert.deepEqual(methodHandle.machineType, REF_TYPE);
  assert.deepEqual(methodHandle.metadata, {
    valueType: 'method-handle', referenceKind: 6, constant: 'java/lang/Object.f:(I)V',
  });
});

test('#8004 string and class references stay distinct through the final IR', () => {
  const string = loweredReference(12);
  const clazz = loweredReference(13);
  assert.notDeepEqual(string.metadata, clazz.metadata);
});

test('#8004 constants that differ only by CP value produce distinct canonical state', () => {
  const a = liftJvmMethod(0, classWith({
    constantPool: [null, { tag: 3, value: 123456789 }],
    bytecode: ldc(1),
  }));
  const b = liftJvmMethod(0, classWith({
    constantPool: [null, { tag: 3, value: 123456790 }],
    bytecode: ldc(1),
  }));
  assert.notDeepEqual(a, b);
});
