import assert from 'node:assert/strict';
import test from 'node:test';

import { liftJvmMethod } from '../../../js/managed/jvm/lifter.js';
import { lowerVMEffectsToSemanticIr } from '../../../js/managed/shared/bridge-v2.js';

function image({ bytecode, name = 'm', descriptor = '()V', accessFlags = 0x0009, maxLocals = 6 }) {
  return {
    moduleId: 'managed-mod:issue-8836-ref-transport',
    vmSpecEdition: 'java-se-17',
    thisClassName: 'pkg/Test',
    fields: [],
    constantPool: [null, { tag: 1, value: 'pkg/Test' }, { tag: 7, nameIndex: 1 }],
    methods: [{
      accessFlags,
      name,
      descriptor,
      code: { maxStack: 4, maxLocals, offset: 0, exceptionTable: [], bytecode: Uint8Array.from(bytecode) },
    }],
  };
}

function loweredMachineTypes(fn, mnemonic) {
  const lowered = lowerVMEffectsToSemanticIr(fn);
  const node = lowered.semanticIr.nodes.find((entry) => entry.metadata?.mnemonic === mnemonic);
  if (!node) return null;
  return node.outputs.map((id) => lowered.semanticIr.values.find((entry) => entry.id === id)?.machineType);
}

function isManagedHeapReference(type) {
  return !!type && type.kind === 'address' && type.addressSpace === 'managed-heap';
}

test('#8836 aconst_null publishes canonical managed-heap reference (not bare bitvector64)', () => {
  const fn = liftJvmMethod(0, image({ bytecode: [0x01, 0xb0], name: 'n', descriptor: '()Ljava/lang/Object;' }));
  const bundle = fn.bundles.find((entry) => entry.opcode === 0x01);
  const produced = bundle.producedValues[0];
  assert.equal(produced.isNull, true);
  assert.equal(produced.type?.kind, 'address');
  assert.equal(produced.type?.addressSpace, 'managed-heap');
  assert.equal(produced.stackType, 'reference');

  assert.ok(isManagedHeapReference(loweredMachineTypes(fn, 'aconst_null')[0]));
});

test('#8836 aload of a reference parameter keeps managed-heap address through areturn', () => {
  // static (Ljava/lang/Object;)Ljava/lang/Object; { aload_0; areturn }
  const fn = liftJvmMethod(0, image({
    bytecode: [0x2a, 0xb0],
    name: 'id',
    descriptor: '(Ljava/lang/Object;)Ljava/lang/Object;',
    accessFlags: 0x0008, // ACC_STATIC
  }));
  const bundle = fn.bundles.find((entry) => entry.opcode === 0x2a);
  assert.equal(bundle.producedValues[0].type?.kind, 'address');
  assert.equal(bundle.producedValues[0].type?.addressSpace, 'managed-heap');

  const loadTypes = loweredMachineTypes(fn, 'aload_0');
  assert.ok(isManagedHeapReference(loadTypes[0]), `aload_0 must not be a bare bitvector: ${JSON.stringify(loadTypes)}`);
});

test('#8836 aload of the instance receiver slot is a managed-heap reference', () => {
  // (I)V instance: slot 0 = `this` (reference), slot 1 = int arg
  const fn = liftJvmMethod(0, image({
    bytecode: [0x2a, 0xb1],
    name: 'run',
    descriptor: '(I)V',
    accessFlags: 0x0002, // non-static
  }));
  const loadTypes = loweredMachineTypes(fn, 'aload_0');
  assert.ok(isManagedHeapReference(loadTypes[0]));
});

test('#8836 an int parameter local is NOT mistyped as a reference', () => {
  // static (I)V { iload_0; pop; return }: slot 0 is int -> stays a bitvector
  const fn = liftJvmMethod(0, image({
    bytecode: [0x1a, 0x57, 0xb1],
    name: 'use',
    descriptor: '(I)V',
    accessFlags: 0x0008,
  }));
  const loadTypes = loweredMachineTypes(fn, 'iload_0');
  assert.equal(loadTypes[0].kind, 'bitvector');
  assert.notEqual(loadTypes[0].addressSpace, 'managed-heap');
});
