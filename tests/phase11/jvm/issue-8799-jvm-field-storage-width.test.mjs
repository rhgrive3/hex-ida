/**
 * #8799 regression: JVM field memory effects must carry the field's *storage*
 * width, proven by the field descriptor, separately from the operand-stack
 * value width. Before the fix no `byteWidth` was published at all, so the
 * shared bridge defaulted every `getfield`/`getstatic`/`putfield`/`putstatic`
 * canonical memory access to a complete 32-bit access for every descriptor.
 */
import assert from 'node:assert/strict';
import { liftJvmMethod } from '../../../js/managed/jvm/lifter.js';
import { lowerVMEffectsToSemanticIr } from '../../../js/managed/shared/bridge-v2.js';
import { classifyJvmFieldDescriptor } from '../../../js/managed/jvm/field-reference.js';

// descriptor -> [operand-stack value bits, storage byte width]
const CASES = [
  ['B', 32, 1],
  ['Z', 32, 1],
  ['C', 32, 2],
  ['S', 32, 2],
  ['F', 32, 4],
  ['I', 32, 4],
  ['J', 64, 8],
  ['D', 64, 8],
  ['Ljava/lang/String;', 64, 8],
  ['[I', 64, 8],
];

const GET = { static: 0xb2, instance: 0xb4 };
const PUT = { static: 0xb3, instance: 0xb5 };

// Two same-descriptor fields let a store be built from a real load instead of a
// float/double constant opcode, which the JVM lifter does not model.
function classFile(descriptor, kind, store) {
  const bytecode = !store
    ? (kind === 'instance' ? [0x2a, GET[kind], 0, 6, 0x57, 0xb1] : [GET[kind], 0, 6, 0x57, 0xb1])
    : (kind === 'instance' ? [0x2a, 0x2a, GET[kind], 0, 6, PUT[kind], 0, 9, 0xb1] : [GET[kind], 0, 6, PUT[kind], 0, 9, 0xb1]);
  return {
    moduleId: `managed-mod:issue-8799:${kind}:${store ? 'put' : 'get'}:${descriptor}`,
    vmSpecEdition: 'java-se-17',
    thisClassName: 'pkg/Test',
    fields: [
      { accessFlags: kind === 'static' ? 0x0009 : 0x0000, name: 'src', descriptor },
      { accessFlags: kind === 'static' ? 0x0009 : 0x0000, name: 'value', descriptor },
    ],
    constantPool: [
      null,
      { tag: 1, value: 'pkg/Test' },
      { tag: 7, nameIndex: 1 },
      { tag: 1, value: 'src' },
      { tag: 1, value: descriptor },
      { tag: 12, nameIndex: 3, descriptorIndex: 4 },
      { tag: 9, classIndex: 2, nameAndTypeIndex: 5 },
      { tag: 1, value: 'value' },
      { tag: 12, nameIndex: 7, descriptorIndex: 4 },
      { tag: 9, classIndex: 2, nameAndTypeIndex: 8 },
    ],
    methods: [{
      accessFlags: 0x0009, name: 'm', descriptor: '()V',
      code: { maxStack: 4, maxLocals: 1, offset: 0, exceptionTable: [], bytecode: Uint8Array.from(bytecode) },
    }],
  };
}

function popOpcode(descriptor) {
  // Category-2 fields (`J`/`D`) occupy two operand-stack slots; a reference is
  // one slot even though its value width is 64 bits.
  return descriptor === 'J' || descriptor === 'D' ? 0x58 : 0x57;
}

function fieldBundle(fn, isWrite) {
  return fn.bundles.find((bundle) => bundle.memoryEffects?.length === 1 && bundle.memoryEffects[0].isWrite === isWrite);
}

for (const [descriptor, valueBits, storageBytes] of CASES) {
  const loadClass = (kind) => classFile(descriptor, kind, false);
  const storeClass = (kind) => {
    const cls = classFile(descriptor, kind, true);
    return cls;
  };
  for (const kind of ['static', 'instance']) {
    // --- loads -------------------------------------------------------------
    {
      const cls = loadClass(kind);
      cls.methods[0].code.bytecode = Uint8Array.from(
        kind === 'instance'
          ? [0x2a, GET[kind], 0, 6, popOpcode(descriptor), 0xb1]
          : [GET[kind], 0, 6, popOpcode(descriptor), 0xb1],
      );
      const fn = liftJvmMethod(0, cls);
      const effect = fieldBundle(fn, false)?.memoryEffects[0];
      assert.ok(effect, `${kind} get${descriptor === 'Ljava/lang/String;' ? 'field' : 'static'}: field effect`);
      assert.equal(effect.valueBits, valueBits, `${kind} load ${descriptor}: stack value width`);
      assert.equal(effect.byteWidth, storageBytes, `${kind} load ${descriptor}: storage byteWidth published`);
      assert.equal(effect.storageBits, storageBytes * 8, `${kind} load ${descriptor}: storage bits`);
      assert.ok(Number.isSafeInteger(effect.byteWidth) && effect.byteWidth > 0,
        `${kind} load ${descriptor}: width must be proven, never omitted`);

      const lowered = lowerVMEffectsToSemanticIr(fn);
      const load = lowered.semanticIr.nodes.find((node) => node.kind === 'load');
      assert.ok(load, `${kind} load ${descriptor}: canonical load node`);
      assert.equal(load.memory.widthBits, storageBytes * 8,
        `${kind} load ${descriptor}: canonical access must be ${storageBytes} bytes, not an invented 32`);
      assert.equal(load.completeness, 'complete', `${kind} load ${descriptor}: proven width stays complete`);
      assert.equal(lowered.semanticIr.completeness, 'complete', `${kind} load ${descriptor}: function authority`);
    }
    // --- stores ------------------------------------------------------------
    {
      const fn = liftJvmMethod(0, storeClass(kind));
      const effect = fieldBundle(fn, true)?.memoryEffects[0];
      assert.ok(effect, `${kind} store ${descriptor}: store effect`);
      assert.equal(effect.byteWidth, storageBytes, `${kind} store ${descriptor}: store byteWidth`);
      assert.equal(effect.valueBits, valueBits, `${kind} store ${descriptor}: stored value width`);
      const lowered = lowerVMEffectsToSemanticIr(fn);
      const store = lowered.semanticIr.nodes.find((node) => node.kind === 'store');
      assert.ok(store, `${kind} store ${descriptor}: canonical store node`);
      assert.equal(store.memory.widthBits, storageBytes * 8, `${kind} store ${descriptor}: canonical store width`);
      assert.equal(lowered.semanticIr.completeness, 'complete', `${kind} store ${descriptor}: function authority`);
    }
  }
}

// Storage width and value width are separate axes: a narrow field reads one or
// two bytes but still yields a 32-bit `int` on the operand stack.
{
  const byte = classifyJvmFieldDescriptor('B');
  assert.equal(byte.storageByteWidth, 1);
  assert.equal(byte.storageBits, 8);
  assert.equal(byte.bits, 32, 'a byte field still produces a 32-bit stack int');
  const short = classifyJvmFieldDescriptor('S');
  assert.equal(short.storageByteWidth, 2);
  const long = classifyJvmFieldDescriptor('J');
  assert.equal(long.storageByteWidth, 8);
  assert.equal(long.bits, 64);
  for (const descriptor of ['Ljava/lang/String;', '[I', '[[Ljava/lang/Object;']) {
    const ref = classifyJvmFieldDescriptor(descriptor);
    assert.equal(ref.valueKind, 'reference');
    assert.equal(ref.storageByteWidth, 8, 'reference storage follows the project 64-bit reference model');
    assert.equal(ref.bits, ref.storageBits, 'reference value and storage widths agree');
  }
  assert.equal(classifyJvmFieldDescriptor('V'), null, 'void is not a field descriptor');
  assert.equal(classifyJvmFieldDescriptor('Lx'), null);
}

console.log('ok #8799 JVM field storage width is descriptor-proven on all four field families');
