import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createManagedMethodId, createVMEffectBundle, createVMEffectFunction, createVMOperationId,
} from '../../../js/managed/index.js';
import { liftJvmMethod } from '../../../js/managed/jvm/lifter.js';
import { decompileManagedMethod, lowerVMEffectsToSemanticIr } from '../../../js/managed/shared/bridge-v2.js';
import { evalBinary } from '../../../js/decompiler/truth/integer.js';

// #8843: JVM `dup` must lower as a stack identity transformation. Before the
// repair the shared bridge published it as `kind:'unary'` with
// `operator: null` and `completeness:'complete'`, defining two unrelated fresh
// values, so no consumer could recover that both result slots name the same
// value (`iconst_5; dup; iadd` became `dup(5) + dup(5)`).
function image({ bytecode, name = 'dup', descriptor = '()I' }) {
  return {
    moduleId: 'managed-mod:issue-8843-dup-identity',
    vmSpecEdition: 'java-se-17',
    thisClassName: 'pkg/Test',
    fields: [],
    constantPool: [
      null,
      { tag: 1, value: 'pkg/Test' },
      { tag: 7, nameIndex: 1 },
      { tag: 1, value: 'java/lang/String' },
      { tag: 7, nameIndex: 3 },
      { tag: 1, value: '<init>' },
      { tag: 1, value: '()V' },
      { tag: 12, nameIndex: 5, descriptorIndex: 6 },
      { tag: 10, classIndex: 4, nameAndTypeIndex: 7 },
    ],
    methods: [{
      accessFlags: 0x0009,
      name,
      descriptor,
      code: {
        maxStack: 4,
        maxLocals: 4,
        offset: 0,
        exceptionTable: [],
        bytecode: Uint8Array.from(bytecode),
      },
    }],
  };
}

const lower = (spec) => lowerVMEffectsToSemanticIr(liftJvmMethod(0, image(spec)));
const nodeFor = (lowered, mnemonic) => lowered.semanticIr.nodes.find((entry) => entry.metadata?.mnemonic === mnemonic);
const valueById = (lowered, id) => lowered.semanticIr.values.find((entry) => entry.id === id);

test('#8843 dup is a canonical copy of one source value, not an operator:null complete unary', () => {
  const lowered = lower({ bytecode: [0x08, 0x59, 0x57, 0xac] }); // iconst_5; dup; pop; ireturn
  const dup = nodeFor(lowered, 'dup');
  const source = valueById(lowered, nodeFor(lowered, 'iconst_5').outputs[0]);

  assert.equal(dup.kind, 'copy');
  assert.equal(dup.operator, null);
  assert.deepEqual(dup.inputs, [source.id]);
  assert.equal(dup.outputs.length, 2);
  assert.equal(dup.attributes.stackManipulation, 'dup');
  assert.equal(dup.attributes.duplicatedValueId, source.id);
  assert.deepEqual(dup.attributes.duplicateValueIds, dup.outputs);
  // Both result slots are defined by the one copy of the one source value.
  for (const id of dup.outputs) {
    const value = valueById(lowered, id);
    assert.equal(value.definitionNodeId, dup.id);
    assert.equal(value.metadata.duplicatedValueId, source.id);
    assert.deepEqual(value.metadata.duplicateValueIds, dup.outputs);
    assert.equal(value.machineType.widthBits, source.machineType.widthBits);
    assert.equal(value.metadata.constant, source.metadata.constant);
  }
  assert.ok(!lowered.semanticIr.unknowns.some((entry) => entry.reason === 'managed-unary-operator-unresolved'));
});

test('#8843 concrete dup feeds one constant authority into both operands of the next operation', () => {
  const lowered = lower({ bytecode: [0x08, 0x59, 0x60, 0xac] }); // iconst_5; dup; iadd; ireturn
  const dup = nodeFor(lowered, 'dup');
  const add = nodeFor(lowered, 'iadd');
  assert.deepEqual(add.inputs, dup.outputs);
  for (const id of add.inputs) {
    const value = valueById(lowered, id);
    assert.equal(value.metadata.constant, '5');
    assert.equal(value.metadata.duplicatedValueId, nodeFor(lowered, 'iconst_5').outputs[0]);
  }
  assert.equal(lowered.semanticIr.completeness, 'complete');
  assert.match(decompileManagedMethod(lowered).pseudocode, /5 \+ 5/);
  // The duplicated authority is canonical and evaluable: `add` over the same
  // 32-bit constant 5 twice is 10, the JVM result of `5; dup; iadd`.
  assert.equal(add.operator, 'add');
  assert.equal(evalBinary(add.operator, 5n, 5n, 32), 10n);
});

test('#8843 symbolic dup keeps one local identity across both result slots', () => {
  const lowered = lower({ bytecode: [0x1a, 0x59, 0x60, 0xac] }); // iload_0; dup; iadd; ireturn
  const dup = nodeFor(lowered, 'dup');
  const load = nodeFor(lowered, 'iload_0');
  assert.deepEqual(dup.inputs, load.outputs);
  const pseudocode = decompileManagedMethod(lowered).pseudocode;
  assert.match(pseudocode, /local_0 \+ local_0/);
  assert.doesNotMatch(pseudocode, /dup\(/);
});

test('#8843 new -> dup -> invokespecial shares one allocation identity through the duplicated slot', () => {
  const fn = liftJvmMethod(0, image({
    bytecode: [0xbb, 0x00, 0x04, 0x59, 0xb7, 0x00, 0x08, 0x57, 0xb1],
    name: 'init',
    descriptor: '()V',
  }));
  const allocationId = fn.bundles.find((entry) => entry.opcode === 0xbb).producedValues[0].allocationId;
  const lowered = lowerVMEffectsToSemanticIr(fn);
  const dup = nodeFor(lowered, 'dup');
  assert.equal(dup.kind, 'copy');
  assert.equal(dup.attributes.preservesAllocationIdentity, true);
  assert.deepEqual(dup.attributes.allocationIds, [allocationId]);
  assert.deepEqual(dup.attributes.duplicateValueIds, dup.outputs);
  for (const id of dup.outputs) {
    const value = valueById(lowered, id);
    assert.equal(value.machineType.addressSpace, 'managed-heap');
    assert.equal(value.metadata.duplicatedValueId, dup.attributes.duplicatedValueId);
  }
  // The constructor receiver keeps the same allocation identity as the
  // duplicated slot, and the surviving stack reference is the other duplicate
  // result of the same copy. (#1138 still omits the invoke's descriptor-derived
  // operand signature, so the receiver is asserted through the call effect's
  // allocation authority and the surviving reference through `pop`.)
  const init = nodeFor(lowered, 'invokespecial');
  assert.equal(init.attributes.receiverAllocationId, allocationId);
  assert.deepEqual(nodeFor(lowered, 'pop').inputs, [dup.outputs[1]]);
});

test('#8843 a partial dup is not promoted to complete by the identity overlay', () => {
  const methodId = createManagedMethodId('managed-mod:issue-8843-partial', 0, 'partialDup');
  const bundle = (offset, input) => createVMEffectBundle({
    frontendId: 'jvm',
    methodId,
    operationId: createVMOperationId(methodId, offset),
    bytecodeOffset: offset,
    ...input,
  });
  const fn = createVMEffectFunction({
    frontendId: 'jvm',
    methodId,
    aggregateCompleteness: 'partial',
    resolutionCompleteness: 'complete',
    bundles: [
      bundle(0, { mnemonic: 'iload_0', completeness: 'exact', locationReads: [{ kind: 'local', index: 0, bits: 32 }], producedValues: [{ bits: 32 }] }),
      bundle(1, {
        mnemonic: 'dup',
        completeness: 'partial',
        unknownEffects: [{ category: 'stack', reason: 'jvm-dup-category-unresolved' }],
        consumedValues: [{ id: 'top' }],
        producedValues: [{ id: 'dup1' }, { id: 'dup2' }],
      }),
      bundle(2, { mnemonic: 'return', completeness: 'exact', consumedValues: [{ id: 'ret' }], controlEffects: [{ kind: 'return' }] }),
    ],
  });
  const lowered = lowerVMEffectsToSemanticIr(fn);
  const dup = nodeFor(lowered, 'dup');
  assert.equal(dup.kind, 'copy');
  assert.equal(dup.completeness, 'partial');
  assert.equal(dup.unknown.reason, 'jvm-dup-category-unresolved');
  assert.notEqual(dup.completeness, 'complete');
  assert.equal(lowered.semanticIr.completeness, 'partial');
});

test('#8843 an unprovable dup shape is left untouched instead of asserting equality', () => {
  const methodId = createManagedMethodId('managed-mod:issue-8843-shape', 0, 'mixedWidthDup');
  const bundle = (offset, input) => createVMEffectBundle({
    frontendId: 'jvm',
    methodId,
    operationId: createVMOperationId(methodId, offset),
    bytecodeOffset: offset,
    ...input,
  });
  const fn = createVMEffectFunction({
    frontendId: 'jvm',
    methodId,
    aggregateCompleteness: 'partial',
    resolutionCompleteness: 'complete',
    bundles: [
      bundle(0, { mnemonic: 'iload_0', completeness: 'exact', locationReads: [{ kind: 'local', index: 0, bits: 32 }], producedValues: [{ bits: 32 }] }),
      bundle(1, {
        mnemonic: 'dup',
        completeness: 'exact',
        consumedValues: [{ id: 'top' }],
        // Contradictory result widths: this is not a provable stack duplicate.
        producedValues: [{ bits: 32 }, { bits: 64 }],
      }),
      bundle(2, { mnemonic: 'return', completeness: 'exact', consumedValues: [{ id: 'ret' }], controlEffects: [{ kind: 'return' }] }),
    ],
  });
  const lowered = lowerVMEffectsToSemanticIr(fn);
  const dup = nodeFor(lowered, 'dup');
  assert.notEqual(dup.attributes.stackManipulation, 'dup');
  assert.notEqual(dup.kind, 'copy');
  for (const id of dup.outputs) {
    const value = valueById(lowered, id);
    assert.equal(value.metadata?.duplicatedValueId, undefined);
  }
});
