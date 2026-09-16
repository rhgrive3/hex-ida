import assert from 'node:assert/strict';
import test from 'node:test';

import { liftJvmMethod } from '../../../js/managed/jvm/lifter.js';
import { lowerVMEffectsToSemanticIr } from '../../../js/managed/shared/bridge-v2.js';

function image({ bytecode, name = 'alloc' }) {
  return {
    moduleId: 'managed-mod:issue-8845-freshness',
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

test('#8845 valid new publishes managed-heap fresh allocation identity but stays partial', () => {
  const fn = liftJvmMethod(0, image({ bytecode: [0xbb, 0x00, 0x04, 0x57, 0xb1] }));
  const bundle = fn.bundles.find((entry) => entry.opcode === 0xbb);
  const produced = bundle.producedValues[0];
  assert.equal(bundle.completeness, 'partial');
  assert.ok(bundle.unknownEffects.some((effect) => effect.reason === 'jvm-new-allocation-unrepresented'));
  assert.equal(produced.type?.kind, 'address');
  assert.equal(produced.type?.addressSpace, 'managed-heap');
  assert.equal(produced.valueType, 'java/lang/String');
  assert.equal(produced.allocatedClass, 'java/lang/String');
  assert.equal(produced.referenceKind, 'new-allocation');
  assert.equal(produced.allocationState, 'uninitialized');
  assert.equal(produced.fresh, true);
  assert.match(produced.allocationId, /^jvm-allocation:/);

  const lowered = lowerVMEffectsToSemanticIr(fn);
  const node = lowered.semanticIr.nodes.find((entry) => entry.metadata?.mnemonic === 'new');
  assert.equal(node.kind, 'intrinsic');
  assert.equal(node.operator, 'jvm-new');
  assert.equal(node.attributes.semantic, 'allocation');
  assert.equal(node.attributes.allocatedClass, 'java/lang/String');
  assert.equal(node.attributes.allocationId, produced.allocationId);
  assert.equal(node.attributes.fresh, true);
  const value = lowered.semanticIr.values.find((entry) => node.outputs.includes(entry.id));
  assert.equal(value.machineType.kind, 'address');
  assert.equal(value.machineType.addressSpace, 'managed-heap');
  assert.equal(value.metadata.allocationId, produced.allocationId);
});

test('#8845 two new sites of the same class mint distinct fresh identities', () => {
  const fn = liftJvmMethod(0, image({
    bytecode: [
      0xbb, 0x00, 0x04, 0x57,
      0xbb, 0x00, 0x04, 0x57,
      0xb1,
    ],
    name: 'two',
  }));
  const allocations = fn.bundles.filter((entry) => entry.opcode === 0xbb)
    .map((entry) => entry.producedValues[0].allocationId);
  assert.equal(allocations.length, 2);
  assert.ok(allocations.every((id) => typeof id === 'string'));
  assert.notEqual(allocations[0], allocations[1]);
});

test('#8845 new -> dup -> invokespecial <init> preserves one allocation identity', () => {
  const fn = liftJvmMethod(0, image({
    // new #4; dup; invokespecial #8; pop; return
    bytecode: [0xbb, 0x00, 0x04, 0x59, 0xb7, 0x00, 0x08, 0x57, 0xb1],
    name: 'init',
  }));
  const allocation = fn.bundles.find((entry) => entry.opcode === 0xbb);
  const dup = fn.bundles.find((entry) => entry.opcode === 0x59);
  const init = fn.bundles.find((entry) => entry.opcode === 0xb7);
  const allocationId = allocation.producedValues[0].allocationId;
  assert.equal(dup.consumedValues[0].allocationId, allocationId);
  assert.deepEqual(dup.producedValues.map((value) => value.allocationId), [allocationId, allocationId]);
  assert.equal(init.callEffects[0].receiverAllocationId, allocationId);
  assert.equal(init.callEffects[0].initializesAllocation, true);
  assert.equal(init.callEffects[0].owner, 'java/lang/String');
  assert.equal(init.callEffects[0].name, '<init>');
  assert.equal(init.callEffects[0].descriptor, '()V');

  const lowered = lowerVMEffectsToSemanticIr(fn);
  const newNode = lowered.semanticIr.nodes.find((entry) => entry.metadata?.mnemonic === 'new');
  const dupNode = lowered.semanticIr.nodes.find((entry) => entry.metadata?.mnemonic === 'dup');
  const initNode = lowered.semanticIr.nodes.find((entry) => entry.metadata?.mnemonic === 'invokespecial');
  assert.equal(newNode.attributes.allocationId, allocationId);
  assert.equal(dupNode.attributes.preservesAllocationIdentity, true);
  assert.deepEqual(dupNode.attributes.allocationIds, [allocationId]);
  assert.equal(initNode.attributes.receiverAllocationId, allocationId);
  assert.equal(initNode.attributes.initializesAllocation, true);
});
