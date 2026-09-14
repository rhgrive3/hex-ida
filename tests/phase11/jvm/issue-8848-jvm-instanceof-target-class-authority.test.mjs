// Regression for #8848: JVM `instanceof` (`0xc1`) must reject an operand that
// does not resolve to a valid `CONSTANT_Class` + nested Utf8 name, and must
// not publish a `complete` canonical unary with `operator:null` and no target
// class identity for the *valid* case either. The current shared bridge does
// not carry a first-class type-test target, so the smallest correct change
// fails closed: an invalid operand yields `partial` +
// `jvm-instanceof-cp-class-invalid`; a valid operand preserves the resolved
// class name on the produced value (`valueType` / `referenceKind`, which the
// bridge already folds into canonical node metadata) and yields `partial` +
// `jvm-instanceof-type-test-target-unrepresented-in-canonical-ir` so the
// whole Semantic IR no longer launders it as complete.
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

// A) valid `instanceof java/lang/String`: objectref → int32, but the whole
//    lowering is `partial` because the current canonical IR cannot preserve
//    a first-class type-test target authority.
{
  const cp = [
    ...CP_HEADER,
    { tag: 1, value: 'java/lang/String' },
    { tag: 7, nameIndex: 3 },
  ];
  // aload_0; instanceof #4; ireturn
  const fn = liftJvmMethod(0, image({ cpEntries: cp, bytecode: [0x2a, 0xc1, 0x00, 0x04, 0xac] }));
  const b = bundleOf(fn, 0xc1);
  assert.ok(b, 'instanceof bundle must be published');
  assert.equal(b.completeness, 'partial', 'valid instanceof still fails closed on unrepresented type-test target');
  assert.equal(b.producedValues[0].bits, 32);
  assert.equal(b.producedValues[0].cpClassIndex, 4);
  assert.equal(b.producedValues[0].valueType, 'java/lang/String',
    'resolved target class name must survive to the bridge metadata');
  assert.equal(b.producedValues[0].referenceKind, 'type-test-target');
  assert.ok(b.unknownEffects.some((e) => e.reason === 'jvm-instanceof-type-test-target-unrepresented-in-canonical-ir'));
  assert.notEqual(fn.aggregateCompleteness, 'exact');
  const lowered = lowerVMEffectsToSemanticIr(fn);
  assert.equal(lowered.semanticIr.completeness, 'partial',
    'canonical IR must not launder an erased type-test target as complete');
  const node = firstNodeWithMnemonic(lowered, 'instanceof');
  assert.ok(node, 'canonical instanceof node present');
  assert.notEqual(node.completeness, 'complete',
    'canonical instanceof node must not claim completeness while the target authority is erased');
  assert.equal(node.unknown?.reason, 'jvm-instanceof-type-test-target-unrepresented-in-canonical-ir',
    'canonical node must publish the fail-closed reason');
}

// B) distinct-target test — the two instanceof shapes (String vs. Object)
//    must be distinguishable in the canonical node metadata even though both
//    are `partial`, so consumers can still reason about which class was
//    tested (issue req 3, satisfied via the preserved `valueType` metadata).
{
  const stringCp = [
    ...CP_HEADER,
    { tag: 1, value: 'java/lang/String' },
    { tag: 7, nameIndex: 3 },
  ];
  const objectCp = [
    ...CP_HEADER,
    { tag: 1, value: 'java/lang/Object' },
    { tag: 7, nameIndex: 3 },
  ];
  const stringFn = liftJvmMethod(0, image({ cpEntries: stringCp, bytecode: [0x2a, 0xc1, 0x00, 0x04, 0xac] }));
  const objectFn = liftJvmMethod(0, image({ cpEntries: objectCp, bytecode: [0x2a, 0xc1, 0x00, 0x04, 0xac] }));
  const s = bundleOf(stringFn, 0xc1).producedValues[0];
  const o = bundleOf(objectFn, 0xc1).producedValues[0];
  assert.equal(s.valueType, 'java/lang/String');
  assert.equal(o.valueType, 'java/lang/Object');
  assert.notEqual(s.valueType, o.valueType,
    'two distinct instanceof targets must be distinguishable via the preserved metadata');
}

// C) wrong-tag CP entry (`CONSTANT_Utf8` at the target index). The checked
//    resolver must reject this and the bundle must not publish an `exact`
//    type-test result.
{
  const cp = [
    ...CP_HEADER,
    { tag: 1, value: 'java/lang/String' }, // Utf8, NOT a Class
  ];
  const fn = liftJvmMethod(0, image({ cpEntries: cp, bytecode: [0x2a, 0xc1, 0x00, 0x03, 0xac] }));
  const b = bundleOf(fn, 0xc1);
  assert.equal(b.completeness, 'partial', 'wrong-tag CP operand must fail closed');
  assert.ok(b.unknownEffects.some((e) => e.reason === 'jvm-instanceof-cp-class-invalid'),
    'wrong-tag CP operand must publish a stable reason');
  assert.equal(b.producedValues[0].valueType, undefined,
    'a wrong-tag CP entry must not fabricate a `valueType` on the produced value');
  const lowered = lowerVMEffectsToSemanticIr(fn);
  assert.equal(lowered.semanticIr.completeness, 'partial');
}

// D) out-of-range CP index. Same posture as (C).
{
  const cp = [
    ...CP_HEADER,
    { tag: 1, value: 'java/lang/String' },
    { tag: 7, nameIndex: 3 },
  ];
  const fn = liftJvmMethod(0, image({ cpEntries: cp, bytecode: [0x2a, 0xc1, 0x00, 0x63, 0xac] }));
  const b = bundleOf(fn, 0xc1);
  assert.equal(b.completeness, 'partial', 'out-of-range CP operand must fail closed');
  assert.ok(b.unknownEffects.some((e) => e.reason === 'jvm-instanceof-cp-class-invalid'));
}

// E) nested Utf8 name resolution broken (`nameIndex` points to a non-Utf8 or
//    is missing). Also fails closed.
{
  const cp = [
    ...CP_HEADER,
    { tag: 7, nameIndex: 99 }, // dangling nameIndex
  ];
  const fn = liftJvmMethod(0, image({ cpEntries: cp, bytecode: [0x2a, 0xc1, 0x00, 0x03, 0xac] }));
  const b = bundleOf(fn, 0xc1);
  assert.equal(b.completeness, 'partial', 'dangling class nameIndex must fail closed');
  assert.ok(b.unknownEffects.some((e) => e.reason === 'jvm-instanceof-cp-class-invalid'));
}

// F) `checkcast` shares the same checked resolver (#8848 req 7). A wrong-tag
//    CP entry now publishes an additional stable reason alongside the
//    pre-existing `jvm-checkcast-exception-unrepresented`.
{
  const cp = [
    ...CP_HEADER,
    { tag: 1, value: 'java/lang/String' },
    { tag: 9, classIndex: 1, nameAndTypeIndex: 1 }, // CONSTANT_Fieldref, not a Class
  ];
  // aload_0; checkcast #4; areturn
  const fn = liftJvmMethod(0, image({
    cpEntries: cp,
    bytecode: [0x2a, 0xc0, 0x00, 0x04, 0xb0],
    name: 'h',
  }));
  const b = bundleOf(fn, 0xc0);
  assert.equal(b.completeness, 'partial');
  assert.ok(b.unknownEffects.some((e) => e.reason === 'jvm-checkcast-cp-class-invalid'),
    'checkcast must reuse the same checked CP resolver and publish its own reason');
  assert.ok(b.unknownEffects.some((e) => e.reason === 'jvm-checkcast-exception-unrepresented'),
    'the pre-existing ClassCastException fail-closed posture is preserved');
}

console.log('issue-8848 jvm instanceof target class authority: PASS');
