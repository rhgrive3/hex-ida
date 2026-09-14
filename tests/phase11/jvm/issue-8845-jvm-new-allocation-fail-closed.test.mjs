// Regression for #8845: JVM `new` (`0xbb`) must resolve its operand against
// the constant pool (checked `CONSTANT_Class` + nested Utf8 name — same
// posture as #8848 and the #8004 `ldc` path), preserve the allocated class
// identity via `valueType`/`referenceKind` on the produced value (which the
// shared bridge folds into canonical node metadata), and fail closed to
// `partial` + `jvm-new-allocation-unrepresented` even for the valid case
// because the current canonical IR has no allocation-site / fresh-object
// identity / heap-effect schema — exactly the DEX `new-instance` posture the
// issue body points at. Invalid CP index / wrong tag / dangling nameIndex
// publish `jvm-new-cp-class-invalid` and must not fabricate a `complete`
// canonical unary.
import assert from 'node:assert/strict';

import { liftJvmMethod } from '../../../js/managed/jvm/lifter.js';
import { lowerVMEffectsToSemanticIr } from '../../../js/managed/shared/bridge-v2.js';

function image({ cpEntries, bytecode, name = 'n' }) {
  return {
    moduleId: 'managed-mod:issue-8845',
    vmSpecEdition: 'java-se-17',
    thisClassName: 'pkg/Test',
    fields: [],
    constantPool: cpEntries,
    methods: [{
      accessFlags: 0x0009,
      name,
      descriptor: '()V',
      code: {
        maxStack: 4,
        maxLocals: 1,
        offset: 0,
        exceptionTable: [],
        bytecode: Uint8Array.from(bytecode),
      },
    }],
  };
}

const CP_HEADER = Object.freeze([null, { tag: 1, value: 'pkg/Test' }, { tag: 7, nameIndex: 1 }]);

function bundleOf(fn, opcode) { return fn.bundles.find((b) => b.opcode === opcode); }

// A) valid `new java/lang/String; pop; return`: the bundle carries the
//    resolved class identity via `valueType`/`referenceKind`, but stays
//    `partial` (allocation / freshness is not representable). The canonical
//    IR cannot publish `complete` for a fresh heap allocation.
{
  const cp = [
    ...CP_HEADER,
    { tag: 1, value: 'java/lang/String' },
    { tag: 7, nameIndex: 3 },
  ];
  // new #4; pop; return
  const fn = liftJvmMethod(0, image({ cpEntries: cp, bytecode: [0xbb, 0x00, 0x04, 0x57, 0xb1] }));
  const b = bundleOf(fn, 0xbb);
  assert.ok(b, 'new bundle must be published');
  assert.equal(b.completeness, 'partial',
    'a valid `new` must fail closed on the still-unrepresented allocation authority (DEX-aligned)');
  assert.equal(b.producedValues[0].bits, 64);
  assert.equal(b.producedValues[0].cpClassIndex, 4);
  assert.equal(b.producedValues[0].valueType, 'java/lang/String',
    'resolved allocated class name must survive to the bridge metadata');
  assert.equal(b.producedValues[0].referenceKind, 'new-allocation');
  assert.ok(b.unknownEffects.some((e) => e.reason === 'jvm-new-allocation-unrepresented'));
  assert.notEqual(fn.aggregateCompleteness, 'exact');
  const lowered = lowerVMEffectsToSemanticIr(fn);
  assert.equal(lowered.semanticIr.completeness, 'partial',
    'a valid `new` cannot launder into a complete canonical IR');
  const node = lowered.semanticIr.nodes.find((n) => n.metadata?.mnemonic === 'new');
  assert.ok(node);
  assert.notEqual(node.completeness, 'complete');
  assert.equal(node.unknown?.reason, 'jvm-new-allocation-unrepresented');
}

// B) distinct-target `new` (String vs. Object) is distinguishable via the
//    preserved metadata — the erased "unary creation of an anonymous value"
//    shape is no longer the whole story.
{
  const stringFn = liftJvmMethod(0, image({
    cpEntries: [...CP_HEADER, { tag: 1, value: 'java/lang/String' }, { tag: 7, nameIndex: 3 }],
    bytecode: [0xbb, 0x00, 0x04, 0x57, 0xb1],
    name: 'nA',
  }));
  const objectFn = liftJvmMethod(0, image({
    cpEntries: [...CP_HEADER, { tag: 1, value: 'java/lang/Object' }, { tag: 7, nameIndex: 3 }],
    bytecode: [0xbb, 0x00, 0x04, 0x57, 0xb1],
    name: 'nB',
  }));
  const a = bundleOf(stringFn, 0xbb).producedValues[0];
  const b = bundleOf(objectFn, 0xbb).producedValues[0];
  assert.equal(a.valueType, 'java/lang/String');
  assert.equal(b.valueType, 'java/lang/Object');
  assert.notEqual(a.valueType, b.valueType,
    'two distinct new targets must be distinguishable via the preserved metadata');
}

// C) out-of-range CP index: partial + `jvm-new-cp-class-invalid`, no
//    fabricated valueType on the produced value, canonical IR is `partial`.
{
  const cp = [
    ...CP_HEADER,
    { tag: 1, value: 'java/lang/String' },
    { tag: 7, nameIndex: 3 },
  ];
  // new #99 (dangling); pop; return
  const fn = liftJvmMethod(0, image({ cpEntries: cp, bytecode: [0xbb, 0x00, 0x63, 0x57, 0xb1], name: 'nC' }));
  const b = bundleOf(fn, 0xbb);
  assert.equal(b.completeness, 'partial');
  assert.ok(b.unknownEffects.some((e) => e.reason === 'jvm-new-cp-class-invalid'),
    'out-of-range CP must publish a stable reason');
  assert.equal(b.producedValues[0].valueType, undefined,
    'invalid CP must not fabricate an allocated-class identity');
  assert.equal(b.producedValues[0].referenceKind, undefined);
  const lowered = lowerVMEffectsToSemanticIr(fn);
  assert.equal(lowered.semanticIr.completeness, 'partial');
}

// D) wrong-tag CP operand (`CONSTANT_Utf8`, not a Class): same fail-closed
//    posture as (C), aligned with #8848 (C).
{
  const cp = [
    ...CP_HEADER,
    { tag: 1, value: 'java/lang/String' }, // Utf8 at #3, not a Class
  ];
  // new #3; pop; return
  const fn = liftJvmMethod(0, image({ cpEntries: cp, bytecode: [0xbb, 0x00, 0x03, 0x57, 0xb1], name: 'nD' }));
  const b = bundleOf(fn, 0xbb);
  assert.equal(b.completeness, 'partial');
  assert.ok(b.unknownEffects.some((e) => e.reason === 'jvm-new-cp-class-invalid'));
  assert.equal(b.producedValues[0].valueType, undefined);
}

// E) dangling `nameIndex`: the checked resolver treats this as invalid, so
//    no `valueType` is fabricated and the bundle is `partial` with
//    `jvm-new-cp-class-invalid`.
{
  const cp = [
    ...CP_HEADER,
    { tag: 7, nameIndex: 99 }, // dangling nameIndex
  ];
  const fn = liftJvmMethod(0, image({ cpEntries: cp, bytecode: [0xbb, 0x00, 0x03, 0x57, 0xb1], name: 'nE' }));
  const b = bundleOf(fn, 0xbb);
  assert.equal(b.completeness, 'partial');
  assert.ok(b.unknownEffects.some((e) => e.reason === 'jvm-new-cp-class-invalid'));
}

// F) `new #validClass; dup; invokespecial <init>; return` — the allocation
//    VMEffect stays `partial` with the DEX-aligned reason; the follow-on
//    `dup` / `invokespecial` do not launder the allocation back to exact.
{
  const cp = [
    ...CP_HEADER,
    { tag: 1, value: 'java/lang/String' },
    { tag: 7, nameIndex: 3 },
    { tag: 1, value: '<init>' },
    { tag: 1, value: '()V' },
    { tag: 12, nameIndex: 5, descriptorIndex: 6 },
    { tag: 10, classIndex: 4, nameAndTypeIndex: 7 },
  ];
  // new #4; dup; invokespecial #8; return
  const fn = liftJvmMethod(0, image({
    cpEntries: cp,
    bytecode: [0xbb, 0x00, 0x04, 0x59, 0xb7, 0x00, 0x08, 0xb1],
    name: 'nF',
  }));
  const allocation = bundleOf(fn, 0xbb);
  assert.equal(allocation.completeness, 'partial');
  assert.ok(allocation.unknownEffects.some((e) => e.reason === 'jvm-new-allocation-unrepresented'));
  assert.equal(allocation.producedValues[0].valueType, 'java/lang/String');
  assert.notEqual(fn.aggregateCompleteness, 'exact',
    'a valid `new` in a full alloc+dup+invokespecial sequence still cannot promote the function to exact');
}

console.log('issue-8845 jvm new CP class verification + fail closed: PASS');
