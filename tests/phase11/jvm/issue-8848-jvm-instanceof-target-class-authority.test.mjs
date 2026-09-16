// Regression for #8848: JVM `instanceof` (`0xc1`) must reject an operand that
// does not resolve to a valid `CONSTANT_Class` + nested Utf8 name. For a valid
// operand the checked class identity and predicate authority must survive the
// complete JVM -> VMEffects -> canonical Semantic IR path; the result may stay
// `partial` only for the still-unrepresented runtime class-resolution effects.
import assert from 'node:assert/strict';

import { liftJvmMethod } from '../../../js/managed/jvm/lifter.js';
import { lowerVMEffectsToSemanticIr } from '../../../js/managed/shared/bridge-v2.js';

function image({ cpEntries, bytecode, name = 'g' }) {
  return {
    moduleId: 'managed-mod:issue-8848',
    vmSpecEdition: 'java-se-17',
    thisClassName: 'pkg/Test',
    fields: [],
    constantPool: cpEntries,
    methods: [{
      accessFlags: 0x0009,
      name,
      descriptor: '()I',
      code: {
        maxStack: 2,
        maxLocals: 1,
        offset: 0,
        exceptionTable: [],
        bytecode: Uint8Array.from(bytecode),
      },
    }],
  };
}

const CP_HEADER = Object.freeze([null, { tag: 1, value: 'pkg/Test' }, { tag: 7, nameIndex: 1 }]);

function bundleOf(fn, opcode) {
  return fn.bundles.find((b) => b.opcode === opcode);
}

function firstNodeWithMnemonic(lowered, mnemonic) {
  return lowered.semanticIr.nodes.find((n) => n.metadata?.mnemonic === mnemonic);
}

function validClassPool(target) {
  return [
    ...CP_HEADER,
    { tag: 1, value: target },
    { tag: 7, nameIndex: 3 },
  ];
}

// A) valid `instanceof java/lang/String`: objectref -> JVM int32. The bundle
//    remains partial only because class-resolution/linkage effects are not yet
//    exhaustively represented; the actual type-test semantic is first-class.
{
  const fn = liftJvmMethod(0, image({
    cpEntries: validClassPool('java/lang/String'),
    bytecode: [0x2a, 0xc1, 0x00, 0x04, 0xac],
  }));
  const b = bundleOf(fn, 0xc1);
  assert.ok(b, 'instanceof bundle must be published');
  assert.equal(b.completeness, 'partial');
  assert.equal(b.consumedValues[0].type?.addressSpace, 'managed-heap',
    'tested object must retain managed-heap reference authority');
  assert.equal(b.producedValues[0].bits, 32);
  assert.equal(b.producedValues[0].cpClassIndex, 4);
  assert.equal(b.producedValues[0].valueType, 'java/lang/String');
  assert.equal(b.producedValues[0].referenceKind, 'type-test-result');
  assert.equal(b.producedValues[0].predicateKind, 'jvm-instanceof');
  assert.equal(b.producedValues[0].predicateTargetClass, 'java/lang/String');
  assert.equal(b.producedValues[0].booleanEncoding, 'int32-0-or-1');
  assert.ok(b.unknownEffects.some((e) => e.reason === 'jvm-instanceof-runtime-resolution-effects-unrepresented'));
  assert.notEqual(fn.aggregateCompleteness, 'exact');

  const lowered = lowerVMEffectsToSemanticIr(fn);
  assert.equal(lowered.semanticIr.completeness, 'partial');
  const node = firstNodeWithMnemonic(lowered, 'instanceof');
  assert.ok(node, 'canonical instanceof node present');
  assert.equal(node.kind, 'intrinsic');
  assert.equal(node.operator, 'jvm-instanceof');
  assert.equal(node.attributes?.semantic, 'type-test');
  assert.equal(node.attributes?.targetType?.kind, 'jvm-class');
  assert.equal(node.attributes?.targetType?.name, 'java/lang/String',
    'canonical node must retain the checked target class identity');
  assert.deepEqual(node.attributes?.resultPredicate, {
    kind: 'predicate',
    widthBits: 1,
    encoding: 'int32-0-or-1',
    trueValue: 1,
    falseValue: 0,
  });
  const result = lowered.semanticIr.values.find((value) => node.outputs.includes(value.id));
  assert.equal(result?.machineType?.kind, 'bitvector',
    'JVM stack representation remains an int32 value');
  assert.equal(result?.machineType?.widthBits, 32);
  assert.equal(result?.metadata?.predicateKind, 'jvm-instanceof',
    'predicate authority must survive on the canonical result value');
  assert.equal(result?.metadata?.predicateTargetClass, 'java/lang/String');
}

// B) same tested value but String vs Object must be different canonical
//    operations, not two anonymous unary nodes with the same shape.
{
  const lowerTarget = (target, name) => {
    const fn = liftJvmMethod(0, image({
      cpEntries: validClassPool(target),
      bytecode: [0x2a, 0xc1, 0x00, 0x04, 0xac],
      name,
    }));
    return firstNodeWithMnemonic(lowerVMEffectsToSemanticIr(fn), 'instanceof');
  };
  const stringNode = lowerTarget('java/lang/String', 's');
  const objectNode = lowerTarget('java/lang/Object', 'o');
  assert.equal(stringNode.operator, 'jvm-instanceof');
  assert.equal(objectNode.operator, 'jvm-instanceof');
  assert.equal(stringNode.attributes.targetType.name, 'java/lang/String');
  assert.equal(objectNode.attributes.targetType.name, 'java/lang/Object');
  assert.notDeepEqual(stringNode.attributes.targetType, objectNode.attributes.targetType);
}

// C) wrong-tag CP entry (`CONSTANT_Utf8` at the target index).
{
  const cp = [
    ...CP_HEADER,
    { tag: 1, value: 'java/lang/String' },
  ];
  const fn = liftJvmMethod(0, image({ cpEntries: cp, bytecode: [0x2a, 0xc1, 0x00, 0x03, 0xac] }));
  const b = bundleOf(fn, 0xc1);
  assert.equal(b.completeness, 'partial');
  assert.ok(b.unknownEffects.some((e) => e.reason === 'jvm-instanceof-cp-class-invalid'));
  assert.equal(b.producedValues[0].valueType, undefined);
  const lowered = lowerVMEffectsToSemanticIr(fn);
  const node = firstNodeWithMnemonic(lowered, 'instanceof');
  assert.notEqual(node?.operator, 'jvm-instanceof',
    'invalid CP authority must never mint a first-class exact-looking type test');
  assert.equal(lowered.semanticIr.completeness, 'partial');
}

// D) out-of-range CP index. Same fail-closed posture as (C).
{
  const fn = liftJvmMethod(0, image({
    cpEntries: validClassPool('java/lang/String'),
    bytecode: [0x2a, 0xc1, 0x00, 0x63, 0xac],
  }));
  const b = bundleOf(fn, 0xc1);
  assert.equal(b.completeness, 'partial');
  assert.ok(b.unknownEffects.some((e) => e.reason === 'jvm-instanceof-cp-class-invalid'));
}

// E) nested Utf8 name resolution broken.
{
  const cp = [
    ...CP_HEADER,
    { tag: 7, nameIndex: 99 },
  ];
  const fn = liftJvmMethod(0, image({ cpEntries: cp, bytecode: [0x2a, 0xc1, 0x00, 0x03, 0xac] }));
  const b = bundleOf(fn, 0xc1);
  assert.equal(b.completeness, 'partial');
  assert.ok(b.unknownEffects.some((e) => e.reason === 'jvm-instanceof-cp-class-invalid'));
}

// F) `checkcast` shares the same checked resolver; its existing exception
//    incompleteness remains explicit.
{
  const cp = [
    ...CP_HEADER,
    { tag: 1, value: 'java/lang/String' },
    { tag: 9, classIndex: 1, nameAndTypeIndex: 1 },
  ];
  const fn = liftJvmMethod(0, image({
    cpEntries: cp,
    bytecode: [0x2a, 0xc0, 0x00, 0x04, 0xb0],
    name: 'h',
  }));
  const b = bundleOf(fn, 0xc0);
  assert.equal(b.completeness, 'partial');
  assert.ok(b.unknownEffects.some((e) => e.reason === 'jvm-checkcast-cp-class-invalid'));
  assert.ok(b.unknownEffects.some((e) => e.reason === 'jvm-checkcast-exception-unrepresented'));
}

console.log('issue-8848 jvm instanceof target class authority: PASS');
