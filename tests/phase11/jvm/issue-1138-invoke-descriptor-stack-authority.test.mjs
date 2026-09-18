import assert from 'node:assert/strict';
import test from 'node:test';

import { liftJvmMethod } from '../../../js/managed/jvm/lifter.js';
import { lowerVMEffectsToSemanticIr } from '../../../js/managed/shared/bridge-v2.js';

const utf8 = (value) => ({ tag: 1, value });
const classInfo = (nameIndex) => ({ tag: 7, nameIndex });
const nameAndType = (nameIndex, descriptorIndex) => ({ tag: 12, nameIndex, descriptorIndex });
const methodref = (classIndex, natIndex) => ({ tag: 10, classIndex, nameAndTypeIndex: natIndex });
const interfaceRef = (classIndex, natIndex) => ({ tag: 11, classIndex, nameAndTypeIndex: natIndex });

// Call-site constant pool. Slots are fixed so the bytecode below can name them:
//   6 = Test.add1(I)I        10 = Test.wd(JLjava/lang/Object;)D
//   14 = Test.run()V         17 = Test.<init>()V
//   22 = Iface.go(I)I        35 = (empty slot, never resolvable)
function pool() {
  const entries = [null];
  const put = (entry) => { entries.push(entry); return entries.length - 1; };
  const thisName = put(utf8('pkg/Test'));
  const thisClass = put(classInfo(thisName));
  const add1Name = put(utf8('add1'));
  const add1Desc = put(utf8('(I)I'));
  const add1Nat = put(nameAndType(add1Name, add1Desc));
  put(methodref(thisClass, add1Nat));
  const wdName = put(utf8('wd'));
  const wdDesc = put(utf8('(JLjava/lang/Object;)D'));
  const wdNat = put(nameAndType(wdName, wdDesc));
  put(methodref(thisClass, wdNat));
  const runName = put(utf8('run'));
  const voidDesc = put(utf8('()V'));
  const runNat = put(nameAndType(runName, voidDesc));
  put(methodref(thisClass, runNat));
  const initName = put(utf8('<init>'));
  const initNat = put(nameAndType(initName, voidDesc));
  put(methodref(thisClass, initNat));
  const ifaceName = put(utf8('pkg/Iface'));
  const ifaceClass = put(classInfo(ifaceName));
  const goName = put(utf8('go'));
  const goNat = put(nameAndType(goName, add1Desc));
  put(interfaceRef(ifaceClass, goNat));
  while (entries.length <= 35) entries.push(null);
  return entries;
}

function image({ bytecode, descriptor = '()I', maxStack = 6, maxLocals = 4 }) {
  return {
    moduleId: 'managed-mod:issue-1138',
    vmSpecEdition: 'java-se-17',
    thisClassName: 'pkg/Test',
    fields: [],
    constantPool: pool(),
    methods: [{
      accessFlags: 0x0009,
      name: 'caller',
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

function lift(overrides) {
  const fn = liftJvmMethod(0, image(overrides));
  return { fn, bundle: fn.bundles.find((entry) => String(entry.mnemonic).startsWith('invoke')) };
}

test('#1138 invokestatic (I)I consumes one argument and produces the declared return value', () => {
  const { bundle } = lift({ bytecode: [0x06, 0xb8, 0x00, 0x06, 0xac] });
  assert.equal(bundle.completeness, 'exact');
  assert.deepEqual(bundle.consumedValues.map((value) => [value.descriptor, value.category]), [['I', 1]]);
  assert.deepEqual(bundle.producedValues.map((value) => [value.descriptor, value.category]), [['I', 1]]);
  assert.equal(bundle.unknownEffects.length, 0);
  assert.deepEqual(bundle.callEffects, [{
    cpIndex: 6,
    dispatchKind: 'static',
    owner: 'pkg/Test',
    name: 'add1',
    descriptor: '(I)I',
    receiverRequired: false,
    argumentDescriptors: ['I'],
    returnDescriptor: 'I',
  }]);
});

test('#1138 invokevirtual (JLjava/lang/Object;)D accounts for the receiver and both category widths', () => {
  const { fn, bundle } = lift({
    bytecode: [0x0a, 0x2a, 0xb6, 0x00, 0x0a, 0xaf],
    descriptor: '(Ljava/lang/Object;)D',
    maxLocals: 1,
  });
  assert.equal(bundle.completeness, 'exact');
  // Pop order is stack-top first: the last declared argument leaves first and
  // the objectref is the deepest consumed value.
  assert.deepEqual(bundle.consumedValues.map((value) => [value.descriptor, value.category]), [
    ['Ljava/lang/Object;', 1],
    ['J', 2],
    ['Ljava/lang/Object;', 1],
  ]);
  assert.deepEqual(bundle.producedValues, [{
    id: 'return',
    bits: 64,
    category: 2,
    valueKind: 'double',
    descriptor: 'D',
    type: { kind: 'float', widthBits: 64, format: 'binary64' },
  }]);
  // The category model stays trusted across the call, so the following `dreturn`
  // is still an exact projection of a known stack shape.
  const returned = fn.bundles.find((entry) => entry.opcode === 0xaf);
  assert.equal(returned.completeness, 'exact');
});

test('#1138 invokeinterface resolves through the interface method reference', () => {
  const { bundle } = lift({ bytecode: [0x06, 0xb9, 0x00, 0x16, 0x02, 0x00, 0xac] });
  assert.equal(bundle.completeness, 'exact');
  assert.equal(bundle.callEffects[0].dispatchKind, 'interface');
  assert.equal(bundle.callEffects[0].descriptor, '(I)I');
  assert.deepEqual(bundle.consumedValues.map((value) => value.descriptor), ['I', 'Ljava/lang/Object;']);
  assert.deepEqual(bundle.producedValues.map((value) => value.descriptor), ['I']);
});

test('#1138 a void call consumes its signature and produces no value', () => {
  const { bundle } = lift({ bytecode: [0xb8, 0x00, 0x0e, 0xb1] });
  assert.equal(bundle.completeness, 'exact');
  assert.deepEqual(bundle.consumedValues, []);
  assert.deepEqual(bundle.producedValues, []);
  assert.equal(bundle.callEffects[0].returnDescriptor, null);
});

test('#1138 invokespecial <init> consumes the receiver and pushes that same object back initialized', () => {
  const { fn } = lift({ bytecode: [0xbb, 0x00, 0x02, 0x59, 0xb7, 0x00, 0x11, 0x57, 0xb1] });
  const created = fn.bundles.find((entry) => entry.mnemonic === 'new');
  const duplicated = fn.bundles.find((entry) => entry.mnemonic === 'dup');
  const init = fn.bundles.find((entry) => entry.mnemonic === 'invokespecial');
  const allocationId = created.producedValues[0].allocationId;
  assert.equal(typeof allocationId, 'string');
  assert.deepEqual(init.consumedValues.map((value) => value.id), ['objectref']);
  assert.equal(init.producedValues.length, 1);
  const pushedBack = init.producedValues[0];
  assert.equal(pushedBack.aliasConsumedReceiver, true);
  assert.equal(pushedBack.allocationId, allocationId);
  assert.equal(pushedBack.allocationState, 'initialized');
  assert.equal(pushedBack.fresh, true);
  assert.equal(init.callEffects[0].initializesAllocation, true);
  assert.equal(init.callEffects[0].receiverAllocationId, allocationId);
  assert.equal(duplicated.producedValues[0].allocationId, allocationId);
});

test('#1138 an unresolvable method reference stays partial and invents no stack effect', () => {
  const wrongTag = lift({ bytecode: [0x06, 0xb8, 0x00, 0x03, 0xac] }); // slot 3 is a Utf8, not a Methodref
  assert.equal(wrongTag.bundle.completeness, 'partial');
  assert.deepEqual(wrongTag.bundle.consumedValues, []);
  assert.deepEqual(wrongTag.bundle.producedValues, []);
  assert.equal(wrongTag.bundle.callEffects[0].descriptorUnresolved, true);
  assert.deepEqual(wrongTag.bundle.unknownEffects.map((effect) => effect.category).sort(), ['calls', 'stack']);

  const missing = lift({ bytecode: [0x06, 0xb8, 0x00, 0x23, 0xac] }); // slot 35 does not resolve
  assert.equal(missing.bundle.completeness, 'partial');
  assert.deepEqual(missing.bundle.consumedValues, []);

  const wrongKind = lift({ bytecode: [0x06, 0xb6, 0x00, 0x16, 0xac] }); // interface ref via invokevirtual
  assert.equal(wrongKind.bundle.completeness, 'partial');
  assert.deepEqual(wrongKind.bundle.consumedValues, []);
});

test('#1138 the lowered call result is the value the next instruction consumes', () => {
  const { fn } = lift({ bytecode: [0x06, 0xb8, 0x00, 0x06, 0xac] });
  const lowered = lowerVMEffectsToSemanticIr(fn);
  const call = lowered.semanticIr.nodes.find((node) => node.metadata?.mnemonic === 'invokestatic');
  assert.equal(call.kind, 'call');
  assert.equal(call.inputs.length, 1, 'the argument must reach the call as an input');
  assert.equal(call.outputs.length, 1);
  assert.deepEqual(call.call.returns, call.outputs);
  const returned = lowered.semanticIr.nodes.find((node) => node.kind === 'return');
  assert.deepEqual(returned.inputs, call.outputs, 'the return must be the call result, not the pre-call constant');
  const argument = lowered.semanticIr.values.find((value) => call.inputs.includes(value.id));
  assert.deepEqual(argument.machineType, { kind: 'bitvector', widthBits: 32 });
  const result = lowered.semanticIr.values.find((value) => call.outputs.includes(value.id));
  assert.deepEqual(result.machineType, { kind: 'bitvector', widthBits: 32 });
});
