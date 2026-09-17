import { createVMEffectBundle, createVMEffectFunction } from '../shared/vm-effects.js';

const JVM_MANAGED_HEAP_REFERENCE_TYPE = Object.freeze({
  kind: 'address',
  widthBits: 32,
  addressSpace: 'managed-heap',
});

const JVM_NEWARRAY_TYPES = Object.freeze({
  4: Object.freeze({ descriptor: '[Z', elementDescriptor: 'Z', byteWidth: 1, bits: 32, valueKind: 'boolean' }),
  5: Object.freeze({ descriptor: '[C', elementDescriptor: 'C', byteWidth: 2, bits: 32, valueKind: 'char' }),
  6: Object.freeze({ descriptor: '[F', elementDescriptor: 'F', byteWidth: 4, bits: 32, valueKind: 'float', type: Object.freeze({ kind: 'float', widthBits: 32, format: 'binary32' }) }),
  7: Object.freeze({ descriptor: '[D', elementDescriptor: 'D', byteWidth: 8, bits: 64, category: 2, valueKind: 'double', type: Object.freeze({ kind: 'float', widthBits: 64, format: 'binary64' }) }),
  8: Object.freeze({ descriptor: '[B', elementDescriptor: 'B', byteWidth: 1, bits: 32, valueKind: 'byte' }),
  9: Object.freeze({ descriptor: '[S', elementDescriptor: 'S', byteWidth: 2, bits: 32, valueKind: 'short' }),
  10: Object.freeze({ descriptor: '[I', elementDescriptor: 'I', byteWidth: 4, bits: 32, valueKind: 'int' }),
  11: Object.freeze({ descriptor: '[J', elementDescriptor: 'J', byteWidth: 8, bits: 64, category: 2, valueKind: 'long' }),
});

const JVM_ARRAY_ACCESS_TYPES = Object.freeze([
  Object.freeze({ load: 'iaload', store: 'iastore', elementDescriptor: 'I', byteWidth: 4, bits: 32, valueKind: 'int' }),
  Object.freeze({ load: 'laload', store: 'lastore', elementDescriptor: 'J', byteWidth: 8, bits: 64, category: 2, valueKind: 'long' }),
  Object.freeze({ load: 'faload', store: 'fastore', elementDescriptor: 'F', byteWidth: 4, bits: 32, valueKind: 'float', type: Object.freeze({ kind: 'float', widthBits: 32, format: 'binary32' }) }),
  Object.freeze({ load: 'daload', store: 'dastore', elementDescriptor: 'D', byteWidth: 8, bits: 64, category: 2, valueKind: 'double', type: Object.freeze({ kind: 'float', widthBits: 64, format: 'binary64' }) }),
  Object.freeze({ load: 'aaload', store: 'aastore', elementDescriptor: 'reference', byteWidth: 4, bits: 32, valueKind: 'reference', type: JVM_MANAGED_HEAP_REFERENCE_TYPE }),
  Object.freeze({ load: 'baload', store: 'bastore', elementDescriptor: 'B/Z', byteWidth: 1, bits: 32, valueKind: 'byte-or-boolean' }),
  Object.freeze({ load: 'caload', store: 'castore', elementDescriptor: 'C', byteWidth: 2, bits: 32, valueKind: 'char' }),
  Object.freeze({ load: 'saload', store: 'sastore', elementDescriptor: 'S', byteWidth: 2, bits: 32, valueKind: 'short' }),
]);

function resolveJvmClassRefName(jvmClass, cpIndex) {
  const pool = jvmClass?.constantPool;
  if (!Array.isArray(pool) || !Number.isInteger(cpIndex) || cpIndex <= 0 || cpIndex >= pool.length) return null;
  const entry = pool[cpIndex];
  if (!entry || entry.tag !== 7 || !Number.isInteger(entry.nameIndex)) return null;
  const name = pool[entry.nameIndex];
  return name?.tag === 1 && typeof name.value === 'string' && name.value.length > 0 ? name.value : null;
}

function arrayDescriptorForComponent(componentName) {
  if (typeof componentName !== 'string' || componentName.length === 0) return null;
  return componentName.startsWith('[') ? `[${componentName}` : `[L${componentName};`;
}

function arrayRank(descriptor) {
  if (typeof descriptor !== 'string') return 0;
  let rank = 0;
  while (descriptor[rank] === '[') rank++;
  return rank;
}

function arrayAccessExceptions(store) {
  const effects = [
    { kind: 'null-reference', condition: 'arrayref==null' },
    { kind: 'array-index-out-of-bounds', condition: 'index<0||index>=arraylength' },
  ];
  if (store) effects.push({ kind: 'array-store', condition: 'value-not-assignable-to-component-type' });
  return effects;
}

function arrayAllocationValue(bundle, valueType, extra = {}) {
  return {
    bits: 32,
    category: 1,
    type: JVM_MANAGED_HEAP_REFERENCE_TYPE,
    stackType: 'reference',
    valueType,
    allocatedClass: valueType,
    allocationId: `jvm-allocation:${bundle.operationId}`,
    allocationState: 'initialized',
    fresh: true,
    referenceKind: 'new-array-allocation',
    ...extra,
  };
}

function arrayAccessBundle(bundle, opcode, options) {
  const isLoad = opcode >= 0x2e && opcode <= 0x35;
  const info = JVM_ARRAY_ACCESS_TYPES[opcode - (isLoad ? 0x2e : 0x4f)];
  if (!info) return bundle;
  const value = {
    id: isLoad ? 'array-element' : 'value',
    bits: info.bits,
    category: info.category ?? 1,
    valueKind: info.valueKind,
    ...(info.type ? { type: info.type } : {}),
  };
  const consumedValues = isLoad
    ? [
      { id: 'index', bits: 32 },
      { id: 'arrayref', bits: 32, type: JVM_MANAGED_HEAP_REFERENCE_TYPE, stackType: 'reference' },
    ]
    : [
      value,
      { id: 'index', bits: 32 },
      { id: 'arrayref', bits: 32, type: JVM_MANAGED_HEAP_REFERENCE_TYPE, stackType: 'reference' },
    ];
  return createVMEffectBundle({
    ...bundle,
    mnemonic: isLoad ? info.load : info.store,
    consumedValues,
    producedValues: isLoad ? [value] : [],
    memoryEffects: [{
      space: 'array-element',
      isWrite: !isLoad,
      byteWidth: info.byteWidth,
      elementDescriptor: info.elementDescriptor,
      valueKind: info.valueKind,
      indexValue: 'index',
      baseValue: 'arrayref',
    }],
    possibleExceptions: arrayAccessExceptions(!isLoad && opcode === 0x53),
    completeness: 'partial',
    unknownEffects: [{ category: 'memory', reason: 'jvm-array-index-address-unrepresented' }],
  }, options);
}

function arrayAllocationBundle(bundle, bytecode, jvmClass, options) {
  const offset = bundle.bytecodeOffset;
  const opcode = bundle.opcode;
  if (opcode === 0xbc) {
    if (offset + 1 >= bytecode.length) return bundle;
    const atype = bytecode[offset + 1];
    const info = JVM_NEWARRAY_TYPES[atype] ?? null;
    if (!info) {
      return createVMEffectBundle({
        ...bundle,
        mnemonic: 'newarray',
        consumedValues: [{ id: 'length', bits: 32 }],
        producedValues: [],
        completeness: 'partial',
        unknownEffects: [{ category: 'types', reason: `jvm-newarray-invalid-atype:${atype}` }],
      }, options);
    }
    return createVMEffectBundle({
      ...bundle,
      mnemonic: 'newarray',
      consumedValues: [{ id: 'length', bits: 32 }],
      producedValues: [arrayAllocationValue(bundle, info.descriptor, {
        arrayElementDescriptor: info.elementDescriptor,
        arrayElementByteWidth: info.byteWidth,
      })],
      possibleExceptions: [{ kind: 'negative-array-size', condition: 'length<0' }],
      completeness: 'partial',
      unknownEffects: [{ category: 'heap', reason: 'jvm-newarray-allocation-unrepresented' }],
    }, options);
  }
  if (opcode === 0xbd) {
    if (offset + 2 >= bytecode.length) return bundle;
    const cpIndex = (bytecode[offset + 1] << 8) | bytecode[offset + 2];
    const componentName = resolveJvmClassRefName(jvmClass, cpIndex);
    const descriptor = arrayDescriptorForComponent(componentName);
    if (descriptor == null) {
      return createVMEffectBundle({
        ...bundle,
        mnemonic: 'anewarray',
        consumedValues: [{ id: 'length', bits: 32 }],
        producedValues: [],
        completeness: 'partial',
        unknownEffects: [{ category: 'types', reason: 'jvm-anewarray-cp-class-invalid' }],
      }, options);
    }
    return createVMEffectBundle({
      ...bundle,
      mnemonic: 'anewarray',
      consumedValues: [{ id: 'length', bits: 32 }],
      producedValues: [arrayAllocationValue(bundle, descriptor, {
        cpClassIndex: cpIndex,
        arrayComponentType: componentName,
      })],
      possibleExceptions: [{ kind: 'negative-array-size', condition: 'length<0' }],
      completeness: 'partial',
      unknownEffects: [{ category: 'heap', reason: 'jvm-anewarray-allocation-unrepresented' }],
    }, options);
  }
  if (opcode === 0xc5) {
    if (offset + 3 >= bytecode.length) return bundle;
    const cpIndex = (bytecode[offset + 1] << 8) | bytecode[offset + 2];
    const dimensions = bytecode[offset + 3];
    const descriptor = resolveJvmClassRefName(jvmClass, cpIndex);
    const rank = arrayRank(descriptor);
    const consumedValues = Array.from({ length: dimensions }, (_, index) => ({
      id: `dimension_${dimensions - index - 1}`,
      bits: 32,
    }));
    if (dimensions === 0 || rank === 0 || dimensions > rank) {
      return createVMEffectBundle({
        ...bundle,
        mnemonic: 'multianewarray',
        consumedValues,
        producedValues: [],
        completeness: 'partial',
        unknownEffects: [{
          category: 'types',
          reason: descriptor == null
            ? 'jvm-multianewarray-cp-class-invalid'
            : 'jvm-multianewarray-dimensions-invalid',
        }],
      }, options);
    }
    return createVMEffectBundle({
      ...bundle,
      mnemonic: 'multianewarray',
      consumedValues,
      producedValues: [arrayAllocationValue(bundle, descriptor, {
        cpClassIndex: cpIndex,
        arrayDimensions: dimensions,
        arrayRank: rank,
      })],
      possibleExceptions: [{ kind: 'negative-array-size', condition: 'any-dimension<0' }],
      completeness: 'partial',
      unknownEffects: [{ category: 'heap', reason: 'jvm-multianewarray-allocation-unrepresented' }],
    }, options);
  }
  return bundle;
}

function arrayLengthBundle(bundle, options) {
  return createVMEffectBundle({
    ...bundle,
    mnemonic: 'arraylength',
    consumedValues: [{
      id: 'arrayref',
      bits: 32,
      type: JVM_MANAGED_HEAP_REFERENCE_TYPE,
      stackType: 'reference',
    }],
    producedValues: [{ id: 'length', bits: 32, valueKind: 'array-length' }],
    possibleExceptions: [{ kind: 'null-reference', condition: 'arrayref==null' }],
    completeness: 'partial',
    unknownEffects: [{ category: 'exceptions', reason: 'jvm-arraylength-exception-unrepresented' }],
  }, options);
}

export function applyJvmArraySemantics(lifted, jvmClass, method, options = {}) {
  if (lifted?.frontendId !== 'jvm' || !Array.isArray(lifted.bundles) || !method?.code?.bytecode) return lifted;
  const bytecode = method.code.bytecode;
  let changed = false;
  const bundles = lifted.bundles.map((bundle) => {
    const opcode = bundle.opcode;
    let next = bundle;
    if ((opcode >= 0x2e && opcode <= 0x35) || (opcode >= 0x4f && opcode <= 0x56)) {
      next = arrayAccessBundle(bundle, opcode, options);
    } else if (opcode === 0xbc || opcode === 0xbd || opcode === 0xc5) {
      next = arrayAllocationBundle(bundle, bytecode, jvmClass, options);
    } else if (opcode === 0xbe) {
      next = arrayLengthBundle(bundle, options);
    }
    if (next !== bundle) changed = true;
    return next;
  });
  return changed ? createVMEffectFunction({ ...lifted, bundles }, options) : lifted;
}
